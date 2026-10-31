import type { Db } from './db.js';
import type { Inbound } from './whatsapp/inbound.js';

/**
 * EACH PERSON'S ACTIVITY (Console → Buyers & sellers → a person → Activity).
 * Recorded here: what they do in the chat (taps, messages, photos, forms, live form screens).
 * Read alongside, from where it's already kept: their orders' steps (deal_events), what Hoolam sent them and whether
 * it was read (outbound_messages), and the team's actions on them or their orders (audit_log).
 * Never kept: ID numbers and dates of birth, handover codes, full account or phone numbers (last 4 digits only).
 */
export type ActivityKind = 'tap' | 'message' | 'form' | 'screen';
export type ActivityFilter = 'all' | 'taps' | 'messages' | 'forms' | 'orders' | 'sent' | 'team';
export interface ActivityItem {
  id: string; at: string;
  kind: ActivityKind | 'order' | 'sent' | 'team';
  title: string;
  detail: Record<string, unknown>;
}

/** Long numbers keep their last 4 digits: account numbers, phone numbers, card numbers. */
export function maskNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s-]{8,}\d/g, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 10 ? `••••${d.slice(-4)}` : m; });
}

/** States where what they type must not be kept (an ID number, a date of birth, a handover code). */
const SECRET_STATES = new Set(['KYC_NUMBER', 'KYC_DOB', 'HANDOVER_CODE']);

const FORMS: [RegExp, string][] = [
  [/^buy(:|$)/, 'Buy something'], [/^sell(:|$)/, 'Sell something'], [/^buyedit/, 'Edit order (buyer)'], [/^selledit/, 'Edit order (seller)'],
  [/^kyc/, 'ID check'], [/^amb/, 'Ambassador application'], [/^mklist/, 'List an item'], [/^mkedit/, 'Edit item'], [/^mkorder/, 'Market delivery'],
  [/^pb1\./, 'Payout account'], [/^problem:/, 'Report a problem'], [/^page:setup/, 'Seller setup'], [/^page:/, 'My page'], [/^rate:/, 'Rating'],
  [/^o1\./, 'My orders'], [/^a1\./, 'Ambassador details'],
];
export const formName = (token: string) => FORMS.find(([re]) => re.test(token))?.[1] ?? 'A form';

/** The answers of a form, safe to keep: no ID details, numbers masked, photos counted. */
function formAnswers(token: string, form: Record<string, unknown>): Record<string, unknown> {
  if (/^kyc/.test(token)) return { note: 'ID details are never kept' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    if (k === 'flow_token' || v === '' || v == null) continue;
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) { out[k] = `${v.length} photo${v.length === 1 ? '' : 's'}`; continue; }
    if (/^(dob|date_of_birth|bvn|nin|id_number|number)$/i.test(k)) continue;
    out[k] = typeof v === 'string' ? maskNumbers(v).slice(0, 600) : Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** An order code or a market item a button points at, so the console can link to it. */
function about(id: string): Record<string, unknown> {
  const code = id.match(/HL-?[A-Z2-9]{5}/i)?.[0];
  const item = id.match(/^mk:(?:buy|see|go|qty|bask|newbask|save|more|rep|rr|item|chg|chgchat|share|act|e|imore):(\d+)/)?.[1];
  return { ...(code ? { code: code.toUpperCase().replace(/^HL-?/, 'HL-') } : {}), ...(item ? { listing: Number(item) } : {}) };
}

/** What an inbound WhatsApp message was, in plain words. Null for our own internal steps. */
export function describeInbound(m: Inbound, state: string): { kind: ActivityKind; title: string; detail: Record<string, unknown> } | null {
  if (/^(kyc|form)-/.test(m.id)) return null; // our own follow-ups, not something they did
  if (m.type === 'button') {
    const title = (m.text || m.buttonId || '').trim();
    return { kind: 'tap', title: `Tapped “${title.slice(0, 60)}”`, detail: { button: m.buttonId, ...about(m.buttonId ?? '') } };
  }
  if (m.type === 'form') {
    const token = String(m.form?.flow_token ?? '');
    return { kind: 'form', title: `Sent the ${formName(token)} form`, detail: { ...about(token), answers: formAnswers(token, m.form ?? {}) } };
  }
  if (m.type === 'text') {
    if (SECRET_STATES.has(state)) return { kind: 'message', title: state === 'HANDOVER_CODE' ? 'Typed a handover code' : 'Typed their ID details', detail: { note: 'Not kept, for their safety' } };
    return { kind: 'message', title: 'Sent a message', detail: { text: maskNumbers(m.text).slice(0, 1000), ...about(m.text) } };
  }
  if (m.type === 'image') return { kind: 'message', title: 'Sent a photo', detail: m.text ? { text: maskNumbers(m.text).slice(0, 300) } : {} };
  if (m.type === 'video') return { kind: 'message', title: 'Sent a video', detail: {} };
  if (m.type === 'audio') return { kind: 'message', title: 'Sent a voice note', detail: {} };
  if (m.type === 'location') return { kind: 'message', title: 'Shared a location', detail: m.text ? { place: m.text.slice(0, 200) } : {} };
  if (m.type === 'welcome') return { kind: 'message', title: 'Opened the chat for the first time', detail: {} };
  return { kind: 'message', title: 'Sent something WhatsApp couldn\'t show us', detail: {} };
}

export class Activity {
  constructor(private readonly db: Db, private readonly log?: (l: string) => void) {}

  async record(e: { userId: string | null; phone: string; kind: ActivityKind; title: string; detail?: Record<string, unknown>; waId?: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO user_activity (user_id, phone, kind, title, detail, wa_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [e.userId, e.phone, e.kind, e.title.slice(0, 200), JSON.stringify(e.detail ?? {}), e.waId ?? null],
    ).catch((err) => this.log?.(`activity: ${(err as Error).message}`));
  }

  /** One inbound message, as they sent it (never throws). */
  async inbound(m: Inbound, userId: string, state: string): Promise<void> {
    // a tap with no title (some phones, test runs): the title from the message we sent with that button
    if (m.type === 'button' && m.buttonId && (!m.text || m.text === m.buttonId)) {
      const title = await this.buttonTitle(m.phone, m.buttonId).catch(() => null);
      if (title) m = { ...m, text: title };
    }
    const d = describeInbound(m, state);
    if (d) await this.record({ userId, phone: m.phone, ...d, waId: m.id });
  }

  private async buttonTitle(phone: string, id: string): Promise<string | null> {
    const r = await this.db.query(`SELECT body FROM outbound_messages WHERE phone=$1 AND body::text LIKE $2 ORDER BY id DESC LIMIT 1`, [phone, `%"id": "${id.replace(/[%_\\]/g, '')}"%`]); // jsonb prints "id": "…"
    const b = r.rows[0]?.body;
    if (!b) return null;
    const rows = [...(b.buttons ?? []), ...((b.sections ?? []) as { rows?: { id: string; title: string }[] }[]).flatMap((x) => x.rows ?? []), ...((b.cards ?? []) as { buttons?: { id: string; title: string }[] }[]).flatMap((c) => c.buttons ?? [])];
    return rows.find((x: { id: string }) => x.id === id)?.title ?? null;
  }

  /** Everything a person did and what happened around them, newest first. `before`: for "Show older". */
  async list(userId: string, o: { filter?: ActivityFilter; before?: string | null; limit?: number } = {}) {
    const f = o.filter ?? 'all', limit = Math.min(200, o.limit ?? 80);
    const before = o.before ? new Date(o.before) : new Date(Date.now() + 60_000);
    const u = (await this.db.query('SELECT phone, created_at FROM users WHERE id=$1', [userId])).rows[0];
    if (!u) return null;
    const want = (k: ActivityFilter) => f === 'all' || f === k;
    const items: ActivityItem[] = [];
    const own = f === 'all' ? ['tap', 'message', 'form', 'screen'] : f === 'taps' ? ['tap', 'screen'] : f === 'messages' ? ['message'] : f === 'forms' ? ['form'] : [];
    if (own.length) {
      const r = await this.db.query(`SELECT id, at, kind, title, detail FROM user_activity WHERE user_id=$1 AND at < $2 AND kind = ANY($3) ORDER BY at DESC LIMIT $4`, [userId, before, own, limit]);
      for (const x of r.rows) items.push({ id: `a${x.id}`, at: x.at, kind: x.kind, title: x.title, detail: x.detail });
    }
    if (want('orders')) {
      const r = await this.db.query(
        `SELECT e.id, e.created_at, e.from_status, e.to_status, e.actor, e.note, d.code, d.item, CASE WHEN d.buyer_id=$1 THEN 'buyer' ELSE 'seller' END AS role
         FROM deal_events e JOIN deals d ON d.id=e.deal_id WHERE (d.buyer_id=$1 OR d.seller_id=$1) AND e.created_at < $2 ORDER BY e.created_at DESC LIMIT $3`, [userId, before, limit]);
      const started = await this.db.query(
        `SELECT id, code, item, created_at, started_by, CASE WHEN buyer_id=$1 THEN 'buyer' ELSE 'seller' END AS role FROM deals
         WHERE (buyer_id=$1 OR seller_id=$1 OR counter_seller_id=$1) AND created_at < $2 ORDER BY created_at DESC LIMIT $3`, [userId, before, limit]);
      for (const x of started.rows) items.push({ id: `d${x.id}`, at: x.created_at, kind: 'order', title: x.code, detail: { code: x.code, item: x.item, role: x.role, to: 'STARTED', by: x.started_by === 'BUYER' ? 'the buyer' : 'the seller' } });
      for (const x of r.rows) items.push({ id: `o${x.id}`, at: x.created_at, kind: 'order', title: x.code, detail: { code: x.code, item: x.item, role: x.role, from: x.from_status, to: x.to_status, by: x.actor, note: x.note && !/^NEEDS_ATTENTION/.test(x.note) ? x.note : null } });
    }
    if (want('sent')) {
      const r = await this.db.query(
        `SELECT id, created_at, kind, status, body FROM outbound_messages WHERE phone=$1 AND created_at < $2 ORDER BY id DESC LIMIT $3`, [u.phone, before, limit]);
      for (const x of r.rows) {
        const b = x.body ?? {};
        const text = String(b.text ?? b.caption ?? b.header ?? (b.name ? `Template ${b.name}` : x.kind) ?? '').trim();
        items.push({ id: `s${x.id}`, at: x.created_at, kind: 'sent', title: maskNumbers(text.split('\n')[0] ?? '').slice(0, 120) || x.kind, detail: { text: maskNumbers(text).slice(0, 1200), status: x.status, type: x.kind, buttons: Array.isArray(b.buttons) ? b.buttons.map((y: { title?: string }) => y.title).filter(Boolean) : undefined } });
      }
    }
    if (want('team')) {
      const r = await this.db.query(
        `SELECT a.id, a.at, a.actor, a.action, a.reason, a.target_type, a.target_id FROM audit_log a
         WHERE a.at < $2 AND ((a.target_type='user' AND a.target_id=$4)
           OR (a.target_type='deal' AND a.target_id IN (SELECT code FROM deals WHERE buyer_id=$1 OR seller_id=$1)))
         ORDER BY a.at DESC LIMIT $3`, [userId, before, limit, String(userId)]);
      for (const x of r.rows) items.push({ id: `t${x.id}`, at: x.at, kind: 'team', title: x.action, detail: { by: x.actor, reason: x.reason, code: x.target_type === 'deal' ? x.target_id : undefined } });
    }
    items.sort((a, b) => +new Date(b.at) - +new Date(a.at));
    const page = items.slice(0, limit);
    const summary = o.before ? null : (await this.db.query(
      `SELECT max(at) AS last, count(*) FILTER (WHERE at > now() - interval '1 day')::int AS today, count(*) FILTER (WHERE at > now() - interval '7 days')::int AS week,
         count(*) FILTER (WHERE kind IN ('tap','screen') AND at > now() - interval '7 days')::int AS taps_week
       FROM user_activity WHERE user_id=$1`, [userId])).rows[0];
    return {
      items: page, more: items.length > limit || page.length === limit, next: page.at(-1)?.at ?? null,
      summary: summary ? { firstSeen: u.created_at, lastActive: summary.last, today: summary.today, week: summary.week, tapsWeek: summary.taps_week } : null,
    };
  }

  /** Older than 12 months goes (orders, messages and the audit trail keep their own records). */
  async purge(): Promise<number> {
    return (await this.db.query(`DELETE FROM user_activity WHERE at < now() - interval '12 months'`)).rowCount ?? 0;
  }
}
