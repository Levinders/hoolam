import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { DealError, type DealService } from '../deals/service.js';
import type { PaymentProvider } from '../payments/provider.js';
import { SETTING_DEFS, type Settings } from '../settings.js';
import { parseSocial, SOCIAL_KINDS, type SocialKind } from '../socials.js';
import { MAX_UPLOAD_BYTES, MediaError, SLOTS, type SiteMedia } from '../site-media.js';
import type { SiteSync } from '../site-sync.js';
import type { Trust } from '../trust.js';
import type { Messenger } from '../whatsapp/client.js';
import { msg, STATUS_WORDS } from '../whatsapp/messages.js';
import { ALL_TEMPLATES } from '../whatsapp/automation.js';
import { audit, type Actor } from './audit.js';
import { AuthError, can, permissionsFor, ROLES, type Role, type StaffAuth, type StaffMember } from './staff.js';

/**
 * The console's API, under /console/api. Every route needs a signed-in staff member, except the sign-in steps.
 * Every action that changes something is checked against the person's role and written to the audit trail
 * with who, when, why and what changed.
 */
export interface ConsoleDeps {
  config: Config; db: Db; deals: DealService; trust: Trust; settings: Settings; messenger: Messenger;
  provider: PaymentProvider; auth: StaffAuth; siteMedia: SiteMedia; siteSync: SiteSync; log: (l: string) => void;
  refreshTemplates?: () => Promise<void>;
}

declare module 'fastify' { interface FastifyRequest { staff?: StaffMember & { sessionId: string } } }

const COOKIE = 'hoolam_console';
const PAGE = 25;

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function registerConsoleApi(app: FastifyInstance, d: ConsoleDeps) {
  const { db } = d;
  const secure = d.config.PUBLIC_BASE_URL.startsWith('https://');
  const unit = d.config.CURRENCY === 'NGN' ? 100 : 1;

  const cookieOf = (req: FastifyRequest) => {
    const raw = req.headers.cookie ?? '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return undefined;
  };
  const setCookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/console; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  const meta = (req: FastifyRequest) => ({ ip: req.ip ?? null, ua: (req.headers['user-agent'] as string) ?? null });
  const actorOf = (req: FastifyRequest): Actor => ({ staffId: req.staff!.id, name: req.staff!.name, role: req.staff!.role, ip: req.ip ?? null });
  const need = (req: FastifyRequest, action: string) => {
    if (!can(req.staff!.role, action)) throw new HttpError(403, `Your role (${roleName(req.staff!.role)}) can't do this. Ask an owner.`);
  };
  const reasonOf = (body: unknown, min = 4): string => {
    const r = String((body as { reason?: string })?.reason ?? '').trim();
    if (r.length < min) throw new HttpError(400, 'Please add a short reason. It goes in the audit trail.');
    return r.slice(0, 500);
  };
  const pageOf = (q: Record<string, string>) => Math.max(1, Number(q.page) || 1);

  /** Runs an action and records it, success or failure, in the audit trail. */
  async function act<T>(req: FastifyRequest, e: { action: string; targetType: string; targetId: string; reason?: string | null; details?: Record<string, unknown> }, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      await audit(db, actorOf(req), { ...e, details: { ...(e.details ?? {}), ok: true } });
      return result;
    } catch (err) {
      await audit(db, actorOf(req), { ...e, details: { ...(e.details ?? {}), ok: false, error: (err as Error).message } });
      throw err;
    }
  }

  app.register(async (api) => {
    // ---- every request: CSRF guard on changes, and a signed-in staff member except for the sign-in steps ----
    api.addHook('preHandler', async (req) => {
      if (req.method !== 'GET' && req.headers['x-hoolam-console'] !== '1') throw new HttpError(403, 'Missing console header');
      const open = req.url.startsWith('/console/api/auth/');
      req.staff = (await d.auth.fromSession(cookieOf(req))) ?? undefined;
      if (!open && !req.staff) throw new HttpError(401, 'Please sign in.');
    });

    api.setErrorHandler((err, _req, reply) => {
      const e = err as Error & { statusCode?: number; status?: number };
      if (err instanceof HttpError || err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      if (err instanceof DealError) return reply.code(409).send({ error: err.message && err.message !== err.reason ? err.message : dealErrorText(err.reason) });
      d.log(`console error: ${e.stack ?? e.message}`);
      return reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: e.statusCode && e.statusCode < 500 ? e.message : 'Something went wrong on our side. Please try again.' });
    });

    // =====================================================================================
    // Sign-in
    // =====================================================================================
    // the logo for every screen, including the sign-in page
    api.get('/auth/brand', async () => ({ logo: d.siteMedia.url('', 'logo'), mark: d.siteMedia.url('', 'mark') }));
    api.get('/auth/state', async (req) => ({
      setupNeeded: !(await d.auth.hasOwner()),
      me: req.staff ? meOf(req.staff) : null,
    }));
    api.post('/auth/setup', async (req) => {
      const b = req.body as { setupToken: string; name: string; email: string; password: string };
      const r = await d.auth.setupOwner(b, req.ip ?? null);
      return { ticket: r.ticket, secret: r.secret, qr: r.qr };
    });
    api.post('/auth/login', async (req) => {
      const b = req.body as { email: string; password: string };
      return d.auth.login(b.email, b.password, req.ip ?? null);
    });
    api.post('/auth/code', async (req, reply) => {
      const b = req.body as { ticket: string; code: string };
      const s = await d.auth.loginCode(b.ticket, b.code, meta(req));
      setCookie(reply, s.token, s.maxAgeSeconds);
      return { ok: true };
    });
    api.post('/auth/enroll', async (req, reply) => {
      const b = req.body as { ticket: string; code: string };
      const s = await d.auth.enroll(b.ticket, b.code, meta(req));
      setCookie(reply, s.token, s.maxAgeSeconds);
      return { ok: true };
    });
    api.get('/auth/invite/:token', async (req) => {
      const i = await d.auth.inviteInfo((req.params as { token: string }).token);
      return { email: i.email, name: i.name, role: i.role };
    });
    api.post('/auth/invite/:token', async (req) => {
      const r = await d.auth.acceptInvite((req.params as { token: string }).token, (req.body as { password: string }).password, req.ip ?? null);
      return { ticket: r.ticket, secret: r.secret, qr: r.qr };
    });
    api.post('/auth/logout', async (req, reply) => {
      if (req.staff) await d.auth.logout(cookieOf(req), actorOf(req));
      setCookie(reply, '', 0);
      return { ok: true };
    });

    // =====================================================================================
    // Overview: Needs action + sidebar counts
    // =====================================================================================
    api.get('/inbox', async () => {
      const flag = d.settings.flagHours();
      const [disputes, payouts, notes, support, unhappy, overdue, expiring, templates, stuck, dismissed] = await Promise.all([
        db.query(`SELECT x.id, x.reason, x.created_at, d.code, d.item, d.buyer_pays_minor, d.currency FROM disputes x JOIN deals d ON d.id=x.deal_id WHERE x.status='OPEN' ORDER BY x.created_at`),
        db.query(`SELECT p.reference, p.kind, p.status, p.amount_minor, p.currency, p.provider_message, p.updated_at, d.code FROM payouts p JOIN deals d ON d.id=p.deal_id WHERE p.status IN ('NEEDS_AUTHORIZATION','FAILED','REVERSED') ORDER BY p.updated_at`),
        db.query(`SELECT e.id, e.note, e.created_at, d.code, d.currency FROM deal_events e JOIN deals d ON d.id=e.deal_id WHERE e.note LIKE 'NEEDS_ATTENTION%' AND e.note NOT LIKE 'NEEDS_ATTENTION: payout %' AND e.created_at > now() - interval '30 days' ORDER BY e.created_at DESC LIMIT 50`),
        db.query(`SELECT s.id, s.message, s.created_at, s.phone, u.display_name FROM support_requests s LEFT JOIN users u ON u.id=s.user_id WHERE s.status='OPEN' ORDER BY s.created_at`),
        db.query(`SELECT r.deal_id, r.comment, r.created_at, d.code, u.display_name AS seller FROM deal_ratings r JOIN deals d ON d.id=r.deal_id LEFT JOIN users u ON u.id=r.seller_id WHERE NOT r.happy AND r.created_at > now() - interval '14 days' ORDER BY r.created_at DESC`),
        db.query(`SELECT code, item, shipped_at FROM deals WHERE status='SHIPPED' AND shipped_at < now() - make_interval(hours => $1) ORDER BY shipped_at`, [flag]),
        db.query(`SELECT code, item, accept_by FROM deals WHERE status='AWAITING_SELLER' AND accept_by BETWEEN now() AND now() + interval '6 hours' ORDER BY accept_by`),
        db.query(`SELECT id, phone, body->>'text' AS text, created_at FROM outbound_messages WHERE status='NEEDS_TEMPLATE' AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 20`),
        db.query(`SELECT id, source, event_key, attempts, last_error, received_at FROM webhook_events WHERE processed_at IS NULL AND attempts >= 3 ORDER BY id DESC LIMIT 20`),
        db.query(`SELECT item_key FROM inbox_dismissals`),
      ]);
      const gone = new Set(dismissed.rows.map((r) => r.item_key));
      const money = (m: number, c: string) => msg.moneyText({ minor: Number(m), currency: c as 'NGN' });
      type Item = { key: string; kind: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string; at: string; link: string; cta: string; dismissible?: boolean };
      const items: Item[] = [];
      for (const r of disputes.rows) items.push({ key: `dispute:${r.id}`, kind: 'dispute', severity: 'high', title: `Problem reported on ${r.code}`, detail: `${r.item} · ${money(r.buyer_pays_minor, r.currency)} frozen · “${(r.reason ?? 'No details yet').slice(0, 90)}”`, at: r.created_at, link: `/deals/${r.code}`, cta: 'Review' });
      for (const r of payouts.rows) items.push({
        key: `payout:${r.reference}:${r.status}`, kind: 'payout', severity: r.status === 'NEEDS_AUTHORIZATION' ? 'high' : 'medium',
        title: r.status === 'NEEDS_AUTHORIZATION' ? `${r.kind === 'REFUND' ? 'Refund' : 'Payout'} waiting for OTP` : `${r.kind === 'REFUND' ? 'Refund' : 'Payout'} ${r.status === 'FAILED' ? 'failed' : 'reversed'}`,
        detail: `${r.code} · ${money(r.amount_minor, r.currency)}${r.provider_message ? ' · ' + r.provider_message : ''}`, at: r.updated_at, link: `/money?payout=${encodeURIComponent(r.reference)}`, cta: r.status === 'NEEDS_AUTHORIZATION' ? 'Approve' : 'Retry',
      });
      for (const r of notes.rows) items.push({ key: `event:${r.id}`, kind: 'payment', severity: 'high', title: `Money needs attention on ${r.code}`, detail: String(r.note).replace(/^NEEDS_ATTENTION:\s*/, '').replace(/\b(payment|by|of) (\d+)\b/g, (_m: string, w: string, n: string) => `${w} ${money(Number(n), r.currency)}`).replace(/^./, (c: string) => c.toUpperCase()), at: r.created_at, link: `/deals/${r.code}`, cta: 'Open deal', dismissible: true });
      for (const r of support.rows) items.push({ key: `support:${r.id}`, kind: 'support', severity: 'medium', title: `${r.display_name ?? r.phone} wants to talk`, detail: String(r.message).slice(0, 110), at: r.created_at, link: `/support?open=${r.id}`, cta: 'Reply' });
      for (const r of overdue.rows) items.push({ key: `overdue:${r.code}`, kind: 'overdue', severity: 'medium', title: `${r.code} shipped, not confirmed`, detail: `${r.item} · shipped ${ago(r.shipped_at)}`, at: r.shipped_at, link: `/deals/${r.code}`, cta: 'Check in', dismissible: true });
      for (const r of unhappy.rows) items.push({ key: `rating:${r.deal_id}`, kind: 'rating', severity: 'low', title: `👎 on ${r.code}${r.seller ? ' (' + r.seller.split(' ')[0] + ')' : ''}`, detail: r.comment ? `“${String(r.comment).slice(0, 110)}”` : 'No comment', at: r.created_at, link: `/deals/${r.code}`, cta: 'Look', dismissible: true });
      for (const r of expiring.rows) items.push({ key: `expiring:${r.code}`, kind: 'expiring', severity: 'low', title: `${r.code} closes soon`, detail: `${r.item} · seller hasn't accepted · closes ${until(r.accept_by)}`, at: r.accept_by, link: `/deals/${r.code}`, cta: 'Extend', dismissible: true });
      for (const r of templates.rows) items.push({ key: `template:${r.id}`, kind: 'template', severity: 'low', title: `Message not delivered (24-hour rule)`, detail: `To …${String(r.phone).slice(-4)}: ${String(r.text ?? '').slice(0, 90)}`, at: r.created_at, link: `/support?tab=messages`, cta: 'See', dismissible: true });
      for (const r of stuck.rows) items.push({ key: `webhook:${r.id}`, kind: 'system', severity: 'medium', title: `A ${r.source} update keeps failing`, detail: `${r.attempts} tries · ${String(r.last_error ?? '').slice(0, 100)}`, at: r.received_at, link: `/audit`, cta: 'Details', dismissible: true });
      const order = { high: 0, medium: 1, low: 2 };
      const open = items.filter((i) => !gone.has(i.key)).sort((a, b) => order[a.severity] - order[b.severity] || +new Date(a.at) - +new Date(b.at));
      return { items: open, counts: { inbox: open.length, disputes: disputes.rowCount, support: support.rowCount } };
    });

    api.post('/inbox/dismiss', async (req) => {
      const { key } = req.body as { key: string };
      const reason = String((req.body as { reason?: string }).reason ?? '').trim().slice(0, 300) || null;
      if (!/^(event|overdue|rating|expiring|template|webhook):/.test(key ?? '')) throw new HttpError(400, 'This item is resolved by acting on it, not by dismissing.');
      await act(req, { action: 'inbox.handled', targetType: 'inbox', targetId: key, reason }, () =>
        db.query('INSERT INTO inbox_dismissals (item_key, staff_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [key, req.staff!.id, reason]));
      return { ok: true };
    });

    api.get('/search', async (req) => {
      const q = String((req.query as { q?: string }).q ?? '').trim();
      if (q.length < 2) return { deals: [], people: [] };
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const digits = q.replace(/\D/g, '');
      const [deals, people] = await Promise.all([
        db.query(`SELECT code, item, status, buyer_pays_minor, currency FROM deals WHERE code ILIKE $1 OR item ILIKE $1 ORDER BY updated_at DESC LIMIT 6`, [like]),
        db.query(`SELECT id, phone, display_name, business_name FROM users WHERE display_name ILIKE $1 OR business_name ILIKE $1 ${digits.length >= 4 ? `OR phone LIKE '%' || $2 || '%'` : ''} ORDER BY created_at DESC LIMIT 6`, digits.length >= 4 ? [like, digits] : [like]),
      ]);
      return { deals: deals.rows, people: people.rows };
    });

    // =====================================================================================
    // Deals
    // =====================================================================================
    api.get('/deals', async (req) => {
      const q = req.query as Record<string, string>;
      const where: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
      if (q.status) add(`d.status = ANY(?)`, q.status.split(','));
      if (q.started_by) add(`d.started_by = ?`, q.started_by.toUpperCase());
      if (q.q) {
        const like = `%${q.q.trim().replace(/[%_]/g, '')}%`;
        args.push(like);
        where.push(`(d.code ILIKE $${args.length} OR d.item ILIKE $${args.length} OR s.phone ILIKE $${args.length} OR b.phone ILIKE $${args.length} OR s.display_name ILIKE $${args.length} OR b.display_name ILIKE $${args.length})`);
      }
      if (q.test === 'hide') where.push('NOT d.is_test');
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const page = pageOf(q);
      const [rows, total] = await Promise.all([
        db.query(
          `SELECT d.code, d.item, d.status, d.started_by, d.fee_payer, d.price_minor, d.fee_minor, d.buyer_pays_minor, d.seller_gets_minor, d.currency, d.is_test,
                  d.created_at, d.updated_at, s.display_name AS seller_name, s.phone AS seller_phone, b.display_name AS buyer_name, b.phone AS buyer_phone,
                  EXISTS (SELECT 1 FROM disputes x WHERE x.deal_id=d.id AND x.status='OPEN') AS open_dispute
           FROM deals d LEFT JOIN users s ON s.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id ${w}
           ORDER BY d.updated_at DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, args),
        db.query(`SELECT count(*)::int AS n FROM deals d LEFT JOIN users s ON s.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id ${w}`, args),
      ]);
      const counts = await db.query(`SELECT status, count(*)::int AS n FROM deals GROUP BY status`);
      return { rows: rows.rows, total: total.rows[0].n, page, pageSize: PAGE, statusCounts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) };
    });

    api.get('/deals/:code', async (req) => {
      const code = (req.params as { code: string }).code.toUpperCase();
      const dr = await db.query('SELECT * FROM deals WHERE code=$1', [code]);
      const deal = dr.rows[0];
      if (!deal) throw new HttpError(404, `No deal ${code}`);
      const userQ = (id: string | null) => id ? db.query('SELECT id, phone, display_name, business_name, blocked FROM users WHERE id=$1', [id]).then((r) => r.rows[0] ?? null) : Promise.resolve(null);
      const [buyer, seller, counterSeller, events, payments, payouts, ledger, disputes, photos, notes, rating, trail, sellerAcct] = await Promise.all([
        userQ(deal.buyer_id), userQ(deal.seller_id), userQ(deal.counter_seller_id),
        db.query('SELECT id, from_status, to_status, actor, note, created_at FROM deal_events WHERE deal_id=$1 ORDER BY id', [deal.id]),
        db.query('SELECT payment_reference, provider_reference, amount_minor, amount_paid_minor, status, bank_name, account_number, expires_at, created_at FROM payment_intents WHERE deal_id=$1 ORDER BY created_at', [deal.id]),
        db.query(`SELECT p.reference, p.kind, p.status, p.amount_minor, p.provider_message, p.created_at, p.updated_at, b.bank_name, right(b.account_number, 4) AS last4, b.account_name
                  FROM payouts p JOIN bank_accounts b ON b.id=p.bank_account_id WHERE p.deal_id=$1 ORDER BY p.created_at`, [deal.id]),
        db.query('SELECT account, amount_minor, memo, created_at FROM ledger_entries WHERE deal_id=$1 ORDER BY id', [deal.id]),
        db.query('SELECT id, reason, status, resolution_note, created_at, resolved_at FROM disputes WHERE deal_id=$1 ORDER BY created_at', [deal.id]),
        db.query('SELECT id, kind, mime_type, created_at FROM deal_photos WHERE deal_id=$1 ORDER BY id', [deal.id]),
        db.query('SELECT n.id, n.note, n.created_at, s.name AS by FROM deal_notes n LEFT JOIN staff s ON s.id=n.staff_id WHERE n.deal_id=$1 ORDER BY n.id', [deal.id]),
        db.query('SELECT happy, comment, created_at FROM deal_ratings WHERE deal_id=$1', [deal.id]),
        db.query(`SELECT at, actor, action, reason, details FROM audit_log WHERE target_type='deal' AND target_id=$1 ORDER BY id`, [code]),
        deal.seller_account_id ? db.query('SELECT bank_name, right(account_number, 4) AS last4, account_name FROM bank_accounts WHERE id=$1', [deal.seller_account_id]) : Promise.resolve({ rows: [] }),
      ]);
      const phones = [buyer?.phone, seller?.phone, counterSeller?.phone, deal.invited_phone].filter(Boolean);
      const messages = phones.length
        ? await db.query(`SELECT id, phone, kind, status, body, created_at FROM outbound_messages WHERE phone = ANY($1) AND body::text LIKE '%' || $2 || '%' ORDER BY id LIMIT 120`, [phones, code])
        : { rows: [] };
      return {
        deal: { ...deal, status_words: STATUS_WORDS[deal.status] ?? deal.status },
        buyer, seller, counterSeller, sellerAccount: sellerAcct.rows[0] ?? null,
        events: events.rows, payments: payments.rows, payouts: payouts.rows, ledger: ledger.rows, disputes: disputes.rows,
        photos: photos.rows.map((p) => ({ ...p, url: `/console/api/deals/${code}/photos/${p.id}` })),
        notes: notes.rows, rating: rating.rows[0] ?? null, trail: trail.rows,
        messages: messages.rows.map((m) => ({ id: m.id, phone: m.phone, kind: m.kind, status: m.status, at: m.created_at, text: m.body?.text ?? (m.kind === 'image' ? '[photo]' : ''), buttons: (m.body?.buttons ?? []).map((b: { title: string }) => b.title) })),
        sellerTrust: deal.seller_id ? await d.trust.seller(deal.seller_id) : null,
        buyerTrust: deal.buyer_id ? await d.trust.buyer(deal.buyer_id) : null,
        allowed: {
          release: ['FUNDED', 'SHIPPED', 'DISPUTED'].includes(deal.status),
          refund: ['FUNDED', 'DISPUTED'].includes(deal.status),
          cancel: ['AWAITING_SELLER', 'AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(deal.status),
          extend: deal.status === 'AWAITING_SELLER',
          messageBuyer: !!deal.buyer_id,
          messageSeller: !!(deal.seller_id ?? deal.counter_seller_id),
        },
      };
    });

    api.get('/deals/:code/photos/:id', async (req, reply) => {
      const { code, id } = req.params as { code: string; id: string };
      const r = await db.query('SELECT p.mime_type, p.bytes FROM deal_photos p JOIN deals d ON d.id=p.deal_id WHERE d.code=$1 AND p.id=$2', [code.toUpperCase(), id]);
      if (!r.rows[0]?.bytes) return reply.code(404).send({ error: 'No photo stored (test deals have none)' });
      return reply.type(r.rows[0].mime_type).header('cache-control', 'private, max-age=3600').send(r.rows[0].bytes);
    });

    const dealAction = (path: string, action: string, run: (code: string, body: Record<string, unknown>, by: string, reason: string) => Promise<unknown>, needsReason = true) =>
      api.post(`/deals/:code/${path}`, async (req) => {
        need(req, action);
        const code = (req.params as { code: string }).code.toUpperCase();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const reason = needsReason ? reasonOf(body) : String(body.reason ?? '').trim() || null;
        const before = (await db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0]?.status;
        const result = await act(req, { action, targetType: 'deal', targetId: code, reason, details: { from: before, ...pick(body, ['hours', 'to']) } },
          () => run(code, body, req.staff!.name, reason ?? ''));
        const after = (await db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0]?.status;
        return { ok: true, status: after, result };
      });

    dealAction('release', 'deal.release', (code, _b, by, reason) => d.deals.adminRelease(code, `${reason} (by ${by})`));
    dealAction('refund', 'deal.refund', (code, _b, by, reason) => d.deals.adminRefund(code, `${reason} (by ${by})`));
    dealAction('cancel', 'deal.cancel', (code, _b, by, reason) => d.deals.adminCancel(code, `${reason} (by ${by})`));
    dealAction('extend', 'deal.extend', async (code, b) => {
      const hours = Number(b.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, 'Extend by 1 to 168 hours.');
      return { acceptBy: await d.deals.extendAcceptTime(code, hours) };
    });
    dealAction('message', 'deal.message', async (code, b) => {
      const text = String(b.text ?? '').trim();
      if (text.length < 2) throw new HttpError(400, 'Write a message first.');
      if (b.to !== 'buyer' && b.to !== 'seller') throw new HttpError(400, 'Choose buyer or seller.');
      const status = await d.deals.messageParty(code, b.to, text.slice(0, 900));
      if (status === 'NEEDS_TEMPLATE') throw new HttpError(409, 'Not delivered: they haven\'t messaged Hoolam in the last 24 hours (WhatsApp rule). Ask them to message Hoolam first.');
      if (status === 'FAILED') throw new HttpError(502, 'WhatsApp refused the message. Check the logs.');
      return { delivery: status, text: text.slice(0, 900) };
    }, false);
    api.post('/deals/:code/notes', async (req) => {
      need(req, 'deal.note');
      const code = (req.params as { code: string }).code.toUpperCase();
      const note = String((req.body as { note?: string }).note ?? '').trim();
      if (note.length < 2) throw new HttpError(400, 'Write a note first.');
      const deal = (await db.query('SELECT id FROM deals WHERE code=$1', [code])).rows[0];
      if (!deal) throw new HttpError(404, 'No such deal');
      await act(req, { action: 'deal.note', targetType: 'deal', targetId: code, details: { note: note.slice(0, 200) } },
        () => db.query('INSERT INTO deal_notes (deal_id, staff_id, note) VALUES ($1,$2,$3)', [deal.id, req.staff!.id, note.slice(0, 2000)]));
      return { ok: true };
    });

    // =====================================================================================
    // Disputes
    // =====================================================================================
    api.get('/disputes', async (req) => {
      const state = (req.query as { state?: string }).state === 'resolved' ? 'resolved' : 'open';
      const r = await db.query(
        `SELECT x.id, x.reason, x.status, x.resolution_note, x.created_at, x.resolved_at, d.code, d.item, d.buyer_pays_minor, d.seller_gets_minor, d.currency, d.status AS deal_status,
                b.display_name AS buyer_name, s.display_name AS seller_name,
                (SELECT count(*)::int FROM deal_photos p WHERE p.deal_id=d.id) AS photos
         FROM disputes x JOIN deals d ON d.id=x.deal_id LEFT JOIN users b ON b.id=d.buyer_id LEFT JOIN users s ON s.id=d.seller_id
         WHERE ${state === 'open' ? `x.status='OPEN'` : `x.status<>'OPEN'`} ORDER BY ${state === 'open' ? 'x.created_at' : 'x.resolved_at DESC'} LIMIT 100`);
      return { rows: r.rows };
    });

    // =====================================================================================
    // Money
    // =====================================================================================
    api.get('/money', async () => {
      const [bal, fees30, payoutCounts, todayPaid] = await Promise.all([
        db.query(`SELECT account, SUM(amount_minor)::bigint AS b FROM ledger_entries GROUP BY account`),
        db.query(`SELECT COALESCE(-SUM(amount_minor),0)::bigint AS fees FROM ledger_entries WHERE account='revenue:fees' AND created_at > now() - interval '30 days'`),
        db.query(`SELECT status, count(*)::int AS n, COALESCE(SUM(amount_minor),0)::bigint AS total FROM payouts GROUP BY status`),
        db.query(`SELECT COALESCE(SUM(amount_minor),0)::bigint AS total FROM payouts WHERE status='SUCCESS' AND updated_at > now() - interval '1 day'`),
      ]);
      const b: Record<string, number> = Object.fromEntries(bal.rows.map((r) => [r.account, Number(r.b)]));
      const cash = Object.entries(b).filter(([k]) => k.startsWith('cash:')).reduce((s, [, v]) => s + v, 0);
      return {
        currency: d.config.CURRENCY,
        held: -(b['held:deal'] ?? 0),
        owedSellers: -(b['payable:seller'] ?? 0),
        owedBuyers: -(b['payable:buyer'] ?? 0),
        feesTotal: -(b['revenue:fees'] ?? 0),
        fees30: Number(fees30.rows[0].fees),
        cash, paidOut24h: Number(todayPaid.rows[0].total),
        balances: Object.entries(b).map(([account, balance]) => ({ account, balance })),
        payouts: Object.fromEntries(payoutCounts.rows.map((r) => [r.status, { count: r.n, total: Number(r.total) }])),
        reconciled: Object.values(b).reduce((s, v) => s + v, 0) === 0,
      };
    });

    api.get('/payouts', async (req) => {
      const q = req.query as Record<string, string>;
      const page = pageOf(q);
      const where = q.status ? `WHERE p.status = ANY($1)` : '';
      const args = q.status ? [q.status.split(',')] : [];
      const [rows, total] = await Promise.all([
        db.query(`SELECT p.reference, p.kind, p.status, p.amount_minor, p.currency, p.provider_message, p.created_at, p.updated_at, d.code,
                         b.bank_name, right(b.account_number, 4) AS last4, b.account_name
                  FROM payouts p JOIN deals d ON d.id=p.deal_id JOIN bank_accounts b ON b.id=p.bank_account_id ${where}
                  ORDER BY p.updated_at DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, args),
        db.query(`SELECT count(*)::int AS n FROM payouts p ${where}`, args),
      ]);
      return { rows: rows.rows, total: total.rows[0].n, page, pageSize: PAGE };
    });

    api.post('/payouts/:reference/authorize', async (req) => {
      need(req, 'payout.authorize');
      const ref = (req.params as { reference: string }).reference;
      const otp = String((req.body as { otp?: string }).otp ?? '').trim();
      if (!/^\d{4,8}$/.test(otp)) throw new HttpError(400, 'Enter the OTP Monnify sent to your email.');
      const r = await act(req, { action: 'payout.authorize', targetType: 'payout', targetId: ref }, () => d.deals.authorizePayout(ref, otp));
      return { ok: true, result: r };
    });
    api.post('/payouts/:reference/retry', async (req) => {
      need(req, 'payout.retry');
      const ref = (req.params as { reference: string }).reference;
      const reason = reasonOf(req.body);
      await act(req, { action: 'payout.retry', targetType: 'payout', targetId: ref, reason }, () => d.deals.retryPayout(ref));
      const p = (await db.query('SELECT status FROM payouts WHERE reference=$1', [ref])).rows[0];
      return { ok: true, status: p?.status };
    });

    api.get('/money/export.csv', async (req, reply) => {
      need(req, 'money.export');
      const q = req.query as Record<string, string>;
      const from = q.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const to = q.to || new Date().toISOString().slice(0, 10);
      const r = await db.query(
        `SELECT d.code, d.created_at, d.status, d.started_by, d.fee_payer, d.item, d.price_minor, d.fee_minor, d.buyer_pays_minor, d.seller_gets_minor, d.currency, d.is_test,
                s.phone AS seller_phone, b.phone AS buyer_phone, d.funded_at, d.shipped_at, d.closed_at
         FROM deals d LEFT JOIN users s ON s.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id
         WHERE d.created_at >= $1::date AND d.created_at < $2::date + 1 ORDER BY d.created_at`, [from, to]);
      await audit(db, actorOf(req), { action: 'money.export', targetType: 'money', details: { from, to, rows: r.rowCount } });
      const cols = ['code', 'created_at', 'status', 'started_by', 'fee_payer', 'item', 'price', 'fee', 'buyer_pays', 'seller_gets', 'currency', 'is_test', 'seller_phone', 'buyer_phone', 'funded_at', 'shipped_at', 'closed_at'];
      const val = (row: Record<string, unknown>, c: string) => {
        const map: Record<string, string> = { price: 'price_minor', fee: 'fee_minor', buyer_pays: 'buyer_pays_minor', seller_gets: 'seller_gets_minor' };
        const v = map[c] ? Number(row[map[c]!]) / unit : row[c];
        const s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [cols.join(','), ...r.rows.map((row) => cols.map((c) => val(row, c)).join(','))].join('\n');
      return reply.type('text/csv').header('content-disposition', `attachment; filename="hoolam-deals-${from}-to-${to}.csv"`).send(csv);
    });

    // =====================================================================================
    // People
    // =====================================================================================
    api.get('/people', async (req) => {
      const q = req.query as Record<string, string>;
      const page = pageOf(q);
      const args: unknown[] = [];
      const where: string[] = [];
      if (q.q) {
        args.push(`%${q.q.trim().replace(/[%_]/g, '')}%`);
        where.push(`(u.display_name ILIKE $1 OR u.business_name ILIKE $1 OR u.phone ILIKE $1)`);
      }
      if (q.kind === 'sellers') where.push(`EXISTS (SELECT 1 FROM deals x WHERE x.seller_id=u.id)`);
      if (q.kind === 'buyers') where.push(`EXISTS (SELECT 1 FROM deals x WHERE x.buyer_id=u.id)`);
      if (q.kind === 'paused') where.push('u.blocked');
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [rows, total] = await Promise.all([
        db.query(
          `SELECT u.id, u.phone, u.display_name, u.business_name, u.city, u.blocked, u.deal_cap_minor, u.created_at, u.profile_public,
                  (SELECT count(*)::int FROM deals x WHERE x.seller_id=u.id) AS sales,
                  (SELECT count(*)::int FROM deals x WHERE x.buyer_id=u.id) AS purchases,
                  (SELECT max(updated_at) FROM deals x WHERE x.seller_id=u.id OR x.buyer_id=u.id) AS last_deal_at
           FROM users u ${w} ORDER BY u.created_at DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, args),
        db.query(`SELECT count(*)::int AS n FROM users u ${w}`, args),
      ]);
      return { rows: rows.rows, total: total.rows[0].n, page, pageSize: PAGE };
    });

    api.get('/people/:id', async (req) => {
      const id = (req.params as { id: string }).id;
      const u = (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
      if (!u) throw new HttpError(404, 'No such person');
      const [banks, deals, support, optout, trail] = await Promise.all([
        db.query(`SELECT bank_name, right(account_number, 4) AS last4, account_name, is_default, created_at FROM bank_accounts WHERE user_id=$1 ORDER BY created_at DESC`, [id]),
        db.query(`SELECT code, item, status, buyer_pays_minor, currency, created_at, CASE WHEN seller_id=$1 THEN 'seller' ELSE 'buyer' END AS role FROM deals WHERE seller_id=$1 OR buyer_id=$1 OR counter_seller_id=$1 ORDER BY created_at DESC LIMIT 30`, [id]),
        db.query(`SELECT id, message, status, created_at FROM support_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 10`, [id]),
        db.query(`SELECT reason, created_at FROM contact_optouts WHERE phone=$1`, [u.phone]),
        db.query(`SELECT at, actor, action, reason, details FROM audit_log WHERE target_type='user' AND target_id=$1 ORDER BY id DESC LIMIT 30`, [id]),
      ]);
      return {
        user: u, seller: await d.trust.seller(id), buyer: await d.trust.buyer(id),
        banks: banks.rows, deals: deals.rows, support: support.rows, optout: optout.rows[0] ?? null, trail: trail.rows,
        normalCapMinor: d.deals.maxDealMinor,
      };
    });

    // a seller's page photo and links: staff can see them anywhere and take down anything unsuitable
    api.get('/people/:id/photo', async (req, reply) => {
      const p = await d.trust.photo((req.params as { id: string }).id);
      if (!p) throw new HttpError(404, 'No photo');
      return reply.type(p.mime).header('cache-control', 'private, max-age=300').send(p.bytes);
    });
    api.delete('/people/:id/photo', async (req) => {
      need(req, 'user.block');
      const id = (req.params as { id: string }).id;
      const reason = reasonOf(req.body);
      await act(req, { action: 'user.photo.remove', targetType: 'user', targetId: id, reason }, () => d.trust.removePhoto(id));
      return { ok: true };
    });
    api.put('/people/:id/social', async (req) => {
      need(req, 'user.block');
      const id = (req.params as { id: string }).id;
      const b = req.body as { kind: SocialKind; value?: string | null };
      if (!SOCIAL_KINDS.includes(b.kind)) throw new HttpError(400, 'Unknown link');
      if (b.value) { const r = parseSocial(b.kind, b.value); if ('error' in r) throw new HttpError(400, r.error); }
      const reason = reasonOf(req.body);
      const before = (await d.trust.seller(id))?.socials.find((x) => x.kind === b.kind)?.label ?? null;
      await act(req, { action: 'user.social', targetType: 'user', targetId: id, reason, details: { link: b.kind, from: before, to: b.value ?? null } },
        () => d.trust.setSocial(id, b.kind, b.value ?? null));
      return { ok: true };
    });
    api.post('/people/:id/pause', async (req) => {
      need(req, 'user.block');
      const id = (req.params as { id: string }).id;
      const paused = (req.body as { paused?: boolean }).paused !== false;
      const reason = reasonOf(req.body);
      await act(req, { action: paused ? 'user.pause' : 'user.unpause', targetType: 'user', targetId: id, reason },
        () => db.query('UPDATE users SET blocked=$2, blocked_reason=$3 WHERE id=$1', [id, paused, paused ? reason : null]));
      return { ok: true };
    });
    api.post('/people/:id/cap', async (req) => {
      need(req, 'user.cap');
      const id = (req.params as { id: string }).id;
      const b = req.body as { cap?: number | null };
      const reason = reasonOf(req.body);
      const capMinor = b.cap == null ? null : Math.round(Number(b.cap) * unit);
      if (capMinor != null && (!Number.isFinite(capMinor) || capMinor < 100 * unit)) throw new HttpError(400, 'Enter a sensible cap, or clear it.');
      const before = (await db.query('SELECT deal_cap_minor FROM users WHERE id=$1', [id])).rows[0]?.deal_cap_minor ?? null;
      await act(req, { action: 'user.cap', targetType: 'user', targetId: id, reason, details: { from: before == null ? null : Number(before) / unit, to: b.cap ?? null } },
        () => db.query('UPDATE users SET deal_cap_minor=$2 WHERE id=$1', [id, capMinor]));
      return { ok: true };
    });

    // =====================================================================================
    // Support
    // =====================================================================================
    api.get('/support', async (req) => {
      const state = (req.query as { state?: string }).state === 'closed' ? 'CLOSED' : 'OPEN';
      const r = await db.query(
        `SELECT s.id, s.phone, s.message, s.status, s.created_at, s.closed_at, u.id AS user_id, u.display_name, u.business_name,
                (SELECT max(created_at) FROM outbound_messages o WHERE o.phone=s.phone AND o.body::text LIKE '%From the Hoolam team%') AS last_reply_at
         FROM support_requests s LEFT JOIN users u ON u.id=s.user_id WHERE s.status=$1 ORDER BY s.created_at ${state === 'OPEN' ? 'ASC' : 'DESC'} LIMIT 100`, [state]);
      return { rows: r.rows };
    });
    api.get('/support/:id', async (req) => {
      const id = Number((req.params as { id: string }).id);
      const s = (await db.query(`SELECT s.*, u.display_name, u.business_name FROM support_requests s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=$1`, [id])).rows[0];
      if (!s) throw new HttpError(404, 'No such request');
      const [requests, outbound, windowOpen, trail] = await Promise.all([
        db.query(`SELECT id, message, created_at FROM support_requests WHERE phone=$1 ORDER BY id`, [s.phone]),
        db.query(`SELECT id, body, status, created_at FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 40`, [s.phone]),
        db.query(`SELECT last_inbound_at > now() - interval '24 hours' AS open, last_inbound_at FROM chat_sessions WHERE phone=$1`, [s.phone]),
        db.query(`SELECT at, actor, action, reason, details FROM audit_log WHERE target_type='support' AND target_id=$1 ORDER BY id`, [String(id)]),
      ]);
      const thread = [
        ...requests.rows.map((r) => ({ id: `in-${r.id}`, from: 'them', text: r.message, at: r.created_at })),
        ...outbound.rows.map((o) => ({ id: `out-${o.id}`, from: 'hoolam', text: o.body?.text ?? '', at: o.created_at, status: o.status, team: String(o.body?.text ?? '').startsWith('🙋 From the Hoolam team') })),
      ].sort((a, b) => +new Date(a.at) - +new Date(b.at));
      return { request: s, thread, windowOpen: !!windowOpen.rows[0]?.open, lastInboundAt: windowOpen.rows[0]?.last_inbound_at ?? null, trail: trail.rows };
    });
    api.post('/support/:id/reply', async (req) => {
      need(req, 'support.reply');
      const id = (req.params as { id: string }).id;
      const text = String((req.body as { text?: string }).text ?? '').trim();
      if (text.length < 2) throw new HttpError(400, 'Write a reply first.');
      const s = (await db.query('SELECT phone FROM support_requests WHERE id=$1', [id])).rows[0];
      if (!s) throw new HttpError(404, 'No such request');
      const status = await act(req, { action: 'support.reply', targetType: 'support', targetId: id, details: { text: text.slice(0, 200) } },
        async () => {
          const st = await d.messenger.send(s.phone, msg.fromTeam(text.slice(0, 900)));
          if (st === 'NEEDS_TEMPLATE') throw new HttpError(409, 'Not delivered: it\'s been more than 24 hours since they messaged Hoolam (WhatsApp rule).');
          if (st === 'FAILED') throw new HttpError(502, 'WhatsApp refused the message.');
          return st;
        });
      if ((req.body as { close?: boolean }).close) {
        await db.query(`UPDATE support_requests SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE id=$1`, [id, req.staff!.id]);
        await audit(db, actorOf(req), { action: 'support.close', targetType: 'support', targetId: id });
      }
      return { ok: true, delivery: status };
    });
    api.post('/support/:id/close', async (req) => {
      need(req, 'support.close');
      const id = (req.params as { id: string }).id;
      const reopen = (req.body as { reopen?: boolean }).reopen === true;
      await act(req, { action: reopen ? 'support.reopen' : 'support.close', targetType: 'support', targetId: id },
        () => db.query(`UPDATE support_requests SET status=$2, closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE NULL END, closed_by=$3 WHERE id=$1`, [id, reopen ? 'OPEN' : 'CLOSED', req.staff!.id]));
      return { ok: true };
    });
    api.get('/messages', async (req) => {
      const q = req.query as Record<string, string>;
      const page = pageOf(q);
      const where = q.status ? 'WHERE status=$1' : '';
      const args = q.status ? [q.status] : [];
      const [rows, total] = await Promise.all([
        db.query(`SELECT id, phone, kind, status, error, body, created_at FROM outbound_messages ${where} ORDER BY id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, args),
        db.query(`SELECT count(*)::int AS n FROM outbound_messages ${where}`, args),
      ]);
      return { rows: rows.rows.map((m) => ({ ...m, text: m.body?.text ?? (m.kind === 'image' ? '[photo]' : ''), body: undefined })), total: total.rows[0].n, page, pageSize: PAGE };
    });

    // =====================================================================================
    // Settings
    // =====================================================================================
    api.get('/settings', async (req) => {
      need(req, 'settings.view');
      const [rows, history] = await Promise.all([
        db.query(`SELECT x.key, x.updated_at, s.name AS updated_by FROM settings x LEFT JOIN staff s ON s.id=x.updated_by`),
        db.query(`SELECT at, actor, reason, details FROM audit_log WHERE action='settings.update' ORDER BY id DESC LIMIT 30`),
      ]);
      return {
        currency: d.config.CURRENCY, defs: SETTING_DEFS, values: d.settings.all(), defaults: d.settings.defaults(),
        updated: Object.fromEntries(rows.rows.map((r) => [r.key, { at: r.updated_at, by: r.updated_by }])), history: history.rows,
      };
    });
    api.put('/settings', async (req) => {
      need(req, 'settings.update');
      const b = req.body as { changes?: Record<string, number | boolean | string> };
      const reason = reasonOf(req.body);
      const current = d.settings.all();
      const changes: Record<string, number | boolean | string> = {};
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (let [k, v] of Object.entries(b.changes ?? {})) {
        v = d.settings.normalize(k, v) as typeof v;
        const err = d.settings.validate(k, v);
        if (err) throw new HttpError(400, err);
        if (current[k] !== v) { changes[k] = v; diff[k] = { from: current[k], to: v }; }
      }
      if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing changed.');
      const core = Object.keys(changes).filter((k) => SETTING_DEFS.find((x) => x.key === k)?.core);
      if (core.length && !can(req.staff!.role, 'settings.core')) throw new HttpError(403, 'Only an owner can change fees, limits and Hoolam\'s WhatsApp number.');
      await act(req, { action: 'settings.update', targetType: 'settings', targetId: Object.keys(changes).join(','), reason, details: { changes: diff } },
        async () => { try { await d.settings.save(db, changes, req.staff!.id); } catch (e) { throw new HttpError(400, (e as Error).message); } });
      // the website and its legal pages show fees, limits, timings, the number and the contact details: refresh it
      if (Object.keys(changes).some((k) => k !== 'alerts_enabled' && k !== 'forms_enabled')) d.siteSync.changed();
      return { ok: true, values: d.settings.all() };
    });

    // ---- WhatsApp templates: the messages Hoolam may start outside the 24-hour window ----
    const templateList = () => ALL_TEMPLATES.map((t) => ({ name: t.name, label: t.label, body: t.body.replace(/\{\{(\d+)\}\}/g, (_m, i) => t.example[Number(i) - 1] ?? ''), buttons: t.buttons ?? [], status: d.messenger.templateStatus(t.name) }));
    api.get('/whatsapp/templates', async (req) => {
      need(req, 'settings.view');
      return { connected: !d.config.WHATSAPP_DRY_RUN && !!d.config.WHATSAPP_WABA_ID, templates: templateList() };
    });
    api.post('/whatsapp/templates/refresh', async (req) => {
      need(req, 'settings.update');
      await d.refreshTemplates?.();
      return { templates: templateList() };
    });

    // ---- the payment partner: is it connected, and does it answer? ----
    const naira = (m: number) => msg.moneyText({ minor: Number(m), currency: 'NGN' });
    const serverUrl = () => (d.config.RENDER_EXTERNAL_URL || d.config.PUBLIC_BASE_URL).replace(/\/+$/, '');
    api.get('/payments/connection', async (req) => {
      need(req, 'settings.view');
      const c = d.config;
      const last = await db.query(`SELECT max(received_at) AS at FROM webhook_events WHERE source='payments'`);
      return {
        provider: d.provider.name, sandbox: d.provider.sandbox,
        baseUrl: c.PAYMENT_PROVIDER === 'monnify' ? c.MONNIFY_BASE_URL : null,
        configured: { apiKey: !!c.MONNIFY_API_KEY, secretKey: !!c.MONNIFY_SECRET_KEY, contractCode: !!c.MONNIFY_CONTRACT_CODE, wallet: !!c.MONNIFY_WALLET_ACCOUNT },
        signatureRequired: c.MONNIFY_REQUIRE_SIGNATURE, selfDeals: c.ALLOW_SELF_DEAL,
        webhookUrl: `${serverUrl()}/webhook/payments`, lastWebhookAt: last.rows[0]?.at ?? null,
      };
    });
    /** Runs a few harmless calls against the payment partner and says, step by step, what works. Never moves money. */
    api.post('/payments/connection/check', async (req) => {
      need(req, 'settings.core');
      const b = (req.body ?? {}) as { bankCode?: string; accountNumber?: string; testPayment?: boolean };
      type Step = { key: string; ok: boolean | null; title: string; detail: string };
      const steps: Step[] = [];
      const run = async (key: string, title: string, fn: () => Promise<string>) => {
        try { steps.push({ key, ok: true, title, detail: await fn() }); return true; } catch (e) { steps.push({ key, ok: false, title, detail: (e as Error).message }); return false; }
      };
      const p = d.provider;
      let banks: { code: string; name: string }[] = [];
      const loggedIn = await run('login', 'Log in and fetch the list of banks', async () => {
        banks = await p.listBanks();
        return `${banks.length} banks. The API key and secret key work.`;
      });
      if (loggedIn && p.walletBalance) {
        await run('wallet', 'Read the wallet that pays sellers', async () => {
          const w = await p.walletBalance!();
          return `${naira(w.availableMinor)} available (${naira(w.ledgerMinor)} in total).`;
        });
      } else if (loggedIn) steps.push({ key: 'wallet', ok: null, title: 'Read the wallet that pays sellers', detail: 'Pretend money has no wallet.' });
      if (loggedIn && b.bankCode && b.accountNumber) {
        const bank = banks.find((x) => x.code === b.bankCode)?.name ?? b.bankCode;
        await run('name', `Look up account ${b.accountNumber} at ${bank}`, async () => {
          const name = await p.resolveAccount(String(b.bankCode), String(b.accountNumber).replace(/\D/g, ''));
          if (!name) throw new Error('No name came back. Check the number and bank (the sandbox only knows some test accounts).');
          return name;
        });
      }
      if (loggedIn && b.testPayment) {
        if (!p.sandbox) steps.push({ key: 'collect', ok: null, title: 'Create a ₦100 test payment', detail: 'Skipped: these are live keys, and a test payment would be real.' });
        else await run('collect', 'Create a ₦100 test payment', async () => {
          const r = await p.createCollection({ paymentReference: `HL-CHECK-${Date.now()}`, amountMinor: 100_00, currency: 'NGN', description: 'Hoolam connection check', customerName: 'Hoolam Check', customerEmail: 'check@hoolam.com' });
          return `Pay ₦100 to ${r.accountNumber} (${r.bankName}, ${r.accountName}) from Monnify's test bank at websim.sdk.monnify.com. Then reload this page: "Last payment notice" should update within a minute.`;
        });
      }
      return { steps, checkedAt: new Date() };
    });

    // ---- logo and website pictures ----
    const siteState = () => ({ autoRefresh: d.siteSync.enabled, pending: d.siteSync.pending, lastRequestedAt: d.siteSync.lastRequestedAt, lastError: d.siteSync.lastError });
    api.get('/media', async (req) => {
      need(req, 'settings.view');
      const [items, history] = await Promise.all([
        d.siteMedia.list(),
        db.query(`SELECT at, actor, action, target_id, details FROM audit_log WHERE action IN ('media.upload','media.remove') ORDER BY id DESC LIMIT 30`),
      ]);
      return {
        slots: SLOTS,
        items: Object.fromEntries(items.map((m) => [m.slot, { ...m, url: d.siteMedia.url('', m.slot) }])),
        site: siteState(), siteUrl: d.config.SITE_URL ?? null, history: history.rows,
      };
    });
    api.addContentTypeParser(/^image\/.+$/, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES + 1024 }, (_req, body, done) => done(null, body));
    api.put('/media/:slot', { bodyLimit: MAX_UPLOAD_BYTES + 1024 }, async (req) => {
      need(req, 'brand.update');
      const { slot } = req.params as { slot: string };
      const def = SLOTS.find((x) => x.key === slot);
      if (!def) throw new HttpError(404, 'That image spot doesn\'t exist.');
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the image file itself.');
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).slice(0, 200) || null;
      const where = def.group === 'brand' ? def.label : `Section ${def.section} · ${def.label}`;
      const info = await act(req, { action: 'media.upload', targetType: 'media', targetId: slot, details: { where, file: name, inBytes: req.body.length } },
        async () => { try { return await d.siteMedia.put(slot, req.body as Buffer, req.staff!.id, name); } catch (e) { throw e instanceof MediaError ? new HttpError(400, e.message) : e; } });
      d.siteSync.changed();
      return { ok: true, item: { ...info, updatedBy: req.staff!.name, url: d.siteMedia.url('', slot) }, site: siteState() };
    });
    api.delete('/media/:slot', async (req) => {
      need(req, 'brand.update');
      const { slot } = req.params as { slot: string };
      const def = SLOTS.find((x) => x.key === slot);
      if (!def) throw new HttpError(404, 'That image spot doesn\'t exist.');
      const where = def.group === 'brand' ? def.label : `Section ${def.section} · ${def.label}`;
      await act(req, { action: 'media.remove', targetType: 'media', targetId: slot, details: { where } }, () => d.siteMedia.remove(slot));
      d.siteSync.changed();
      return { ok: true, site: siteState() };
    });
    api.post('/media/refresh-site', async (req) => {
      need(req, 'brand.update');
      if (!d.siteSync.enabled) throw new HttpError(400, 'Automatic website refresh isn\'t set up yet.');
      await act(req, { action: 'site.refresh', targetType: 'site', targetId: 'website' }, () => d.siteSync.rebuild());
      return { ok: true, site: siteState() };
    });

    // =====================================================================================
    // Insights
    // =====================================================================================
    api.get('/insights', async (req) => {
      const q = req.query as Record<string, string>;
      const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
      const test = q.includeTest !== '0';
      const T = test ? 'true' : 'NOT d.is_test';
      const DONE = `('RELEASING','PAYOUT_PENDING','COMPLETED')`;
      const kpiSql = (offset: number) => `
        SELECT count(*)::int AS created,
               count(*) FILTER (WHERE d.funded_at IS NOT NULL)::int AS paid,
               count(*) FILTER (WHERE d.status IN ${DONE})::int AS completed,
               COALESCE(SUM(d.buyer_pays_minor) FILTER (WHERE d.funded_at IS NOT NULL), 0)::bigint AS gmv,
               COALESCE(SUM(d.fee_minor) FILTER (WHERE d.status IN ${DONE}), 0)::bigint AS fees,
               count(DISTINCT d.seller_id) FILTER (WHERE d.funded_at IS NOT NULL)::int AS sellers,
               count(DISTINCT d.buyer_id) FILTER (WHERE d.funded_at IS NOT NULL)::int AS buyers
        FROM deals d WHERE ${T} AND d.created_at > now() - make_interval(days => ${days * (offset + 1)}) AND d.created_at <= now() - make_interval(days => ${days * offset})`;
      const [now, prev, series, funnel, timing, disputes, ratings, top, started, statusNow, repeat] = await Promise.all([
        db.query(kpiSql(0)), db.query(kpiSql(1)),
        db.query(`
          WITH days AS (SELECT generate_series(date_trunc('day', now()) - make_interval(days => ${days - 1}), date_trunc('day', now()), interval '1 day') AS day)
          SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
                 count(d.*) FILTER (WHERE date_trunc('day', d.created_at)=days.day)::int AS created,
                 count(d.*) FILTER (WHERE date_trunc('day', d.funded_at)=days.day)::int AS paid,
                 COALESCE(SUM(d.buyer_pays_minor) FILTER (WHERE date_trunc('day', d.funded_at)=days.day), 0)::bigint AS gmv,
                 COALESCE(SUM(d.fee_minor) FILTER (WHERE date_trunc('day', d.closed_at)=days.day AND d.status IN ${DONE}), 0)::bigint AS fees
          FROM days LEFT JOIN deals d ON ${T} AND (date_trunc('day', d.created_at)=days.day OR date_trunc('day', d.funded_at)=days.day OR date_trunc('day', d.closed_at)=days.day)
          GROUP BY days.day ORDER BY days.day`),
        db.query(`
          SELECT count(*)::int AS created,
                 count(*) FILTER (WHERE d.buyer_id IS NOT NULL AND d.seller_id IS NOT NULL)::int AS matched,
                 count(*) FILTER (WHERE d.funded_at IS NOT NULL)::int AS paid,
                 count(*) FILTER (WHERE d.shipped_at IS NOT NULL)::int AS shipped,
                 count(*) FILTER (WHERE d.status IN ${DONE})::int AS completed
          FROM deals d WHERE ${T} AND d.created_at > now() - make_interval(days => ${days})`),
        db.query(`
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.funded_at - d.created_at)/3600) AS to_pay,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.shipped_at - d.funded_at)/3600) AS to_ship,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.at - d.shipped_at)/3600) AS to_confirm
          FROM deals d LEFT JOIN LATERAL (SELECT min(created_at) AS at FROM deal_events e WHERE e.deal_id=d.id AND e.to_status='RELEASING') r ON true
          WHERE ${T} AND d.created_at > now() - make_interval(days => ${days})`),
        db.query(`SELECT count(*)::int AS opened, count(*) FILTER (WHERE x.status='RESOLVED_REFUND')::int AS refunded, count(*) FILTER (WHERE x.status='RESOLVED_RELEASE')::int AS released
                  FROM disputes x JOIN deals d ON d.id=x.deal_id WHERE ${T} AND x.created_at > now() - make_interval(days => ${days})`),
        db.query(`SELECT count(*) FILTER (WHERE r.happy)::int AS happy, count(*)::int AS rated FROM deal_ratings r JOIN deals d ON d.id=r.deal_id WHERE ${T} AND r.created_at > now() - make_interval(days => ${days})`),
        db.query(`SELECT u.id, COALESCE(u.business_name, u.display_name, u.phone) AS name, count(*)::int AS deals, SUM(d.buyer_pays_minor)::bigint AS gmv,
                         (SELECT count(*) FILTER (WHERE happy)::int FROM deal_ratings r WHERE r.seller_id=u.id) AS happy,
                         (SELECT count(*)::int FROM deal_ratings r WHERE r.seller_id=u.id) AS rated
                  FROM deals d JOIN users u ON u.id=d.seller_id WHERE ${T} AND d.status IN ${DONE} AND d.created_at > now() - make_interval(days => ${days})
                  GROUP BY u.id ORDER BY deals DESC, gmv DESC LIMIT 8`),
        db.query(`SELECT started_by, count(*)::int AS n FROM deals d WHERE ${T} AND d.created_at > now() - make_interval(days => ${days}) GROUP BY started_by`),
        db.query(`SELECT status, count(*)::int AS n FROM deals d WHERE ${T} GROUP BY status`),
        db.query(`SELECT count(*)::int AS n FROM (SELECT buyer_id FROM deals d WHERE ${T} AND d.funded_at IS NOT NULL GROUP BY buyer_id HAVING count(*) > 1) x`),
      ]);
      const k = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([a, b]) => [a, Number(b)]));
      const t = timing.rows[0];
      return {
        days, includeTest: test, currency: d.config.CURRENCY,
        kpis: k(now.rows[0]), previous: k(prev.rows[0]),
        series: series.rows.map((r) => ({ day: r.day, created: r.created, paid: r.paid, gmv: Number(r.gmv), fees: Number(r.fees) })),
        funnel: k(funnel.rows[0]),
        timing: { toPay: t.to_pay == null ? null : Number(t.to_pay), toShip: t.to_ship == null ? null : Number(t.to_ship), toConfirm: t.to_confirm == null ? null : Number(t.to_confirm) },
        disputes: k(disputes.rows[0]), ratings: k(ratings.rows[0]),
        topSellers: top.rows.map((r) => ({ ...r, gmv: Number(r.gmv) })),
        startedBy: Object.fromEntries(started.rows.map((r) => [r.started_by, r.n])),
        statusNow: Object.fromEntries(statusNow.rows.map((r) => [r.status, r.n])),
        repeatBuyers: repeat.rows[0].n,
      };
    });

    // =====================================================================================
    // Team
    // =====================================================================================
    api.get('/team', async () => {
      const r = await db.query(
        `SELECT s.id, s.email, s.name, s.role, s.active, s.totp_enabled, s.created_at, s.last_login_at,
                (SELECT max(at) FROM audit_log a WHERE a.staff_id=s.id) AS last_action_at,
                (SELECT count(*)::int FROM audit_log a WHERE a.staff_id=s.id AND a.at > now() - interval '30 days') AS actions_30d
         FROM staff s ORDER BY s.active DESC, s.role, s.name`);
      return { rows: r.rows, roles: ROLES.map((role) => ({ role, name: roleName(role), can: permissionsFor(role) })) };
    });
    api.post('/team/invite', async (req) => {
      need(req, 'staff.manage');
      return d.auth.invite(actorOf(req), req.body as { email: string; name: string; role: Role });
    });
    api.post('/team/:id/role', async (req) => {
      need(req, 'staff.manage');
      await d.auth.setRole(actorOf(req), (req.params as { id: string }).id, (req.body as { role: Role }).role);
      return { ok: true };
    });
    api.post('/team/:id/active', async (req) => {
      need(req, 'staff.manage');
      await d.auth.setActive(actorOf(req), (req.params as { id: string }).id, (req.body as { active: boolean }).active !== false);
      return { ok: true };
    });
    api.post('/team/:id/reset', async (req) => {
      need(req, 'staff.manage');
      return { inviteUrl: await d.auth.resetLogin(actorOf(req), (req.params as { id: string }).id) };
    });

    // =====================================================================================
    // Audit trail
    // =====================================================================================
    api.get('/audit', async (req) => {
      need(req, 'audit.view');
      const q = req.query as Record<string, string>;
      const page = pageOf(q);
      const args: unknown[] = [];
      const where: string[] = [];
      const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replaceAll('?', `$${args.length}`)); };
      if (q.staff) add('a.staff_id = ?', q.staff);
      if (q.action) add(`a.action LIKE ?`, `${q.action.replace(/[%_]/g, '')}%`);
      if (q.target) add(`a.target_id ILIKE ?`, `%${q.target.replace(/[%_]/g, '')}%`);
      if (q.q) add(`(a.reason ILIKE ? OR a.details::text ILIKE ? OR a.actor ILIKE ?)`, `%${q.q.replace(/[%_]/g, '')}%`);
      if (q.from) add(`a.at >= ?::date`, q.from);
      if (q.to) add(`a.at < ?::date + 1`, q.to);
      if (q.hideSignIns === '1') where.push(`a.action NOT LIKE 'auth.%'`);
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [rows, total, staff] = await Promise.all([
        db.query(`SELECT a.id, a.at, a.actor, a.staff_id, a.action, a.target_type, a.target_id, a.reason, a.details, a.ip, s.role
                  FROM audit_log a LEFT JOIN staff s ON s.id=a.staff_id ${w} ORDER BY a.id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, args),
        db.query(`SELECT count(*)::int AS n FROM audit_log a ${w}`, args),
        db.query('SELECT id, name FROM staff ORDER BY name'),
      ]);
      return { rows: rows.rows, total: total.rows[0].n, page, pageSize: PAGE, staff: staff.rows };
    });
  }, { prefix: '/console/api' });
}

// ---------- helpers ----------
function meOf(s: StaffMember) {
  return { id: s.id, email: s.email, name: s.name, role: s.role, roleName: roleName(s.role), can: permissionsFor(s.role) };
}
export function roleName(r: Role): string {
  return { OWNER: 'Owner', ADMIN: 'Admin', FINANCE: 'Finance', SUPPORT: 'Support' }[r] ?? r;
}
function dealErrorText(reason: string): string {
  return ({ NOT_FOUND: 'No such deal.', NOT_ALLOWED: 'That isn\'t possible at this stage of the deal.', OWN_DEAL: 'Not allowed on your own deal.', TAKEN: 'Someone else has this deal.', CLOSED: 'This deal is closed.', TOO_BIG: 'Above the deal limit.' } as Record<string, string>)[reason] ?? reason;
}
function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}
function ago(d: Date | string): string {
  const h = (Date.now() - new Date(d).getTime()) / 3600_000;
  return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`;
}
function until(d: Date | string): string {
  const h = (new Date(d).getTime() - Date.now()) / 3600_000;
  return h < 1 ? 'within the hour' : `in ${Math.round(h)} hours`;
}
