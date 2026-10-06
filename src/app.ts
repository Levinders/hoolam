import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { DealError, DealService } from './deals/service.js';
import { FakeProvider } from './payments/fake.js';
import type { PaymentProvider } from './payments/provider.js';
import { pendingEvents, processEvent, storeEvent, type Handler } from './webhooks.js';
import { BUYER_ALERT, ensureBuyFlow, ensureSellFlow, ensureSellerAlertTemplate, ensureTemplate, syncAutomation } from './whatsapp/automation.js';
import { Media } from './whatsapp/media.js';
import { Trust } from './trust.js';
import { Settings } from './settings.js';
import { registerConsoleApi } from './console/api.js';
import { registerConsoleStatic } from './console/static.js';
import { StaffAuth } from './console/staff.js';
import { audit, type Actor } from './console/audit.js';
import { notFoundPage, sellerPage } from './public-page.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Messenger } from './whatsapp/client.js';
import { Conversation } from './whatsapp/flow.js';
import { parseInbound, verifyMetaSignature, type Inbound } from './whatsapp/inbound.js';

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }

export interface AppDeps { config: Config; db: Db; provider: PaymentProvider; log?: (line: string) => void }

export function buildApp({ config: c, db, provider, log = console.log }: AppDeps) {
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1_000_000, trustProxy: true });
  const messenger = new Messenger(db, {
    dryRun: c.WHATSAPP_DRY_RUN, token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, log,
  });
  const media = new Media({ dryRun: c.WHATSAPP_DRY_RUN, token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION });
  const testMode = c.ALLOW_SELF_DEAL && provider instanceof FakeProvider;
  const trust = new Trust(db, c.TRUST_COUNT_TEST_DEALS);
  const settings = new Settings(db, c);
  const deals = new DealService({
    db, provider, messenger, media, trust, settings, currency: c.CURRENCY, maxDealMinor: c.MAX_DEAL_MINOR, waNumber: c.WHATSAPP_PUBLIC_NUMBER,
    acceptHours: c.SELLER_ACCEPT_HOURS, testMode, log,
  });
  // The buyer's WhatsApp form, once it exists on Meta (see setupMeta). Until then buyers answer in the chat.
  let buyForm: { flowId: string; mode: 'draft' | 'published' } | null = null;
  let sellForm: { flowId: string; mode: 'draft' | 'published' } | null = null;
  const chat = new Conversation({
    db, deals, provider, messenger, currency: c.CURRENCY, testMode, log, trust, publicBaseUrl: c.PUBLIC_BASE_URL,
    buyForm: () => (settings.formsEnabled() ? buyForm : null), sellForm: () => (settings.formsEnabled() ? sellForm : null),
    onFormRefused: () => { buyForm = null; sellForm = null; }, // the same Meta check blocks both
  });

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

  // ---------- public seller pages ----------
  const shareImage = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'buy-banner.png'));
  app.get('/share.png', async (_req, reply) => reply.type('image/png').header('cache-control', 'public, max-age=86400').send(shareImage));
  app.get('/s/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const id = await trust.findSeller({ slug });
    const t = id ? await trust.seller(id) : null;
    if (!t) return reply.code(404).type('text/html').send(notFoundPage());
    return reply.type('text/html').header('cache-control', 'public, max-age=300')
      .send(sellerPage(t, { slug: slug.toLowerCase(), waNumber: c.WHATSAPP_PUBLIC_NUMBER, baseUrl: c.PUBLIC_BASE_URL }));
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
        `SELECT d.code, d.item, d.status, d.started_by, d.buyer_pays_minor, d.seller_gets_minor, d.currency, s.phone AS seller, b.phone AS buyer, d.updated_at
         FROM deals d LEFT JOIN users s ON s.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id
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
         ORDER BY d.id, e.id DESC`, [settings.flagHours()]);
      const templates = await db.query(`SELECT phone, body, created_at FROM outbound_messages WHERE status='NEEDS_TEMPLATE' AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 50`);
      const stuck = await db.query(`SELECT id, source, event_key, attempts, last_error FROM webhook_events WHERE processed_at IS NULL AND attempts >= 3 ORDER BY id DESC LIMIT 50`);
      const support = await db.query(`SELECT id, phone, message, created_at FROM support_requests WHERE status='OPEN' ORDER BY id LIMIT 50`);
      const unhappy = await db.query(
        `SELECT d.code, r.comment, r.created_at FROM deal_ratings r JOIN deals d ON d.id=r.deal_id WHERE NOT r.happy AND r.created_at > now() - interval '14 days' ORDER BY r.created_at DESC LIMIT 50`);
      return { deals: deals.rows, supportRequests: support.rows, unhappyBuyers: unhappy.rows, messagesNeedingTemplates: templates.rows, stuckWebhooks: stuck.rows };
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
      const photos = (await deals.photosFor(id)).map((p) => ({ ...p, url: `/admin/deals/${d.rows[0].code}/photos/${p.id}` }));
      return { deal: d.rows[0], photos, events: events.rows, payments: payments.rows, payouts: payouts.rows, ledger: ledger.rows, disputes: disputes.rows };
    });
    // The photos the buyer sent: proof of what was promised.
    admin.get('/deals/:code/photos/:id', async (req, reply) => {
      const { code, id } = req.params as { code: string; id: string };
      const r = await db.query(
        'SELECT p.mime_type, p.bytes FROM deal_photos p JOIN deals d ON d.id=p.deal_id WHERE d.code=$1 AND p.id=$2', [code.toUpperCase(), id]);
      if (!r.rows[0]?.bytes) return reply.code(404).send({ error: 'no photo' });
      return reply.type(r.rows[0].mime_type).send(r.rows[0].bytes);
    });

    const tokenActor: Actor = { staffId: null, name: 'Admin token (API)', role: 'SYSTEM' };
    admin.post('/deals/:code/release', async (req) => {
      const code = (req.params as { code: string }).code.toUpperCase();
      const note = (req.body as { note?: string })?.note ?? 'Released after review';
      await deals.adminRelease(code, note);
      await audit(db, { ...tokenActor, ip: req.ip }, { action: 'deal.release', targetType: 'deal', targetId: code, reason: note });
      return { ok: true };
    });
    admin.post('/deals/:code/refund', async (req) => {
      const code = (req.params as { code: string }).code.toUpperCase();
      const note = (req.body as { note?: string })?.note ?? 'Refunded after review';
      await deals.adminRefund(code, note);
      await audit(db, { ...tokenActor, ip: req.ip }, { action: 'deal.refund', targetType: 'deal', targetId: code, reason: note });
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
    // "Talk to a person": read the messages, answer them, close them.
    admin.get('/support', async (req) => {
      const status = (req.query as { status?: string }).status ?? 'OPEN';
      const r = await db.query('SELECT id, phone, message, status, created_at, closed_at FROM support_requests WHERE status=$1 ORDER BY id DESC LIMIT 100', [status.toUpperCase()]);
      return r.rows;
    });
    admin.post('/support/:id/close', async (req, reply) => {
      const r = await db.query(`UPDATE support_requests SET status='CLOSED', closed_at=now() WHERE id=$1 AND status='OPEN' RETURNING id`, [(req.params as { id: string }).id]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'no open request with that id' });
      return { ok: true };
    });
    // Reply to someone as Hoolam (only works within 24 hours of their last message).
    admin.post('/messages/send', async (req, reply) => {
      const { phone, text } = (req.body ?? {}) as { phone?: string; text?: string };
      if (!phone || !text) return reply.code(400).send({ error: 'phone and text required' });
      const to = phone.startsWith('+') ? phone : '+' + phone.replace(/\D/g, '');
      await messenger.send(to, { kind: 'buttons', text, buttons: [{ id: 'menu:open', title: 'Main menu' }] });
      const r = await db.query('SELECT status, error FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [to]);
      return r.rows[0] ?? { status: 'unknown' };
    });
    // Re-send the ice breakers and slash commands to Meta.
    admin.post('/whatsapp/sync-menu', async (_req, reply) => {
      if (c.WHATSAPP_DRY_RUN) return reply.code(400).send({ error: 'WhatsApp is in dry-run mode' });
      await setupMeta();
      return { ok: true, buyForm, sellForm };
    });
    admin.get('/trust/:phone', async (req, reply) => {
      const phone = '+' + (req.params as { phone: string }).phone.replace(/\D/g, '');
      const u = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
      if (!u.rows[0]) return reply.code(404).send({ error: 'unknown phone' });
      return { seller: await trust.seller(u.rows[0].id), buyer: await trust.buyer(u.rows[0].id) };
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

  const syncMenu = () => syncAutomation({ token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, log });

  /** On start (live mode): the menu extras, the seller alert template and the buyer's form. Never throws. */
  async function setupMeta(): Promise<void> {
    if (c.WHATSAPP_DRY_RUN) return;
    try {
      if (c.WHATSAPP_SYNC_MENU) await syncMenu();
      if (!c.WHATSAPP_WABA_ID) {
        log('buyer form + seller alerts need WHATSAPP_WABA_ID in Render. Buyers answer in the chat until then.');
        return;
      }
      const o = { token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, wabaId: c.WHATSAPP_WABA_ID, formMode: c.WHATSAPP_FORM_MODE, log };
      await ensureSellerAlertTemplate(o);
      await ensureTemplate(o, BUYER_ALERT, 'buyer alert');
      if (c.WHATSAPP_BUY_FORM) {
        const buyId = await ensureBuyFlow(o);
        buyForm = buyId ? { flowId: buyId, mode: c.WHATSAPP_FORM_MODE } : null;
        const sellId = await ensureSellFlow(o);
        sellForm = sellId ? { flowId: sellId, mode: c.WHATSAPP_FORM_MODE } : null;
      }
    } catch (e) {
      log(`WhatsApp setup failed: ${(e as Error).message}`);
    }
  }

  // ---------- the staff console (/console) ----------
  const staffAuth = new StaffAuth(db, { setupToken: c.ADMIN_TOKEN, baseUrl: c.PUBLIC_BASE_URL });
  registerConsoleApi(app, { config: c, db, deals, trust, settings, messenger, provider, auth: staffAuth, log });
  registerConsoleStatic(app, log);

  /** Background work: retry webhooks that failed, check slow payouts, nudge and expire. */
  async function tick(kind: 'fast' | 'slow') {
    if (kind === 'fast') {
      for (const source of ['payments', 'whatsapp']) {
        for (const id of await pendingEvents(db, source)) await processEvent(db, id, handlers[source]!, log);
      }
      await deals.pollPayouts();
    } else {
      const r = await deals.sweep({ nudgeAfterHours: settings.nudgeHours() });
      if (r.nudged || r.expired) log(`sweep: nudged ${r.nudged}, expired ${r.expired}`);
    }
  }

  return { app, deals, chat, messenger, trust, settings, staffAuth, tick, syncMenu, setupMeta, setBuyForm: (f: typeof buyForm) => { buyForm = f; }, setSellForm: (f: typeof sellForm) => { sellForm = f; } };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
