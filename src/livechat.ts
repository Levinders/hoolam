import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { bus } from './events.js';
import { formatMoney, type Currency } from './money.js';
import { localPhone } from './phone.js';
import type { Settings } from './settings.js';
import { dealTemplate, DEAL_TEMPLATES } from './whatsapp/automation.js';
import type { Messenger } from './whatsapp/client.js';

/**
 * LIVE CHAT on the website. A visitor gives their name and WhatsApp number with their first message; a rep answers
 * from the console's support widget. The first rep to reply handles the chat (others read along, or take it over).
 * If a rep replies after the visitor has left, one WhatsApp message tells them (with a link back to the chat).
 * Closed chats are deleted after 12 months.
 */

export const CHAT_MAX_TEXT = 2000;
export const CHAT_MAX_FILE = 10 * 1024 * 1024;
export const REP_HOURS = { opens: 9, closes: 17 }; // Lagos time, every day
const NOTIFY_AFTER_MINUTES = 2;

export type ContentKind = 'HOME' | 'QUESTION' | 'NEWS' | 'CHIP' | 'SAVED' | 'WELCOME';
export const CONTENT_KINDS: ContentKind[] = ['HOME', 'QUESTION', 'NEWS', 'CHIP', 'SAVED', 'WELCOME'];

export class ChatError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const refCode = () => 'LC-' + Array.from(randomBytes(5), (b) => ALPHA[b % ALPHA.length]).join('');
export const firstName = (n: string | null | undefined) => String(n ?? '').trim().split(/\s+/)[0] || '';

/** 08031234567, 2348031234567 or +234 803 123 4567 → +2348031234567. Null if it isn't a Nigerian mobile number. */
export function chatPhone(raw: string): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (/^234\d{10}$/.test(d)) d = '0' + d.slice(3);
  if (/^[789][01]\d{8}$/.test(d)) d = '0' + d;
  return /^0[789][01]\d{8}$/.test(d) ? '+234' + d.slice(1) : null;
}

/** What a file really is, from its first bytes (never trusting the name or the browser). */
export function sniffFile(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
function cleanName(name: string, mime: string): string {
  const base = String(name ?? '').replace(/[^\w.\- ()]+/g, '').replace(/\.[a-z0-9]+$/i, '').trim().slice(0, 80) || 'file';
  return `${base}.${EXT[mime]}`;
}
const cleanText = (t: unknown) => String(t ?? '').replace(/\r\n/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, CHAT_MAX_TEXT);

/** Rep hours, Lagos time. */
export function repHours(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(now)) % 24;
  return { open: h >= REP_HOURS.opens && h < REP_HOURS.closes, opens: '9am', closes: '5pm' };
}

export interface ChatStaff { id: string; name: string }
export interface LiveChatOptions {
  db: Db;
  settings?: Settings;
  messenger?: Messenger;
  currency: Currency;
  /** The website, for the WhatsApp "open the chat" link. */
  siteUrl: string;
  log?: (line: string) => void;
}

/** One message as either side sees it. Visitors never get NOTEs, and see only the rep's first name. */
function messageOut(m: any, forStaff: boolean) {
  return {
    id: Number(m.id), kind: m.kind as string, body: m.body as string, at: m.created_at,
    by: m.staff_name ? (forStaff ? m.staff_name : firstName(m.staff_name)) : null,
    ...(forStaff ? { staffId: m.staff_id ?? null } : {}),
    file: m.file_id ? { id: Number(m.file_id), name: m.file_name, mime: m.file_mime, size: Number(m.file_size) } : null,
  };
}
const MSG_SQL = `SELECT m.*, f.name AS file_name, f.mime AS file_mime, f.size AS file_size FROM chat_messages m LEFT JOIN chat_files f ON f.id=m.file_id`;

export class LiveChat {
  /** Visitors with the chat open right now (their page holds a live connection): no WhatsApp nudge for them. */
  readonly online = new Map<number, number>();
  /** Teammates looking at a chat right now: thread → staff → { name, until }. */
  private viewing = new Map<number, Map<string, { name: string; until: number }>>();
  private rate = new Map<string, number[]>();

  constructor(private readonly o: LiveChatOptions) {}
  private get db() { return this.o.db; }

  // ---------------------------------------------------------------------------------------------
  // Content (Home cards, Questions, News, chips, saved replies, the welcome line)
  // ---------------------------------------------------------------------------------------------
  /** {fee_rate} and friends → today's values from the console. */
  fill(text: string): string {
    const s = this.o.settings;
    if (!s) return text;
    const unit = this.o.currency === 'NGN' ? 100 : 1;
    const m = (major: number) => formatMoney(Math.round(major * unit), this.o.currency);
    const p = s.pricing(), t = s.txnFees();
    const vals: Record<string, string> = {
      fee_rate: `${String(p.ratePercent).replace(/\.0+$/, '')}%`, fee_min: m(p.min), fee_max: m(p.max),
      txn_min: m(Math.min(...t.seller.map((b) => b.fee), ...t.buyer.map((b) => b.fee))),
      max_deal: formatMoney(s.maxDealMinor(), this.o.currency), max_deal_verified: formatMoney(s.maxDealVerifiedMinor(), this.o.currency),
      whatsapp: localPhone(s.waNumber()),
    };
    return text.replace(/\{(\w+)\}/g, (all, k: string) => vals[k] ?? all);
  }

  async contentForVisitors() {
    const rows = (await this.db.query(`SELECT id, kind, title, body, url, created_at, updated_at FROM chat_content WHERE published AND kind <> 'SAVED' ORDER BY kind, position, id`)).rows;
    const of = (k: ContentKind) => rows.filter((r) => r.kind === k).map((r) => ({ id: Number(r.id), title: this.fill(r.title), body: this.fill(r.body), url: r.url, at: r.updated_at }));
    return {
      welcome: of('WELCOME')[0]?.body ?? 'Hi there. How can we help today?',
      home: of('HOME'), questions: of('QUESTION'), news: of('NEWS'), chips: of('CHIP').map((c) => c.body),
      hours: repHours(), replyMinutes: this.o.settings?.repReplyMinutes() ?? 15,
    };
  }

  async contentForStaff() {
    const rows = (await this.db.query(`SELECT c.*, s.name AS updated_by_name FROM chat_content c LEFT JOIN staff s ON s.id=c.updated_by ORDER BY kind, position, id`)).rows;
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, url: r.url, shortcut: r.shortcut, published: r.published, position: r.position, updatedAt: r.updated_at, updatedBy: r.updated_by_name, preview: this.fill(r.body) }));
  }

  async saveContent(staff: ChatStaff, item: { id?: number; kind: ContentKind; title?: string; body?: string; url?: string | null; shortcut?: string | null; published?: boolean }): Promise<number> {
    if (!CONTENT_KINDS.includes(item.kind)) throw new ChatError('Unknown kind of content.');
    const title = String(item.title ?? '').trim().slice(0, 140);
    const body = String(item.body ?? '').trim().slice(0, 4000);
    const url = item.url ? String(item.url).trim().slice(0, 400) : null;
    if (url && !/^(https:\/\/|\/)/.test(url)) throw new ChatError('Links must start with https:// or / (a page on hoolam.com).');
    const shortcut = item.kind === 'SAVED' ? String(item.shortcut ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || null : null;
    if (['HOME', 'QUESTION', 'NEWS', 'SAVED'].includes(item.kind) && !title) throw new ChatError('Add a title.');
    if (!body) throw new ChatError(item.kind === 'QUESTION' ? 'Add the answer.' : 'Add the text.');
    if (item.kind === 'SAVED' && !shortcut) throw new ChatError('Add a shortcut, like fees (reps type /fees).');
    if (shortcut) {
      const clash = (await this.db.query(`SELECT 1 FROM chat_content WHERE kind='SAVED' AND shortcut=$1 AND id<>$2`, [shortcut, item.id ?? 0])).rowCount;
      if (clash) throw new ChatError(`/${shortcut} is already used by another saved reply.`);
    }
    if (item.id) {
      const r = await this.db.query(
        `UPDATE chat_content SET title=$2, body=$3, url=$4, shortcut=$5, published=COALESCE($6, published), updated_at=now(), updated_by=$7 WHERE id=$1 RETURNING id`,
        [item.id, title, body, url, shortcut, item.published ?? null, staff.id]);
      if (!r.rowCount) throw new ChatError('Not found.', 404);
      return Number(item.id);
    }
    if (item.kind === 'WELCOME') {
      const w = (await this.db.query(`SELECT id FROM chat_content WHERE kind='WELCOME' ORDER BY id LIMIT 1`)).rows[0];
      if (w) return this.saveContent(staff, { ...item, id: Number(w.id) });
    }
    const r = await this.db.query(
      `INSERT INTO chat_content (kind, title, body, url, shortcut, published, position, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT max(position)+1 FROM chat_content WHERE kind=$1), 1), $7) RETURNING id`,
      [item.kind, title, body, url, shortcut, item.published ?? true, staff.id]);
    return Number(r.rows[0].id);
  }

  async removeContent(id: number) { await this.db.query(`DELETE FROM chat_content WHERE id=$1 AND kind <> 'WELCOME'`, [id]); }
  async reorderContent(kind: ContentKind, ids: number[]) {
    for (const [i, id] of ids.entries()) await this.db.query('UPDATE chat_content SET position=$3 WHERE id=$1 AND kind=$2', [id, kind, i + 1]);
  }

  // ---------------------------------------------------------------------------------------------
  // Visitors
  // ---------------------------------------------------------------------------------------------
  async visitorFor(key: string | null | undefined): Promise<{ id: number; name: string; phone: string } | null> {
    if (!key || key.length < 20 || key.length > 80) return null;
    const r = await this.db.query(`SELECT v.id, v.name, v.phone FROM chat_visitor_keys k JOIN chat_visitors v ON v.id=k.visitor_id WHERE k.key_hash=$1`, [hash(key)]);
    return r.rows[0] ? { id: Number(r.rows[0].id), name: r.rows[0].name, phone: r.rows[0].phone } : null;
  }

  /** At most `n` actions a minute for one visitor or address. */
  limit(key: string, n: number, perMs = 60_000) {
    const now = Date.now();
    const list = (this.rate.get(key) ?? []).filter((t) => now - t < perMs);
    if (list.length >= n) throw new ChatError('You’re sending messages very fast. Please wait a moment.', 429);
    list.push(now); this.rate.set(key, list);
    if (this.rate.size > 5000) for (const [k, v] of this.rate) if (!v.some((t) => now - t < perMs)) this.rate.delete(k);
  }

  /** The first message: name, WhatsApp number and what they want. Returns the browser key (new visitors) and the chat. */
  async start(input: { key?: string | null; name: string; phone: string; text: string; page?: string | null; ip?: string | null }) {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (name.length < 2) throw new ChatError('Please tell us your name.');
    const phone = chatPhone(input.phone);
    if (!phone) throw new ChatError('Please enter your WhatsApp number, like 08031234567.');
    const text = cleanText(input.text);
    if (!text) throw new ChatError('Please type your message.');
    this.limit(`start:${input.ip ?? '?'}`, 6, 60 * 60_000);
    const user = (await this.db.query('SELECT id FROM users WHERE phone=$1', [phone])).rows[0];
    let visitor = await this.visitorFor(input.key);
    let key: string | null = null;
    if (visitor) {
      await this.db.query('UPDATE chat_visitors SET name=$2, phone=$3, user_id=$4 WHERE id=$1', [visitor.id, name, phone, user?.id ?? null]);
    } else {
      const v = await this.db.query('INSERT INTO chat_visitors (name, phone, user_id) VALUES ($1,$2,$3) RETURNING id', [name, phone, user?.id ?? null]);
      visitor = { id: Number(v.rows[0].id), name, phone };
      key = token();
      await this.db.query('INSERT INTO chat_visitor_keys (key_hash, visitor_id) VALUES ($1,$2)', [hash(key), visitor.id]);
    }
    const t = await this.db.query(
      `INSERT INTO chat_threads (ref, visitor_id, resume_code, source_page, last_visitor_at) VALUES ($1,$2,$3,$4, now()) RETURNING id`,
      [refCode(), visitor.id, token(12), String(input.page ?? '').slice(0, 200) || null]);
    const threadId = Number(t.rows[0].id);
    await this.addMessage(threadId, 'VISITOR', text, null, null);
    bus.chat({ threadId, type: 'thread' });
    return { key, threadId };
  }

  /** A WhatsApp "open the chat" link: a fresh browser key for that chat's visitor. */
  async resume(code: string) {
    const t = (await this.db.query('SELECT id, visitor_id FROM chat_threads WHERE resume_code=$1', [String(code ?? '').slice(0, 40)])).rows[0];
    if (!t) throw new ChatError('This chat link has expired.', 404);
    const key = token();
    await this.db.query('INSERT INTO chat_visitor_keys (key_hash, visitor_id) VALUES ($1,$2)', [hash(key), t.visitor_id]);
    return { key, threadId: Number(t.id) };
  }

  private async ownThread(visitorId: number, threadId: number) {
    const t = (await this.db.query(
      `SELECT t.*, s.name AS staff_name FROM chat_threads t LEFT JOIN staff s ON s.id=t.assigned_to WHERE t.id=$1 AND t.visitor_id=$2`, [threadId, visitorId])).rows[0];
    if (!t) throw new ChatError('Chat not found.', 404);
    return t;
  }

  private async staffReadUpTo(threadId: number): Promise<number> {
    return Number((await this.db.query('SELECT COALESCE(max(last_read_id),0) AS n FROM chat_reads WHERE thread_id=$1', [threadId])).rows[0].n);
  }

  async visitorThreads(visitorId: number) {
    const r = await this.db.query(
      `SELECT t.id, t.ref, t.status, t.updated_at, t.visitor_read_id, s.name AS staff_name,
              (SELECT row_to_json(x) FROM (SELECT m.kind, m.body, m.file_id, m.created_at FROM chat_messages m WHERE m.thread_id=t.id AND m.kind IN ('VISITOR','STAFF') ORDER BY m.id DESC LIMIT 1) x) AS last,
              (SELECT count(*)::int FROM chat_messages m WHERE m.thread_id=t.id AND m.kind='STAFF' AND m.id > t.visitor_read_id) AS unread
       FROM chat_threads t LEFT JOIN staff s ON s.id=t.assigned_to WHERE t.visitor_id=$1 ORDER BY t.updated_at DESC LIMIT 20`, [visitorId]);
    return r.rows.map((t) => ({
      id: Number(t.id), status: t.status, updatedAt: t.updated_at, rep: firstName(t.staff_name) || null, unread: t.unread,
      last: t.last ? { kind: t.last.kind, text: t.last.body || (t.last.file_id ? 'Sent a file' : ''), at: t.last.created_at } : null,
    }));
  }

  async visitorThread(visitorId: number, threadId: number) {
    const t = await this.ownThread(visitorId, threadId);
    const msgs = (await this.db.query(`${MSG_SQL} WHERE m.thread_id=$1 AND m.kind <> 'NOTE' ORDER BY m.id`, [threadId])).rows;
    return {
      id: Number(t.id), status: t.status, rep: firstName(t.staff_name) || null, rating: t.rating ?? null,
      seenUpTo: await this.staffReadUpTo(threadId),
      messages: msgs.map((m) => messageOut(m, false)),
    };
  }

  async visitorSend(visitorId: number, threadId: number, text: string) {
    this.limit(`v:${visitorId}`, 20);
    const t = await this.ownThread(visitorId, threadId);
    const body = cleanText(text);
    if (!body) throw new ChatError('Please type your message.');
    if (t.status === 'CLOSED') await this.reopen(threadId, null);
    await this.addMessage(threadId, 'VISITOR', body, null, null);
  }

  async visitorFile(visitorId: number, threadId: number, name: string, bytes: Buffer) {
    this.limit(`v:${visitorId}`, 20);
    const t = await this.ownThread(visitorId, threadId);
    if (t.status === 'CLOSED') await this.reopen(threadId, null);
    const fileId = await this.saveFile(threadId, name, bytes);
    await this.addMessage(threadId, 'VISITOR', '', null, fileId);
  }

  async visitorSeen(visitorId: number, threadId: number, upTo: number) {
    await this.ownThread(visitorId, threadId);
    const r = await this.db.query('UPDATE chat_threads SET visitor_read_id=GREATEST(visitor_read_id, $2) WHERE id=$1 RETURNING visitor_read_id', [threadId, Math.floor(upTo) || 0]);
    bus.chat({ threadId, type: 'seen', by: 'visitor', upTo: Number(r.rows[0]?.visitor_read_id ?? 0) });
  }

  async visitorTyping(visitorId: number, threadId: number) {
    await this.ownThread(visitorId, threadId);
    bus.chat({ threadId, type: 'typing', who: 'visitor' });
  }

  async visitorClose(visitorId: number, threadId: number) {
    const t = await this.ownThread(visitorId, threadId);
    if (t.status === 'CLOSED') return;
    await this.db.query(`UPDATE chat_threads SET status='CLOSED', closed_at=now(), closed_by=NULL, updated_at=now() WHERE id=$1`, [threadId]);
    await this.addMessage(threadId, 'SYSTEM', 'ended', null, null);
  }

  async rateThread(visitorId: number, threadId: number, rating: 'UP' | 'DOWN') {
    const t = await this.ownThread(visitorId, threadId);
    if (rating !== 'UP' && rating !== 'DOWN') throw new ChatError('Pick a rating.');
    await this.db.query('UPDATE chat_threads SET rating=$2, rated_at=now(), rated_staff=assigned_to WHERE id=$1', [t.id, rating]);
    bus.chat({ threadId, type: 'thread' });
  }

  async file(fileId: number, opts: { visitorId?: number; staff?: boolean }) {
    const f = (await this.db.query(
      `SELECT f.*, t.visitor_id FROM chat_files f JOIN chat_threads t ON t.id=f.thread_id WHERE f.id=$1`, [fileId])).rows[0];
    if (!f || (!opts.staff && Number(f.visitor_id) !== opts.visitorId)) throw new ChatError('File not found.', 404);
    return { name: f.name as string, mime: f.mime as string, bytes: f.bytes as Buffer };
  }

  // ---------------------------------------------------------------------------------------------
  // The team
  // ---------------------------------------------------------------------------------------------
  async list(staffId: string, f: { view?: string; q?: string }) {
    const args: unknown[] = [staffId];
    const where: string[] = [];
    const view = f.view ?? 'open';
    if (view === 'closed') where.push(`t.status='CLOSED'`); else where.push(`t.status='OPEN'`);
    if (view === 'mine') where.push(`t.assigned_to=$1`);
    if (view === 'unassigned') where.push(`t.assigned_to IS NULL`);
    if (f.q?.trim()) {
      args.push(`%${f.q.trim().replace(/[%_]/g, '')}%`);
      where.push(`(v.name ILIKE $2 OR v.phone ILIKE $2 OR t.ref ILIKE $2 OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND m.body ILIKE $2))`);
    }
    const r = await this.db.query(
      `SELECT t.id, t.ref, t.status, t.updated_at, t.created_at, t.assigned_to, t.rating, v.name, v.phone, v.user_id, s.name AS staff_name,
              (SELECT row_to_json(x) FROM (SELECT m.kind, m.body, m.file_id, m.staff_name, m.created_at FROM chat_messages m WHERE m.thread_id=t.id AND m.kind IN ('VISITOR','STAFF') ORDER BY m.id DESC LIMIT 1) x) AS last,
              (SELECT count(*)::int FROM chat_messages m WHERE m.thread_id=t.id AND m.kind='VISITOR' AND m.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.thread_id=t.id AND r.staff_id=$1), 0)) AS unread
       FROM chat_threads t JOIN chat_visitors v ON v.id=t.visitor_id LEFT JOIN staff s ON s.id=t.assigned_to
       WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC LIMIT 100`, args);
    return r.rows.map((t) => ({
      id: Number(t.id), ref: t.ref, status: t.status, updatedAt: t.updated_at, createdAt: t.created_at,
      name: t.name, phone: localPhone(t.phone), userId: t.user_id, assignedTo: t.assigned_to, assignedName: t.staff_name, rating: t.rating,
      unread: t.unread, viewers: this.viewersOf(Number(t.id)),
      last: t.last ? { kind: t.last.kind, text: t.last.body || (t.last.file_id ? 'Sent a file' : ''), by: t.last.staff_name ?? null, at: t.last.created_at } : null,
    }));
  }

  async counts(staffId: string, canLive: boolean, canWhatsApp: boolean) {
    const live = canLive ? (await this.db.query(
      `SELECT count(*)::int AS chats, COALESCE(sum(n),0)::int AS messages FROM (
         SELECT (SELECT count(*) FROM chat_messages m WHERE m.thread_id=t.id AND m.kind='VISITOR'
                   AND m.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.thread_id=t.id AND r.staff_id=$1), 0)) AS n
         FROM chat_threads t WHERE t.status='OPEN' AND (t.assigned_to IS NULL OR t.assigned_to=$1)) x WHERE n > 0`, [staffId])).rows[0] : { chats: 0, messages: 0 };
    const wa = canWhatsApp ? (await this.db.query(
      `SELECT count(*)::int AS n FROM support_requests s WHERE s.status='OPEN' AND NOT EXISTS (SELECT 1 FROM support_reads r WHERE r.request_id=s.id AND r.staff_id=$1)`, [staffId])).rows[0].n : 0;
    return { live: live.chats, liveMessages: live.messages, whatsapp: wa, total: live.messages + wa };
  }

  async thread(staffId: string, id: number) {
    const t = (await this.db.query(
      `SELECT t.*, v.name, v.phone, v.user_id, s.name AS staff_name, rs.name AS rated_staff_name,
              (SELECT count(*)::int FROM chat_threads o WHERE o.visitor_id=t.visitor_id) AS chats,
              (SELECT count(*)::int FROM deals d WHERE v.user_id IS NOT NULL AND (d.buyer_id=v.user_id OR d.seller_id=v.user_id)) AS orders
       FROM chat_threads t JOIN chat_visitors v ON v.id=t.visitor_id LEFT JOIN staff s ON s.id=t.assigned_to LEFT JOIN staff rs ON rs.id=t.rated_staff WHERE t.id=$1`, [id])).rows[0];
    if (!t) throw new ChatError('Chat not found.', 404);
    const msgs = (await this.db.query(`${MSG_SQL} WHERE m.thread_id=$1 ORDER BY m.id`, [id])).rows;
    return {
      id: Number(t.id), ref: t.ref, status: t.status, createdAt: t.created_at, sourcePage: t.source_page,
      visitor: { name: t.name, phone: localPhone(t.phone), userId: t.user_id, chats: t.chats, orders: t.orders, online: (this.online.get(Number(t.visitor_id)) ?? 0) > 0 },
      assignedTo: t.assigned_to, assignedName: t.staff_name, mine: t.assigned_to === staffId,
      rating: t.rating, ratedStaff: t.rated_staff_name, visitorReadUpTo: Number(t.visitor_read_id), waNotifiedAt: t.wa_notified_at,
      viewers: this.viewersOf(id), messages: msgs.map((m) => messageOut(m, true)),
    };
  }

  /** A rep's reply. The first reply takes the chat; someone else's chat must be taken over first. */
  async reply(staff: ChatStaff, id: number, text: string) {
    const body = cleanText(text);
    if (!body) throw new ChatError('Type a reply.');
    const t = await this.claimForReply(staff, id);
    if (t.status === 'CLOSED') await this.reopen(id, staff);
    const m = await this.addMessage(id, 'STAFF', body, staff, null);
    await this.markRead(staff.id, id, m);
  }

  async staffFile(staff: ChatStaff, id: number, name: string, bytes: Buffer) {
    const t = await this.claimForReply(staff, id);
    if (t.status === 'CLOSED') await this.reopen(id, staff);
    const fileId = await this.saveFile(id, name, bytes);
    const m = await this.addMessage(id, 'STAFF', '', staff, fileId);
    await this.markRead(staff.id, id, m);
  }

  async note(staff: ChatStaff, id: number, text: string) {
    const body = cleanText(text);
    if (!body) throw new ChatError('Type a note.');
    await this.exists(id);
    await this.addMessage(id, 'NOTE', body, staff, null);
  }

  private async claimForReply(staff: ChatStaff, id: number) {
    const t = await this.exists(id);
    if (t.assigned_to && t.assigned_to !== staff.id) {
      const who = (await this.db.query('SELECT name FROM staff WHERE id=$1', [t.assigned_to])).rows[0]?.name ?? 'Someone';
      throw new ChatError(`${firstName(who)} is handling this chat. Take it over first.`, 409);
    }
    if (!t.assigned_to) await this.assign(staff, id);
    return t;
  }

  /** Takes the chat (or takes it over). The visitor sees "Chioma joined the chat". */
  async assign(staff: ChatStaff, id: number) {
    const t = await this.exists(id);
    if (t.assigned_to === staff.id) return;
    await this.db.query('UPDATE chat_threads SET assigned_to=$2, assigned_at=now(), updated_at=now() WHERE id=$1', [id, staff.id]);
    await this.addMessage(id, 'SYSTEM', 'joined', staff, null);
  }

  async close(staff: ChatStaff, id: number) {
    const t = await this.exists(id);
    if (t.status === 'CLOSED') return;
    await this.db.query(`UPDATE chat_threads SET status='CLOSED', closed_at=now(), closed_by=$2, updated_at=now() WHERE id=$1`, [id, staff.id]);
    await this.addMessage(id, 'SYSTEM', 'closed', staff, null);
  }

  async reopen(id: number, staff: ChatStaff | null) {
    await this.db.query(`UPDATE chat_threads SET status='OPEN', closed_at=NULL, closed_by=NULL, updated_at=now() WHERE id=$1`, [id]);
    await this.addMessage(id, 'SYSTEM', 'reopened', staff, null);
  }

  async markRead(staffId: string, id: number, upTo?: number) {
    const max = upTo ?? Number((await this.db.query('SELECT COALESCE(max(id),0) AS n FROM chat_messages WHERE thread_id=$1', [id])).rows[0].n);
    await this.db.query(
      `INSERT INTO chat_reads (staff_id, thread_id, last_read_id) VALUES ($1,$2,$3)
       ON CONFLICT (staff_id, thread_id) DO UPDATE SET last_read_id=GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`, [staffId, id, max]);
    bus.chat({ threadId: id, type: 'seen', by: 'staff', upTo: await this.staffReadUpTo(id) });
  }

  typing(staff: ChatStaff, id: number) { bus.chat({ threadId: id, type: 'typing', who: 'staff', name: firstName(staff.name), staffId: staff.id }); }

  /** "Emeka is here": who has the chat open in the console (refreshed every 20 seconds while it's open). */
  view(staff: ChatStaff, id: number, on: boolean) {
    const m = this.viewing.get(id) ?? new Map();
    const before = [...m.keys()].sort().join();
    if (on) m.set(staff.id, { name: staff.name, until: Date.now() + 45_000 }); else m.delete(staff.id);
    this.viewing.set(id, m);
    const now = this.viewersOf(id);
    if (now.map((v) => v.id).sort().join() !== before) bus.chat({ threadId: id, type: 'viewers', viewers: now });
  }
  viewersOf(id: number) {
    const m = this.viewing.get(id);
    if (!m) return [];
    for (const [k, v] of m) if (v.until < Date.now()) m.delete(k);
    return [...m.entries()].map(([sid, v]) => ({ id: sid, name: v.name }));
  }

  // ---------------------------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------------------------
  private async exists(id: number) {
    const t = (await this.db.query('SELECT * FROM chat_threads WHERE id=$1', [id])).rows[0];
    if (!t) throw new ChatError('Chat not found.', 404);
    return t;
  }

  private async saveFile(threadId: number, name: string, bytes: Buffer): Promise<number> {
    if (!bytes?.length) throw new ChatError('That file is empty.');
    if (bytes.length > CHAT_MAX_FILE) throw new ChatError('Files can be up to 10 MB.', 413);
    const mime = sniffFile(bytes);
    if (!mime) throw new ChatError('Send a photo (JPG, PNG or WebP) or a PDF.', 415);
    const r = await this.db.query('INSERT INTO chat_files (thread_id, name, mime, size, bytes) VALUES ($1,$2,$3,$4,$5) RETURNING id', [threadId, cleanName(name, mime), mime, bytes.length, bytes]);
    return Number(r.rows[0].id);
  }

  private async addMessage(threadId: number, kind: 'VISITOR' | 'STAFF' | 'NOTE' | 'SYSTEM', body: string, staff: ChatStaff | null, fileId: number | null): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO chat_messages (thread_id, kind, staff_id, staff_name, body, file_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [threadId, kind, staff?.id ?? null, staff?.name ?? null, body, fileId]);
    const id = Number(r.rows[0].id);
    const touch = kind === 'VISITOR' ? ', last_visitor_at=now()' : kind === 'STAFF' ? ', last_staff_at=now()' : '';
    await this.db.query(`UPDATE chat_threads SET updated_at=now()${touch} WHERE id=$1`, [threadId]);
    const m = (await this.db.query(`${MSG_SQL} WHERE m.id=$1`, [id])).rows[0];
    bus.chat({ threadId, type: 'message', message: messageOut(m, true) });
    return id;
  }

  /** Every 30 seconds: tell visitors who left about a rep's reply (once), and delete closed chats after 12 months. */
  async sweep(): Promise<{ notified: number; deleted: number }> {
    let notified = 0;
    const m = this.o.messenger;
    const tpl = DEAL_TEMPLATES.liveChatReply.name;
    if (m && m.canUseTemplate(tpl)) {
      const due = (await this.db.query(
        `SELECT t.id, t.visitor_id, t.resume_code, t.visitor_read_id, v.name, v.phone,
                (SELECT row_to_json(x) FROM (SELECT id, body, file_id FROM chat_messages WHERE thread_id=t.id AND kind='STAFF' ORDER BY id DESC LIMIT 1) x) AS last
         FROM chat_threads t JOIN chat_visitors v ON v.id=t.visitor_id
         WHERE t.last_staff_at < now() - make_interval(mins => $1) AND t.last_staff_at > now() - interval '3 days'
           AND (t.wa_notified_at IS NULL OR t.wa_notified_at < COALESCE(t.last_visitor_at, t.created_at))
         LIMIT 20`, [NOTIFY_AFTER_MINUTES])).rows;
      for (const t of due) {
        if (!t.last || Number(t.last.id) <= Number(t.visitor_read_id)) continue; // already seen
        if ((this.online.get(Number(t.visitor_id)) ?? 0) > 0) continue;            // still on the page
        const snippet = (t.last.body || 'Sent you a file').replace(/\s+/g, ' ').slice(0, 110) + ((t.last.body ?? '').length > 110 ? '…' : '');
        const link = `${this.o.siteUrl.replace(/\/$/, '')}/contact/?chat=${t.resume_code}`;
        const status = await m.sendTemplate(t.phone, dealTemplate('liveChatReply', [firstName(t.name) || 'there', snippet, link]));
        if (status === 'SENT' || status === 'DRY_RUN') {
          await this.db.query('UPDATE chat_threads SET wa_notified_at=now() WHERE id=$1', [t.id]);
          await this.addMessage(Number(t.id), 'SYSTEM', 'whatsapp', null, null);
          notified++;
        }
      }
    }
    const del = await this.db.query(`DELETE FROM chat_threads WHERE status='CLOSED' AND COALESCE(closed_at, updated_at) < now() - interval '12 months'`);
    await this.db.query(`DELETE FROM chat_visitors v WHERE v.created_at < now() - interval '12 months' AND NOT EXISTS (SELECT 1 FROM chat_threads t WHERE t.visitor_id=v.id)`);
    return { notified, deleted: del.rowCount ?? 0 };
  }
}
