import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { DealError, DealService } from './deals/service.js';
import { FakeProvider } from './payments/fake.js';
import type { PaymentProvider } from './payments/provider.js';
import { pendingEvents, processEvent, storeEvent, type Handler } from './webhooks.js';
import { Messenger } from './whatsapp/client.js';
import { Conversation } from './whatsapp/flow.js';
import { parseInbound, verifyMetaSignature, type Inbound } from './whatsapp/inbound.js';

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }

export interface AppDeps { config: Config; db: Db; provider: PaymentProvider; log?: (line: string) => void }

export function buildApp({ config: c, db, provider, log = console.log }: AppDeps) {
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const messenger = new Messenger(db, {
    dryRun: c.WHATSAPP_DRY_RUN, token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, log,
  });
  const testMode = c.ALLOW_SELF_DEAL && provider instanceof FakeProvider;
  const deals = new DealService({ db, provider, messenger, currency: c.CURRENCY, maxDealMinor: c.MAX_DEAL_MINOR, waNumber: c.WHATSAPP_PUBLIC_NUMBER, testMode, log });
  const chat = new Conversation({ db, deals, provider, messenger, currency: c.CURRENCY, testMode, log });

  // Keep the exact bytes of every JSON body: webhook signatures are computed over them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
  });

  // ---------- handlers used by both the live webhook and the retry worker ----------
  const handlers: Record<string, Handler> = {
    whatsapp: async (m: Inbound) => { await chat.handle(m); return 'done'; },
    payments: async (ev: { kind: string; providerReference?: string; reference?: string }) => {
      if (ev.kind === 'collection' && ev.providerReference) {
        const r = await deals.handleCollection(ev.providerReference);
        return r === 'pending' ? 'retry' : 'done';
      }
      if (ev.kind === 'payout' && ev.reference) {
        const check = await provider.checkPayout(ev.reference);
        await deals.applyPayoutResult(ev.reference, check);
        return check.status === 'SUBMITTED' ? 'retry' : 'done';
      }
      return 'done';
    },
  };

  const runSoon = (source: string, id: number) => setImmediate(() => { void processEvent(db, id, handlers[source]!, log); });

  // ---------- health ----------
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, provider: provider.name, whatsapp: c.WHATSAPP_DRY_RUN ? 'dry-run' : 'live', testMode };
  });

  // ---------- WhatsApp ----------
  app.get('/webhook/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === c.WHATSAPP_VERIFY_TOKEN) return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    return reply.code(403).send('forbidden');
  });

  app.post('/webhook/whatsapp', async (req, reply) => {
    const unsignedAllowed = c.WHATSAPP_DRY_RUN && !c.WHATSAPP_APP_SECRET;
    if (!unsignedAllowed && !verifyMetaSignature(req.rawBody ?? '', header(req, 'x-hub-signature-256'), c.WHATSAPP_APP_SECRET)) {
      log('whatsapp webhook REJECTED: bad signature. Check WHATSAPP_APP_SECRET matches Meta > App settings > Basic');
      return reply.code(401).send('bad signature');
    }
    const inbound = parseInbound(req.body);
    if (!inbound.length) log('whatsapp webhook: delivery/read update (no new message)');
    for (const m of inbound) {
      log(`whatsapp in: …${m.phone.slice(-4)} ${m.type}${m.buttonId ? ' ' + m.buttonId : ''}`);
      const id = await storeEvent(db, 'whatsapp', m.id, m);
      if (id) runSoon('whatsapp', id);
    }
    return reply.code(200).send('ok'); // answer fast; work happens after
  });

  // ---------- payment provider ----------
  app.post('/webhook/payments', async (req, reply) => {
    const ev = provider.parseWebhook(req.rawBody ?? '', req.headers);
    if (!ev) return reply.code(401).send('rejected');
    const id = await storeEvent(db, 'payments', ev.eventKey, ev);
    if (id) runSoon('payments', id);
    return reply.code(200).send('ok');
  });

  // ---------- local testing only: pretend the buyer paid ----------
  if (provider instanceof FakeProvider) {
    app.post('/dev/pay/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const r = await db.query(
        `SELECT pi.provider_reference FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id WHERE d.code=$1 ORDER BY pi.created_at DESC LIMIT 1`, [code.toUpperCase()]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'No payment requested for this deal yet' });
      const amount = (req.body as { amountMinor?: number } | undefined)?.amountMinor;
      provider.pay(r.rows[0].provider_reference, amount);
      const ev = provider.parseWebhook(provider.webhookFor(r.rows[0].provider_reference))!;
      const id = await storeEvent(db, 'payments', ev.eventKey + ':' + Date.now(), ev);
      if (id) await processEvent(db, id, handlers.payments!, log);
      return { ok: true };
    });
  }

  // ---------- admin (Bearer ADMIN_TOKEN) ----------
  app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      const got = Buffer.from(header(req, 'authorization') ?? '');
      const want = Buffer.from(`Bearer ${c.ADMIN_TOKEN}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
    });

    admin.get('/deals', async (req) => {
      const status = (req.query as { status?: string }).status;
      const r = await db.query(
        `SELECT d.code, d.item, d.status, d.buyer_pays_minor, d.seller_gets_minor, d.currency, s.phone AS seller, b.phone AS buyer, d.updated_at
         FROM deals d JOIN users s ON s.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id
         ${status ? 'WHERE d.status=$1' : ''} ORDER BY d.updated_at DESC LIMIT 100`, status ? [status] : []);
      return r.rows;
    });

    // Everything a person needs to look at today.
    admin.get('/attention', async () => {
      const deals = await db.query(
        `SELECT DISTINCT ON (d.id) d.code, d.status, d.updated_at, e.note
         FROM deals d LEFT JOIN deal_events e ON e.deal_id=d.id AND e.note LIKE 'NEEDS_ATTENTION%'
         WHERE d.status IN ('DISPUTED','PAYOUT_PENDING')
            OR (d.status='SHIPPED' AND d.shipped_at < now() - make_interval(hours => $1))
            OR e.id IS NOT NULL
         ORDER BY d.id, e.id DESC`, [c.FLAG_AFTER_HOURS]);
      const templates = await db.query(`SELECT phone, body, created_at FROM outbound_messages WHERE status='NEEDS_TEMPLATE' AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 50`);
      const stuck = await db.query(`SELECT id, source, event_key, attempts, last_error FROM webhook_events WHERE processed_at IS NULL AND attempts >= 3 ORDER BY id DESC LIMIT 50`);
      return { deals: deals.rows, messagesNeedingTemplates: templates.rows, stuckWebhooks: stuck.rows };
    });

    admin.get('/deals/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const d = await db.query('SELECT * FROM deals WHERE code=$1', [code.toUpperCase()]);
      if (!d.rows[0]) return reply.code(404).send({ error: 'not found' });
      const id = d.rows[0].id;
      const [events, payments, payouts, ledger, disputes] = await Promise.all([
        db.query('SELECT * FROM deal_events WHERE deal_id=$1 ORDER BY id', [id]),
        db.query('SELECT * FROM payment_intents WHERE deal_id=$1 ORDER BY created_at', [id]),
        db.query('SELECT * FROM payouts WHERE deal_id=$1 ORDER BY created_at', [id]),
        db.query('SELECT account, amount_minor, memo, created_at FROM ledger_entries WHERE deal_id=$1 ORDER BY id', [id]),
        db.query('SELECT * FROM disputes WHERE deal_id=$1 ORDER BY created_at', [id]),
      ]);
      return { deal: d.rows[0], events: events.rows, payments: payments.rows, payouts: payouts.rows, ledger: ledger.rows, disputes: disputes.rows };
    });

    admin.post('/deals/:code/release', async (req) => {
      await deals.adminRelease((req.params as { code: string }).code, (req.body as { note?: string })?.note ?? 'Released after review');
      return { ok: true };
    });
    admin.post('/deals/:code/refund', async (req) => {
      await deals.adminRefund((req.params as { code: string }).code, (req.body as { note?: string })?.note ?? 'Refunded after review');
      return { ok: true };
    });
    admin.post('/payouts/:reference/authorize', async (req, reply) => {
      const otp = (req.body as { otp?: string })?.otp;
      if (!otp) return reply.code(400).send({ error: 'otp required' });
      return deals.authorizePayout((req.params as { reference: string }).reference, otp);
    });
    admin.post('/payouts/:reference/retry', async (req) => {
      await deals.retryPayout((req.params as { reference: string }).reference);
      return { ok: true };
    });
    admin.get('/messages', async (req) => {
      const status = (req.query as { status?: string }).status;
      const r = await db.query(
        `SELECT id, phone, kind, status, error, body->>'text' AS text, created_at FROM outbound_messages
         ${status ? 'WHERE status=$1' : ''} ORDER BY id DESC LIMIT 50`, status ? [status] : []);
      return r.rows;
    });
    admin.get('/ledger/balances', async () => {
      const r = await db.query('SELECT account, currency, SUM(amount_minor)::bigint AS balance_minor FROM ledger_entries GROUP BY account, currency ORDER BY account');
      return r.rows;
    });
  }, { prefix: '/admin' });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DealError) return reply.code(409).send({ error: err.reason, message: err.message });
    const e = err as Error & { statusCode?: number };
    log(`error: ${e.stack ?? e.message}`);
    const code = e.statusCode ?? 500;
    return reply.code(code).send({ error: code < 500 ? e.message : 'internal error' });
  });

  /** Background work: retry webhooks that failed, check slow payouts, nudge and expire. */
  async function tick(kind: 'fast' | 'slow') {
    if (kind === 'fast') {
      for (const source of ['payments', 'whatsapp']) {
        for (const id of await pendingEvents(db, source)) await processEvent(db, id, handlers[source]!, log);
      }
      await deals.pollPayouts();
    } else {
      const r = await deals.sweep({ nudgeAfterHours: c.NUDGE_AFTER_HOURS });
      if (r.nudged || r.expired) log(`sweep: nudged ${r.nudged}, expired ${r.expired}`);
    }
  }

  return { app, deals, chat, messenger, tick };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
