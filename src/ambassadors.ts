import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { withTx, type Db, type Queryable, type Tx } from './db.js';
import { post } from './ledger.js';
import { formatMoney, type Currency } from './money.js';
import type { Settings } from './settings.js';
import type { Messenger, Outbound, Template } from './whatsapp/client.js';
import { ambTemplate } from './whatsapp/automation.js';

/**
 * THE AMBASSADOR PROGRAMME
 *
 * People Hoolam approves bring new sellers and buyers. They earn:
 *   - a SHARE: their % (Features → Ambassadors, or a custom % on their page) of everything Hoolam earns
 *     (Hoolam fee + transaction fee) on every completed order of a person they brought, for as long as they're active;
 *   - a BONUS: a fixed amount when a seller they brought completes their first few orders (3 by default).
 * Earnings are made the moment an order's money is released to the seller (the buyer is happy, or the time to
 * report a problem has passed). Anything that looks wrong (the ambassador is one side of the order, the person has
 * the same ID or bank account as the ambassador, or the buyer and seller look like one person) is held for the team.
 * Payouts are monthly (on the payout day, for the month before), from a minimum; the last one, when they end, is paid
 * whatever the amount. For now the team pays by bank transfer and marks it paid in the console.
 *
 * Money: each confirmed earning is posted in the ledger (expense:ambassadors → payable:ambassador); a payout moves
 * payable:ambassador → cash:bank. So the Money page always balances.
 */

export type AmbStatus = 'SETUP' | 'ACTIVE' | 'PAUSED' | 'ENDED';
export type Term = 3 | 6 | 12;
export interface Ambassador {
  user_id: string; status: AmbStatus; slug: string | null; area: string | null; term_months: Term | null; next_term_months: Term | null;
  term_started_at: Date | null; term_ends_at: Date | null; notice_for: Date | null; summary_month: string | Date | null;
  seller_pct: string | number | null; buyer_pct: string | number | null; photo_ok_at: Date | null;
  approved_at: Date; activated_at: Date | null; paused_at: Date | null; ended_at: Date | null; end_reason: string | null; application_id: number | null;
}
export interface Application {
  fullName: string; phone: string; email?: string | null; state?: string | null; city?: string | null; community?: string | null;
  knows?: string[]; channels?: string[]; handle?: string | null; reach?: string | null; sellsOnline?: boolean | null; why?: string | null;
}

export const AMB_KNOWS = { vendors: 'Online vendors / sellers', students: 'Students', traders: 'Market traders', shoppers: 'Shoppers', riders: 'Riders and dispatch' } as const;
export const AMB_CHANNELS = { status: 'WhatsApp status', groups: 'WhatsApp groups', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', facebook: 'Facebook', in_person: 'In person', flyers: 'Flyers' } as const;
export const AMB_REACH = { under_500: 'Under 500', '500_2000': '500 to 2,000', '2000_10000': '2,000 to 10,000', over_10000: 'Over 10,000' } as const;
export const NG_STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu',
  'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
  'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'] as const;

/** Link names: what the website and campaign links already use, plus words that would confuse people. */
const RESERVED = new Set(['about', 'contact', 'legal', 'v', 'assets', 'media', 's', 'l', 'a', 'go', 'api', 'console', 'admin', 'blog', 'guides', 'help',
  'faq', 'pricing', 'terms', 'privacy', 'cookies', 'sitemap', 'robots', 'llms', 'index', '404', 'pay', 'order', 'orders', 'app', 'login', 'signup',
  'hoolam', 'usehoolam', 'support', 'team', 'staff', 'official', 'ambassador', 'ambassadors', 'rep', 'reps', 'admin', 'owner', 'ceo', 'founder', 'bank', 'refund', 'refunds']);
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
export const tidyName = (s: string) => s.trim().toLowerCase().replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

export class AmbassadorError extends Error {}

// ---------- dates (Lagos time: UTC+1, no daylight saving) ----------
const LAGOS_MS = 60 * 60 * 1000;
/** "2026-10" for a moment, in Lagos time. */
export const monthKey = (d: Date = new Date()) => new Date(d.getTime() + LAGOS_MS).toISOString().slice(0, 7);
/** The first day of a month ("2026-10" → "2026-10-01"). */
export const monthStart = (key: string) => `${key}-01`;
export const monthLabel = (key: string) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const shiftMonth = (key: string, by: number) => { const [y, m] = key.split('-').map(Number); const t = new Date(Date.UTC(y!, m! - 1 + by, 15)); return t.toISOString().slice(0, 7); };
const lagosDay = (d: Date = new Date()) => new Date(d.getTime() + LAGOS_MS).getUTCDate();
const lagosLastDay = (d: Date = new Date()) => { const t = new Date(d.getTime() + LAGOS_MS); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate() === t.getUTCDate(); };
export function addMonths(d: Date, n: number): Date { const t = new Date(d); t.setUTCMonth(t.getUTCMonth() + n); return t; }
export const dayText = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
const keyOf = (v: string | Date) => typeof v === 'string' ? v.slice(0, 7) : monthKey(new Date(v.getTime() + 12 * 3600_000)); // DATE columns come back at local midnight

export interface Notice { phone: string; message: Outbound; fallback?: Template }

export interface AmbassadorsOptions {
  db: Db; settings: Settings; messenger: Messenger; currency: Currency;
  /** Count orders paid with pretend money (testing only), like trust cards. */
  countTest: boolean;
  /** hoolam.com and go.hoolam.com (for links and photos). */
  siteUrl: string; publicBaseUrl: string;
  /** Key for sign-in codes and session tokens. */
  secret: string;
  /** The website rebuilds (new or changed links). */
  onSiteChange?: () => void;
  log?: (l: string) => void;
}

export class Ambassadors {
  constructor(private readonly o: AmbassadorsOptions) {}

  get db() { return this.o.db; }
  cfg() { return this.o.settings.ambassadors(); }
  on(): boolean { return this.cfg().on; }
  money(minor: number) { return formatMoney(minor, this.o.currency); }
  linkUrl(slug: string) { return `${this.o.siteUrl.replace(/\/+$/, '')}/a/${slug}`; }
  linkText(slug: string) { return `${this.o.siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/a/${slug}`; }
  dashboardUrl() { return `${this.o.publicBaseUrl.replace(/\/+$/, '')}/ambassador`; }
  photoUrl(slug: string, version: string) { return `${this.o.publicBaseUrl.replace(/\/+$/, '')}/a/${slug}/photo.jpg?v=${version}`; }
  private changed() { try { this.o.onSiteChange?.(); } catch { /* the site rebuilds later */ } }
  private async send(n: Notice) {
    try { await this.o.messenger.send(n.phone, n.message, n.fallback); } catch (e) { this.o.log?.(`ambassador message failed: ${(e as Error).message}`); }
  }

  // ===================================================================================================
  // Applications
  // ===================================================================================================

  /** Checks and saves an application (website or WhatsApp). One open application per number. */
  async apply(a: Application, source: 'website' | 'whatsapp', userId: string | null = null): Promise<{ id: number; already: boolean }> {
    const name = String(a.fullName ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 3 || name.length > 80 || !/\p{L}/u.test(name)) throw new AmbassadorError('Please enter your full name.');
    const phone = normPhone(a.phone);
    if (!phone) throw new AmbassadorError('Enter your WhatsApp number, like 08031234567.');
    const email = a.email ? String(a.email).trim().toLowerCase() : null;
    if (email && !/^[^\s@<>"]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) throw new AmbassadorError('That email doesn\'t look right. Check it, or leave it empty.');
    const state = a.state && (NG_STATES as readonly string[]).includes(a.state) ? a.state : null;
    if (!state) throw new AmbassadorError('Choose your state.');
    const city = clip(a.city, 60);
    if (!city) throw new AmbassadorError('Enter your city or area.');
    const knows = (a.knows ?? []).filter((k) => k in AMB_KNOWS);
    const channels = (a.channels ?? []).filter((k) => k in AMB_CHANNELS);
    if (!knows.length) throw new AmbassadorError('Tick who you know well.');
    if (!channels.length) throw new AmbassadorError('Tick where you\'ll share Hoolam.');
    const reach = a.reach && a.reach in AMB_REACH ? a.reach : null;
    if (!reach) throw new AmbassadorError('Choose roughly how many people you reach.');
    const existing = await this.o.db.query(`SELECT id FROM ambassador_applications WHERE phone=$1 AND status='PENDING' ORDER BY id DESC LIMIT 1`, [phone]);
    if (existing.rows[0]) return { id: Number(existing.rows[0].id), already: true };
    const amb = await this.o.db.query(`SELECT a.status FROM ambassadors a JOIN users u ON u.id=a.user_id WHERE u.phone=$1`, [phone]);
    if (amb.rows[0] && amb.rows[0].status !== 'ENDED') throw new AmbassadorError('This number is already a Hoolam ambassador. Open Ambassador in the WhatsApp menu.');
    const uid = userId ?? (await this.o.db.query('SELECT id FROM users WHERE phone=$1', [phone])).rows[0]?.id ?? null;
    const r = await this.o.db.query(
      `INSERT INTO ambassador_applications (user_id, phone, full_name, email, state, city, community, knows, channels, handle, reach, sells_online, why, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [uid, phone, name, email, state, city, clip(a.community, 80), knows, channels, clip(a.handle, 60), reach, a.sellsOnline ?? null, clip(a.why, 600), source]);
    return { id: Number(r.rows[0].id), already: false };
  }

  async applications(status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'ALL' = 'PENDING', limit = 200) {
    const r = await this.o.db.query(
      `SELECT a.*, s.name AS decided_by_name, u.id AS uid,
         (SELECT count(*) FROM deals d WHERE (d.seller_id=u.id OR d.buyer_id=u.id) AND d.status='COMPLETED')::int AS completed_orders
       FROM ambassador_applications a LEFT JOIN staff s ON s.id=a.decided_by LEFT JOIN users u ON u.phone=a.phone
       ${status === 'ALL' ? '' : 'WHERE a.status=$2'} ORDER BY a.created_at DESC LIMIT $1`, status === 'ALL' ? [limit] : [limit, status]);
    return r.rows.map((x) => ({
      id: Number(x.id), userId: x.uid ?? null, phone: x.phone, name: x.full_name, email: x.email, state: x.state, city: x.city, community: x.community,
      knows: x.knows ?? [], channels: x.channels ?? [], handle: x.handle, reach: x.reach, sellsOnline: x.sells_online, why: x.why, source: x.source,
      status: x.status, note: x.decision_note, decidedBy: x.decided_by_name, decidedAt: x.decided_at, createdAt: x.created_at, completedOrders: x.completed_orders ?? 0,
    }));
  }

  /** Approves an application: they become an ambassador in SETUP and get a WhatsApp message to finish setting up. */
  async approve(appId: number, staffId: string | null, note: string | null = null): Promise<{ userId: string }> {
    const userId = await withTx(this.o.db, async (tx) => {
      const a = (await tx.query('SELECT * FROM ambassador_applications WHERE id=$1 FOR UPDATE', [appId])).rows[0];
      if (!a) throw new AmbassadorError('Application not found');
      if (a.status !== 'PENDING') throw new AmbassadorError('This application was already decided');
      const u = await upsertUserTx(tx, a.phone, a.full_name);
      const cur = (await tx.query('SELECT status FROM ambassadors WHERE user_id=$1', [u])).rows[0];
      if (cur && cur.status !== 'ENDED') throw new AmbassadorError('They are already an ambassador');
      await tx.query(`UPDATE ambassador_applications SET status='APPROVED', decision_note=$2, decided_by=$3, decided_at=now(), user_id=$4 WHERE id=$1`, [appId, clip(note, 300), staffId, u]);
      const area = clip(a.community, 40) ?? clip(a.city, 40);
      await tx.query(
        `INSERT INTO ambassadors (user_id, application_id, status, area, approved_by) VALUES ($1,$2,'SETUP',$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET application_id=$2, status='SETUP', area=$3, approved_by=$4, approved_at=now(), ended_at=NULL, end_reason=NULL,
           paused_at=NULL, term_months=NULL, next_term_months=NULL, term_started_at=NULL, term_ends_at=NULL, notice_for=NULL, activated_at=NULL`,
        [u, appId, area, staffId]);
      return u as string;
    });
    const a = (await this.o.db.query('SELECT phone, full_name, source FROM ambassador_applications WHERE id=$1', [appId])).rows[0];
    const first = firstOf(a.full_name);
    await this.send({ phone: a.phone, message: amsg.approved(first, a.source === 'invite'), fallback: ambTemplate(a.source === 'invite' ? 'invited' : 'approved', [first], ['amb:setup']) });
    return { userId };
  }

  async decline(appId: number, staffId: string | null, note: string | null): Promise<void> {
    const r = await this.o.db.query(
      `UPDATE ambassador_applications SET status='DECLINED', decision_note=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='PENDING' RETURNING phone, full_name`,
      [appId, clip(note, 300), staffId]);
    if (!r.rows[0]) throw new AmbassadorError('This application was already decided');
    await this.send({ phone: r.rows[0].phone, message: amsg.declined(firstOf(r.rows[0].full_name)) });
  }

  /** "Invite someone" from the console: approved straight away. */
  async invite(input: { phone: string; name: string; city?: string | null }, staffId: string | null): Promise<{ userId: string }> {
    const phone = normPhone(input.phone);
    if (!phone) throw new AmbassadorError('Enter their WhatsApp number, like 08031234567.');
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2) throw new AmbassadorError('Enter their name.');
    const amb = await this.o.db.query(`SELECT a.status FROM ambassadors a JOIN users u ON u.id=a.user_id WHERE u.phone=$1`, [phone]);
    if (amb.rows[0] && amb.rows[0].status !== 'ENDED') throw new AmbassadorError('This number is already an ambassador');
    await this.o.db.query(`UPDATE ambassador_applications SET status='DECLINED', decision_note='Replaced by an invite', decided_by=$2, decided_at=now() WHERE phone=$1 AND status='PENDING'`, [phone, staffId]);
    const r = await this.o.db.query(
      `INSERT INTO ambassador_applications (phone, full_name, city, source) VALUES ($1,$2,$3,'invite') RETURNING id`, [phone, name.slice(0, 80), clip(input.city, 60)]);
    return this.approve(Number(r.rows[0].id), staffId, 'Invited by the team');
  }

  // ===================================================================================================
  // Status, menu and setup
  // ===================================================================================================

  async get(userId: string, q: Queryable = this.o.db): Promise<Ambassador | null> {
    return (await q.query('SELECT * FROM ambassadors WHERE user_id=$1', [userId])).rows[0] ?? null;
  }

  /** Where someone stands, for the menu and the Ambassador screen. */
  async standing(userId: string): Promise<{ kind: 'none' | 'pending' | 'declined' | 'setup' | 'active' | 'paused' | 'ended'; amb: Ambassador | null }> {
    const amb = await this.get(userId);
    if (amb && amb.status !== 'ENDED') return { kind: amb.status === 'SETUP' ? 'setup' : amb.status === 'ACTIVE' ? 'active' : 'paused', amb };
    const app = (await this.o.db.query(
      `SELECT a.status, a.created_at FROM ambassador_applications a JOIN users u ON u.phone=a.phone WHERE u.id=$1 ORDER BY a.id DESC LIMIT 1`, [userId])).rows[0];
    if (app?.status === 'PENDING') return { kind: 'pending', amb };
    if (amb?.status === 'ENDED') return { kind: 'ended', amb };
    if (app?.status === 'DECLINED' && Date.now() - new Date(app.created_at).getTime() < 30 * 86400_000) return { kind: 'declined', amb };
    return { kind: 'none', amb };
  }

  /** The last row of the WhatsApp menu, or null when it shouldn't show for this person. */
  async menuRow(user: { id: string }): Promise<{ id: string; title: string; description: string } | null> {
    if (!this.on()) return null;
    const st = await this.standing(user.id);
    if (st.kind === 'none' || st.kind === 'declined') {
      if (!this.cfg().applyWhatsApp && !this.cfg().applyWeb) return null;
      const done = Number((await this.o.db.query(`SELECT count(*) AS n FROM deals WHERE (seller_id=$1 OR buyer_id=$1) AND status='COMPLETED'`, [user.id])).rows[0].n);
      if (done < this.cfg().menuAfter) return null;
      return { id: 'menu:amb', title: '🤝 Become an ambassador', description: 'Earn from sellers and buyers you bring' };
    }
    const description = { pending: 'Your application is being reviewed', setup: 'Finish setting up', active: 'Your earnings, link and term', paused: 'Your earnings and payouts', ended: 'Your earnings and payouts' }[st.kind];
    return { id: 'menu:amb', title: '🤝 Ambassador', description };
  }

  /** The next setup step: ID check, bank account, term, link name (the photo is optional, asked after the name). */
  async setupStep(userId: string): Promise<'kyc' | 'bank' | 'term' | 'name' | 'done'> {
    const u = (await this.o.db.query(`SELECT kyc_status, kyc_verified_at FROM users WHERE id=$1`, [userId])).rows[0];
    if (!(u?.kyc_status === 'VERIFIED' && u.kyc_verified_at)) return 'kyc';
    const bank = (await this.o.db.query('SELECT 1 FROM bank_accounts WHERE user_id=$1 AND is_default LIMIT 1', [userId])).rowCount;
    if (!bank) return 'bank';
    const a = await this.get(userId);
    if (!a?.term_months) return 'term';
    if (!a.slug) return 'name';
    return 'done';
  }

  async setTerm(userId: string, months: number): Promise<void> {
    if (!(this.cfg().terms as number[]).includes(months)) throw new AmbassadorError('Choose 3, 6 or 12 months.');
    const a = await this.get(userId);
    if (!a || a.status === 'ENDED') throw new AmbassadorError('Not an ambassador');
    if (a.status === 'SETUP' || !a.term_months) await this.o.db.query('UPDATE ambassadors SET term_months=$2 WHERE user_id=$1', [userId, months]);
    else await this.o.db.query('UPDATE ambassadors SET next_term_months=$2 WHERE user_id=$1', [userId, months === a.term_months ? null : months]);
  }

  /** Is this link name free? Returns the tidied name, or the reason it can't be used. */
  async checkName(raw: string, userId?: string): Promise<{ ok: true; slug: string } | { ok: false; why: string }> {
    const slug = tidyName(raw);
    if (slug.length < 3) return { ok: false, why: 'Use at least 3 letters or numbers, like tobi or tobi-unilag.' };
    if (slug.length > 30) return { ok: false, why: 'Keep it under 30 letters.' };
    if (!NAME_RE.test(slug)) return { ok: false, why: 'Use letters, numbers and dashes only, like tobi-unilag.' };
    if (RESERVED.has(slug)) return { ok: false, why: `"${slug}" is reserved. Try another name.` };
    const taken = (await this.o.db.query('SELECT user_id FROM ambassador_names WHERE slug=$1', [slug])).rows[0];
    if (taken && taken.user_id !== userId) return { ok: false, why: `hoolam.com/a/${slug} is taken. Try another, like ${slug}-${randomInt(2, 99)}.` };
    const link = (await this.o.db.query('SELECT 1 FROM campaign_links WHERE slug=$1', [slug])).rowCount;
    if (link) return { ok: false, why: `"${slug}" is already used by Hoolam. Try another name.` };
    return { ok: true, slug };
  }

  /** Gives them a link name (setup), or changes it (the console): the old one stays reserved and keeps working. */
  async claimName(userId: string, raw: string): Promise<string> {
    const c = await this.checkName(raw, userId);
    if (!c.ok) throw new AmbassadorError(c.why);
    await withTx(this.o.db, async (tx) => {
      await tx.query('INSERT INTO ambassador_names (slug, user_id) VALUES ($1,$2) ON CONFLICT (slug) DO NOTHING', [c.slug, userId]);
      const owner = (await tx.query('SELECT user_id FROM ambassador_names WHERE slug=$1', [c.slug])).rows[0];
      if (owner?.user_id !== userId) throw new AmbassadorError('That name was just taken. Try another.');
      await tx.query('UPDATE ambassadors SET slug=$2 WHERE user_id=$1', [userId, c.slug]);
    });
    this.changed();
    return c.slug;
  }

  /** Becomes ACTIVE once every step is done: the term starts now. */
  async activateIfReady(userId: string): Promise<boolean> {
    if ((await this.setupStep(userId)) !== 'done') return false;
    const r = await this.o.db.query(
      `UPDATE ambassadors SET status='ACTIVE', activated_at=now(), term_started_at=now(), term_ends_at=now() + make_interval(months => term_months)
       WHERE user_id=$1 AND status='SETUP' RETURNING slug`, [userId]);
    if (r.rows[0]) this.changed();
    return !!r.rows[0];
  }

  async setPhoto(userId: string, bytes: Buffer): Promise<string> {
    let jpg: Buffer;
    try { jpg = await sharp(bytes).rotate().resize(800, 800, { fit: 'cover', position: 'attention' }).jpeg({ quality: 84, mozjpeg: true }).toBuffer(); }
    catch { throw new AmbassadorError('That file isn\'t a photo we can use. Send a JPG or PNG.'); }
    const sha = createHash('sha256').update(jpg).digest('hex');
    await this.o.db.query(
      `INSERT INTO ambassador_photos (user_id, mime, bytes, sha256) VALUES ($1,'image/jpeg',$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET mime='image/jpeg', bytes=$2, sha256=$3, updated_at=now()`, [userId, jpg, sha]);
    await this.o.db.query('UPDATE ambassadors SET photo_ok_at=COALESCE(photo_ok_at, now()) WHERE user_id=$1', [userId]);
    this.changed();
    return sha.slice(0, 12);
  }
  async removePhoto(userId: string, byStaff: boolean): Promise<void> {
    const r = await this.o.db.query('DELETE FROM ambassador_photos WHERE user_id=$1 RETURNING user_id', [userId]);
    if (!r.rowCount) return;
    this.changed();
    if (byStaff) {
      const p = (await this.o.db.query('SELECT phone FROM users WHERE id=$1', [userId])).rows[0];
      if (p) await this.send({ phone: p.phone, message: amsg.photoRemoved() });
    }
  }
  async photo(slugOrUser: { slug?: string; userId?: string }): Promise<{ bytes: Buffer; version: string } | null> {
    const r = slugOrUser.userId
      ? await this.o.db.query('SELECT bytes, sha256 FROM ambassador_photos WHERE user_id=$1', [slugOrUser.userId])
      : await this.o.db.query('SELECT p.bytes, p.sha256 FROM ambassador_photos p JOIN ambassador_names n ON n.user_id=p.user_id WHERE n.slug=$1', [slugOrUser.slug]);
    return r.rows[0] ? { bytes: r.rows[0].bytes, version: String(r.rows[0].sha256).slice(0, 12) } : null;
  }

  // ===================================================================================================
  // Who brought whom
  // ===================================================================================================

  /** The ambassador behind a link name (current or an older one), if they're active. */
  async bySlug(raw: string): Promise<{ userId: string; slug: string; firstName: string; phone: string } | null> {
    const slug = tidyName(raw);
    if (!slug) return null;
    const r = await this.o.db.query(
      `SELECT a.user_id, a.slug, u.display_name, u.kyc_name, u.phone FROM ambassador_names n JOIN ambassadors a ON a.user_id=n.user_id JOIN users u ON u.id=a.user_id
       WHERE n.slug=$1 AND a.status='ACTIVE'`, [slug]);
    const x = r.rows[0];
    return x ? { userId: x.user_id, slug: x.slug, firstName: firstOf(x.kyc_name ?? x.display_name) || x.slug, phone: x.phone } : null;
  }

  /** Is this person new to Hoolam (no orders at all, nobody linked yet, not an ambassador)? */
  async isNew(userId: string): Promise<boolean> {
    const r = await this.o.db.query(
      `SELECT (SELECT count(*) FROM deals WHERE seller_id=$1 OR buyer_id=$1)::int AS deals,
              (SELECT count(*) FROM ambassador_referrals WHERE referred_id=$1)::int AS linked,
              (SELECT count(*) FROM ambassadors WHERE user_id=$1)::int AS amb`, [userId]);
    const x = r.rows[0];
    return x.deals === 0 && x.linked === 0 && x.amb === 0;
  }

  /**
   * Links a new person to the ambassador whose link or code they used. First come, for good, one level only.
   * The ambassador hears "someone joined" (never who, or their number).
   */
  async attribute(user: { id: string; phone: string }, raw: string, via: 'link' | 'code' | 'team'): Promise<'ok' | 'unknown' | 'self' | 'not-new' | 'off'> {
    if (!this.on() && via !== 'team') return 'off';
    const a = await this.bySlug(raw);
    if (!a) return 'unknown';
    if (a.userId === user.id || a.phone === user.phone) return 'self';
    if (!(await this.isNew(user.id))) return 'not-new';
    const r = await this.o.db.query(
      `INSERT INTO ambassador_referrals (referred_id, ambassador_id, via, slug) VALUES ($1,$2,$3,$4) ON CONFLICT (referred_id) DO NOTHING RETURNING referred_id`,
      [user.id, a.userId, via, a.slug]);
    if (!r.rowCount) return 'not-new';
    await this.send({ phone: a.phone, message: amsg.joined(), fallback: ambTemplate('update', ['someone new joined Hoolam with your link.'], ['menu:amb']) });
    return 'ok';
  }

  /** Should we ask "Did an ambassador send you?" (once, before their first order)? */
  async shouldAsk(userId: string): Promise<boolean> {
    if (!this.on()) return false;
    const asked = (await this.o.db.query('SELECT amb_asked_at FROM users WHERE id=$1', [userId])).rows[0]?.amb_asked_at;
    if (asked) return false;
    if (!(await this.isNew(userId))) return false;
    return Number((await this.o.db.query(`SELECT count(*) AS n FROM ambassadors WHERE status='ACTIVE'`)).rows[0].n) > 0;
  }
  async markAsked(userId: string) { await this.o.db.query('UPDATE users SET amb_asked_at=now() WHERE id=$1 AND amb_asked_at IS NULL', [userId]); }

  // ===================================================================================================
  // Earnings (called inside the order's release transaction)
  // ===================================================================================================

  /** The % an ambassador earns on a side: their custom one, else the default. */
  pctFor(a: Pick<Ambassador, 'seller_pct' | 'buyer_pct'>, side: 'SELLER' | 'BUYER'): number {
    const custom = side === 'SELLER' ? a.seller_pct : a.buyer_pct;
    return custom != null ? Number(custom) : side === 'SELLER' ? this.cfg().sellerPct : this.cfg().buyerPct;
  }

  /**
   * An order's money was released to the seller: Hoolam earned `revenueMinor` on it. Records the share for the
   * ambassador of the seller and of the buyer (if any), and the seller bonus when it's due. Returns WhatsApp messages
   * to send once the transaction commits.
   */
  async onRelease(tx: Tx, deal: { id: string; code: string; seller_id: string | null; buyer_id: string | null; is_test?: boolean; currency: Currency }, revenueMinor: number): Promise<Notice[]> {
    if (deal.is_test && !this.o.countTest) return [];
    const out: Notice[] = [];
    const month = monthStart(monthKey());
    for (const side of ['SELLER', 'BUYER'] as const) {
      const referredId = side === 'SELLER' ? deal.seller_id : deal.buyer_id;
      if (!referredId) continue;
      const ref = (await tx.query(
        `SELECT r.*, a.status, a.seller_pct, a.buyer_pct, u.phone AS amb_phone FROM ambassador_referrals r JOIN ambassadors a ON a.user_id=r.ambassador_id
         JOIN users u ON u.id=a.user_id WHERE r.referred_id=$1`, [referredId])).rows[0];
      if (!ref || ref.status !== 'ACTIVE') continue;
      const hold = await this.holdReason(tx, ref.ambassador_id, referredId, deal);
      const pct = this.pctFor(ref, side);
      const amount = Math.floor((revenueMinor * pct) / 100);
      if (revenueMinor > 0 && amount > 0) {
        const ins = await tx.query(
          `INSERT INTO ambassador_earnings (ambassador_id, kind, referred_id, side, deal_id, revenue_minor, percent, amount_minor, currency, month, status, hold_reason)
           VALUES ($1,'SHARE',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
          [ref.ambassador_id, referredId, side, deal.id, revenueMinor, pct, amount, deal.currency, month, hold ? 'HELD' : 'CONFIRMED', hold]);
        if (ins.rowCount && !hold) await this.book(tx, deal.id, deal.currency, amount, `Ambassador share on ${deal.code}`);
      }
      // the seller bonus: once, when a seller they brought completes their Nth order
      if (side === 'SELLER' && !ref.bonus_at && this.cfg().bonusMinor > 0) {
        const done = Number((await tx.query(
          `SELECT count(*) AS n FROM deals WHERE seller_id=$1 AND buyer_id IS NOT NULL AND buyer_id<>seller_id AND ($2 OR NOT is_test)
             AND (status IN ('RELEASING','PAYOUT_PENDING','COMPLETED') OR id=$3)`, [referredId, this.o.countTest, deal.id])).rows[0].n);
        if (done >= this.cfg().bonusOrders) {
          await tx.query('UPDATE ambassador_referrals SET bonus_at=now() WHERE referred_id=$1', [referredId]);
          const bonus = this.cfg().bonusMinor;
          await tx.query(
            `INSERT INTO ambassador_earnings (ambassador_id, kind, referred_id, side, deal_id, amount_minor, currency, month, status, hold_reason)
             VALUES ($1,'BONUS',$2,'SELLER',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [ref.ambassador_id, referredId, deal.id, bonus, deal.currency, month, hold ? 'HELD' : 'CONFIRMED', hold]);
          if (!hold) {
            await this.book(tx, deal.id, deal.currency, bonus, `Ambassador seller bonus (${deal.code})`);
            const seller = (await tx.query('SELECT COALESCE(business_name, display_name) AS n FROM users WHERE id=$1', [referredId])).rows[0]?.n ?? 'A seller you brought';
            out.push({ phone: ref.amb_phone, message: amsg.bonus(seller, this.money(bonus), this.cfg().bonusOrders),
              fallback: ambTemplate('update', [`${seller} completed ${this.cfg().bonusOrders} orders, so you earned a ${this.money(bonus)} bonus.`], ['menu:amb']) });
          }
        }
      }
    }
    return out;
  }

  /** Why an earning should wait for the team, or null. */
  private async holdReason(q: Queryable, ambId: string, referredId: string, deal: { seller_id: string | null; buyer_id: string | null }): Promise<string | null> {
    if (deal.seller_id === ambId || deal.buyer_id === ambId) return 'The ambassador is one side of this order';
    const ids = (await q.query('SELECT id, kyc_id_hash FROM users WHERE id = ANY($1)', [[ambId, referredId, deal.seller_id, deal.buyer_id].filter(Boolean)])).rows;
    const hash = (id: string | null) => ids.find((x) => x.id === id)?.kyc_id_hash ?? null;
    if (hash(ambId) && hash(ambId) === hash(referredId)) return 'Same ID (BVN/NIN) as the ambassador';
    const bank = await q.query(
      `SELECT 1 FROM bank_accounts a JOIN bank_accounts b ON a.bank_code=b.bank_code AND a.account_number=b.account_number WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1`, [ambId, referredId]);
    if (bank.rowCount) return 'Same bank account as the ambassador';
    if (deal.seller_id && deal.buyer_id) {
      if (hash(deal.seller_id) && hash(deal.seller_id) === hash(deal.buyer_id)) return 'The buyer and the seller have the same ID';
      const same = await q.query(
        `SELECT 1 FROM bank_accounts a JOIN bank_accounts b ON a.bank_code=b.bank_code AND a.account_number=b.account_number WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1`, [deal.seller_id, deal.buyer_id]);
      if (same.rowCount) return 'The buyer and the seller use the same bank account';
    }
    return null;
  }

  private async book(q: Queryable, dealId: string | null, currency: Currency, amount: number, memo: string) {
    await post(q, { dealId, currency, memo, lines: [{ account: 'expense:ambassadors', amountMinor: amount }, { account: 'payable:ambassador', amountMinor: -amount }] });
  }

  /** The team approves a held earning (it counts) or cancels it. */
  async decideHold(id: number, approve: boolean, staffId: string | null): Promise<void> {
    await withTx(this.o.db, async (tx) => {
      const e = (await tx.query(`SELECT * FROM ambassador_earnings WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!e || e.status !== 'HELD') throw new AmbassadorError('This earning isn\'t waiting for a decision');
      await tx.query(`UPDATE ambassador_earnings SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, approve ? 'CONFIRMED' : 'VOID', staffId]);
      if (approve) await this.book(tx, e.deal_id, e.currency, Number(e.amount_minor), `Ambassador ${e.kind === 'BONUS' ? 'seller bonus' : 'share'} (approved after review)`);
    });
  }

  // ===================================================================================================
  // Terms, pausing and ending
  // ===================================================================================================

  async renew(userId: string): Promise<void> { await this.o.db.query(`UPDATE ambassadors SET next_term_months=NULL WHERE user_id=$1 AND status IN ('ACTIVE','PAUSED')`, [userId]); }

  /** Ends now: they stop earning; what they've earned is paid, whatever the amount (a final payout is made). */
  async end(userId: string, reason: string, byStaff: string | null = null): Promise<void> {
    const r = await this.o.db.query(`UPDATE ambassadors SET status='ENDED', ended_at=now(), end_reason=$2 WHERE user_id=$1 AND status<>'ENDED' RETURNING user_id`, [userId, clip(reason, 200)]);
    if (!r.rowCount) return;
    await withTx(this.o.db, (tx) => this.makePayout(tx, userId, monthStart(monthKey()), true));
    await this.o.db.query(`UPDATE ambassador_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
    this.changed();
    const p = (await this.o.db.query('SELECT phone FROM users WHERE id=$1', [userId])).rows[0];
    if (p) await this.send({ phone: p.phone, message: amsg.ended(!!byStaff, reason) });
  }
  async pause(userId: string, reason: string): Promise<void> {
    const r = await this.o.db.query(`UPDATE ambassadors SET status='PAUSED', paused_at=now(), end_reason=$2 WHERE user_id=$1 AND status='ACTIVE' RETURNING user_id`, [userId, clip(reason, 200)]);
    if (!r.rowCount) throw new AmbassadorError('Only an active ambassador can be paused');
    this.changed();
    const p = (await this.o.db.query('SELECT phone FROM users WHERE id=$1', [userId])).rows[0];
    if (p) await this.send({ phone: p.phone, message: amsg.paused(reason) });
  }
  async resume(userId: string): Promise<void> {
    const r = await this.o.db.query(`UPDATE ambassadors SET status='ACTIVE', paused_at=NULL, end_reason=NULL WHERE user_id=$1 AND status='PAUSED' RETURNING user_id`, [userId]);
    if (!r.rowCount) throw new AmbassadorError('Only a paused ambassador can be resumed');
    this.changed();
    const p = (await this.o.db.query('SELECT phone FROM users WHERE id=$1', [userId])).rows[0];
    if (p) await this.send({ phone: p.phone, message: amsg.resumed() });
  }
  async setCustomPct(userId: string, sellerPct: number | null, buyerPct: number | null): Promise<void> {
    for (const v of [sellerPct, buyerPct]) if (v != null && (!Number.isFinite(v) || v < 0 || v > 50)) throw new AmbassadorError('Use a % between 0 and 50');
    await this.o.db.query('UPDATE ambassadors SET seller_pct=$2, buyer_pct=$3 WHERE user_id=$1', [userId, sellerPct, buyerPct]);
  }

  /** Background (slow tick): term notices and rollovers, the monthly payout run, month-end summaries. */
  async sweep(now = new Date()): Promise<{ notices: number; rolled: number; payouts: number; summaries: number }> {
    const res = { notices: 0, rolled: 0, payouts: 0, summaries: 0 };
    const cfg = this.cfg();
    // terms: the notice before the end, then the rollover (no answer = the same term again; a switch takes effect now)
    const due = await this.o.db.query(
      `SELECT a.*, u.phone FROM ambassadors a JOIN users u ON u.id=a.user_id WHERE a.status IN ('ACTIVE','PAUSED') AND a.term_ends_at IS NOT NULL`);
    for (const a of due.rows) {
      const ends = new Date(a.term_ends_at);
      if (ends.getTime() <= now.getTime()) {
        const months = a.next_term_months ?? a.term_months;
        await this.o.db.query(`UPDATE ambassadors SET term_months=$2, next_term_months=NULL, term_started_at=term_ends_at, term_ends_at=term_ends_at + make_interval(months => $2), notice_for=NULL WHERE user_id=$1`, [a.user_id, months]);
        res.rolled++;
        await this.send({ phone: a.phone, message: amsg.renewed(months, dayText(addMonths(ends, months))) });
      } else if (ends.getTime() - now.getTime() <= cfg.noticeDays * 86400_000 && (!a.notice_for || new Date(a.notice_for).getTime() !== ends.getTime())) {
        await this.o.db.query('UPDATE ambassadors SET notice_for=$2 WHERE user_id=$1', [a.user_id, ends]);
        res.notices++;
        await this.send({ phone: a.phone, message: amsg.termNotice(a.term_months, dayText(ends), a.next_term_months),
          fallback: ambTemplate('term', [String(a.next_term_months ?? a.term_months), dayText(ends)], ['amb:renew', 'amb:switch', 'amb:end']) });
      }
    }
    // tidy up: declined applications after 12 months, expired sign-in codes, old dashboard sessions (Privacy policy)
    await this.o.db.query(`DELETE FROM ambassador_applications a WHERE status='DECLINED' AND decided_at < now() - interval '12 months'
      AND NOT EXISTS (SELECT 1 FROM ambassadors x WHERE x.application_id=a.id)`);
    await this.o.db.query(`DELETE FROM ambassador_codes WHERE expires_at < now() - interval '1 day'`);
    await this.o.db.query(`DELETE FROM ambassador_sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
    // the monthly payout run, on the payout day (or after, if the server was asleep), for the month before
    if (lagosDay(now) >= cfg.payoutDay) res.payouts = await this.payoutRun(shiftMonth(monthKey(now), -1));
    // month-end summaries, on the last day of the month
    if (lagosLastDay(now)) {
      const mk = monthKey(now);
      const act = await this.o.db.query(`SELECT a.user_id, a.summary_month, u.phone FROM ambassadors a JOIN users u ON u.id=a.user_id WHERE a.status='ACTIVE'`);
      for (const a of act.rows) {
        if (a.summary_month && keyOf(a.summary_month) === mk) continue;
        await this.o.db.query('UPDATE ambassadors SET summary_month=$2 WHERE user_id=$1', [a.user_id, monthStart(mk)]);
        const s = await this.monthSummary(a.user_id, mk);
        res.summaries++;
        await this.send({ phone: a.phone, message: amsg.monthSummary(monthLabel(mk), this.money(s.earned), s.activeSellers, `${this.dashboardUrl()}?m=${mk}`),
          fallback: ambTemplate('update', [`in ${monthLabel(mk)} you earned ${this.money(s.earned)}, from ${s.activeSellers} active seller${s.activeSellers === 1 ? '' : 's'}.`], ['menu:amb']) });
      }
    }
    return res;
  }

  /** Makes the payouts for a month (once): everyone owed at least the minimum, or owed anything once they've ended. */
  async payoutRun(forMonth: string): Promise<number> {
    const period = monthStart(forMonth);
    const owed = await this.o.db.query(
      `SELECT e.ambassador_id, a.status, sum(e.amount_minor)::bigint AS total FROM ambassador_earnings e JOIN ambassadors a ON a.user_id=e.ambassador_id
       WHERE e.status='CONFIRMED' AND e.payout_id IS NULL AND e.month <= $1 GROUP BY e.ambassador_id, a.status`, [period]);
    let made = 0;
    for (const o of owed.rows) {
      const min = o.status === 'ENDED' ? 1 : Math.max(1, this.cfg().payoutMinMinor);
      if (Number(o.total) < min) continue;
      const id = await withTx(this.o.db, (tx) => this.makePayout(tx, o.ambassador_id, period, false));
      if (id) made++;
    }
    return made;
  }

  /** Gathers what someone is owed (confirmed, not yet in a payout) into one payout. Returns its id, or null. */
  private async makePayout(tx: Tx, userId: string, period: string, final: boolean): Promise<string | null> {
    const rows = (await tx.query(
      `SELECT id, amount_minor, currency FROM ambassador_earnings WHERE ambassador_id=$1 AND status='CONFIRMED' AND payout_id IS NULL ${final ? '' : 'AND month <= $2'} FOR UPDATE`,
      final ? [userId] : [userId, period])).rows;
    const total = rows.reduce((s, r) => s + Number(r.amount_minor), 0);
    if (!total) return null;
    if (!final) {
      const exists = (await tx.query('SELECT 1 FROM ambassador_payouts WHERE ambassador_id=$1 AND period=$2 AND NOT final', [userId, period])).rowCount;
      if (exists) return null;
    }
    const bank = (await tx.query('SELECT id FROM bank_accounts WHERE user_id=$1 AND is_default ORDER BY created_at DESC LIMIT 1', [userId])).rows[0]?.id ?? null;
    const p = (await tx.query(
      `INSERT INTO ambassador_payouts (ambassador_id, period, amount_minor, currency, bank_account_id, final) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, period, total, rows[0].currency, bank, final])).rows[0].id;
    await tx.query('UPDATE ambassador_earnings SET payout_id=$2 WHERE id = ANY($1)', [rows.map((r) => r.id), p]);
    return p;
  }

  /** The team paid it (bank transfer): records it and tells the ambassador. */
  async markPaid(payoutId: string, reference: string, staffId: string | null): Promise<void> {
    const ref = String(reference ?? '').trim().slice(0, 80);
    if (ref.length < 3) throw new AmbassadorError('Add the transfer reference, so the ambassador can match it.');
    const p = await withTx(this.o.db, async (tx) => {
      const x = (await tx.query('SELECT * FROM ambassador_payouts WHERE id=$1 FOR UPDATE', [payoutId])).rows[0];
      if (!x) throw new AmbassadorError('Payout not found');
      if (x.status === 'PAID') throw new AmbassadorError('Already marked as paid');
      await tx.query(`UPDATE ambassador_payouts SET status='PAID', reference=$2, paid_by=$3, paid_at=now() WHERE id=$1`, [payoutId, ref, staffId]);
      await post(tx, { dealId: null, currency: x.currency, memo: `Ambassador payout ${ref}`, lines: [{ account: 'payable:ambassador', amountMinor: Number(x.amount_minor) }, { account: 'cash:bank', amountMinor: -Number(x.amount_minor) }] });
      return x;
    });
    const u = (await this.o.db.query(`SELECT u.phone, b.bank_name FROM users u LEFT JOIN bank_accounts b ON b.id=$2 WHERE u.id=$1`, [p.ambassador_id, p.bank_account_id])).rows[0];
    if (!u) return;
    const amount = this.money(Number(p.amount_minor));
    const bank = shortBank(u.bank_name ?? 'bank');
    const label = monthLabel(keyOf(p.period));
    await this.send({ phone: u.phone, message: amsg.paid(amount, bank, label, ref), fallback: ambTemplate('paid', [amount, bank, label, ref], ['menu:amb']) });
  }

  async payouts(status: 'DUE' | 'PAID' | 'ALL' = 'DUE') {
    const r = await this.o.db.query(
      `SELECT p.*, u.phone, COALESCE(u.kyc_name, u.display_name) AS name, a.slug, b.bank_name, b.account_number, b.account_name, s.name AS paid_by_name
       FROM ambassador_payouts p JOIN users u ON u.id=p.ambassador_id LEFT JOIN ambassadors a ON a.user_id=p.ambassador_id
       LEFT JOIN bank_accounts b ON b.id=COALESCE(p.bank_account_id, (SELECT id FROM bank_accounts WHERE user_id=p.ambassador_id AND is_default ORDER BY created_at DESC LIMIT 1))
       LEFT JOIN staff s ON s.id=p.paid_by ${status === 'ALL' ? '' : 'WHERE p.status=$1'} ORDER BY p.status, p.created_at DESC LIMIT 300`, status === 'ALL' ? [] : [status]);
    return r.rows.map((x) => ({
      id: x.id, userId: x.ambassador_id, name: x.name, phone: x.phone, slug: x.slug, month: keyOf(x.period), amountMinor: Number(x.amount_minor), final: x.final,
      status: x.status, reference: x.reference, paidAt: x.paid_at, paidBy: x.paid_by_name,
      bank: x.account_number ? { name: x.bank_name, number: x.account_number, accountName: x.account_name } : null,
    }));
  }

  // ===================================================================================================
  // What ambassadors see (WhatsApp and the web dashboard) and what the console shows
  // ===================================================================================================

  async monthSummary(userId: string, mk: string) {
    const r = await this.o.db.query(
      `SELECT COALESCE(sum(amount_minor) FILTER (WHERE status='CONFIRMED'),0)::bigint AS earned,
              COALESCE(sum(amount_minor) FILTER (WHERE status='CONFIRMED' AND kind='SHARE' AND side='SELLER'),0)::bigint AS sellers,
              COALESCE(sum(amount_minor) FILTER (WHERE status='CONFIRMED' AND kind='SHARE' AND side='BUYER'),0)::bigint AS buyers,
              COALESCE(sum(amount_minor) FILTER (WHERE status='CONFIRMED' AND kind='BONUS'),0)::bigint AS bonuses,
              count(*) FILTER (WHERE status='CONFIRMED' AND kind='BONUS')::int AS bonus_count,
              COALESCE(sum(amount_minor) FILTER (WHERE status='HELD'),0)::bigint AS held,
              count(DISTINCT deal_id) FILTER (WHERE status<>'VOID')::int AS orders,
              count(DISTINCT referred_id) FILTER (WHERE side='SELLER' AND status<>'VOID')::int AS active_sellers
       FROM ambassador_earnings WHERE ambassador_id=$1 AND month=$2`, [userId, monthStart(mk)]);
    const x = r.rows[0];
    const joined = (await this.o.db.query(
      `SELECT count(*) FILTER (WHERE u.seller_since IS NOT NULL)::int AS sellers, count(*) FILTER (WHERE u.seller_since IS NULL)::int AS buyers
       FROM ambassador_referrals r JOIN users u ON u.id=r.referred_id WHERE r.ambassador_id=$1 AND to_char(r.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM')=$2`, [userId, mk])).rows[0];
    return {
      earned: Number(x.earned), fromSellers: Number(x.sellers), fromBuyers: Number(x.buyers), bonuses: Number(x.bonuses), bonusCount: x.bonus_count,
      held: Number(x.held), orders: x.orders, activeSellers: x.active_sellers, newSellers: joined.sellers, newBuyers: joined.buyers,
    };
  }

  /** Everything for the WhatsApp screen, the web dashboard and the console's ambassador page. `mk`: the month to show. */
  async overview(userId: string, mk: string = monthKey()) {
    const a = await this.get(userId);
    if (!a) return null;
    const u = (await this.o.db.query('SELECT phone, display_name, kyc_name FROM users WHERE id=$1', [userId])).rows[0];
    const first = monthKey(a.activated_at ?? a.approved_at);
    const now = monthKey();
    const months: string[] = [];
    for (let k = now; k >= first && months.length < 60; k = shiftMonth(k, -1)) months.push(k);
    if (!months.includes(mk)) mk = now;
    const summary = await this.monthSummary(userId, mk);
    const lines = (await this.o.db.query(
      `SELECT e.*, d.code, COALESCE(p.business_name, p.display_name) AS person, p.seller_since, ap.status AS payout_status, ap.paid_at
       FROM ambassador_earnings e JOIN deals d ON d.id=e.deal_id JOIN users p ON p.id=e.referred_id LEFT JOIN ambassador_payouts ap ON ap.id=e.payout_id
       WHERE e.ambassador_id=$1 AND e.month=$2 ORDER BY e.created_at DESC LIMIT 400`, [userId, monthStart(mk)])).rows.map((x) => ({
      id: Number(x.id), at: x.created_at, kind: x.kind as 'SHARE' | 'BONUS', side: x.side as 'SELLER' | 'BUYER', code: x.code,
      who: x.side === 'SELLER' ? (x.person ?? 'Seller') : (firstOf(x.person) || 'Buyer'),
      revenueMinor: Number(x.revenue_minor), percent: x.percent != null ? Number(x.percent) : null, amountMinor: Number(x.amount_minor),
      status: x.status as 'CONFIRMED' | 'HELD' | 'VOID', holdReason: x.hold_reason, paid: x.payout_status === 'PAID',
    }));
    const chartFrom = shiftMonth(now, -11);
    const chartRows = (await this.o.db.query(
      `SELECT to_char(month, 'YYYY-MM') AS m, sum(amount_minor)::bigint AS t FROM ambassador_earnings
       WHERE ambassador_id=$1 AND status='CONFIRMED' AND month >= $2 GROUP BY 1`, [userId, monthStart(chartFrom)])).rows;
    const chart: { month: string; amountMinor: number }[] = [];
    for (let k = chartFrom; k <= now; k = shiftMonth(k, 1)) chart.push({ month: k, amountMinor: Number(chartRows.find((r) => r.m === k)?.t ?? 0) });
    const totals = (await this.o.db.query(
      `SELECT COALESCE(sum(e.amount_minor) FILTER (WHERE e.status='CONFIRMED' AND ap.status='PAID'),0)::bigint AS paid,
              COALESCE(sum(e.amount_minor) FILTER (WHERE e.status='CONFIRMED' AND (ap.id IS NULL OR ap.status='DUE')),0)::bigint AS owed,
              COALESCE(sum(e.amount_minor) FILTER (WHERE e.status='CONFIRMED'),0)::bigint AS all_time
       FROM ambassador_earnings e LEFT JOIN ambassador_payouts ap ON ap.id=e.payout_id WHERE e.ambassador_id=$1`, [userId])).rows[0];
    // orders from their people that are paid for and on the way: they'll count when they finish
    const pendingRows = (await this.o.db.query(
      `SELECT d.buyer_pays_minor - d.seller_gets_minor AS rev, CASE WHEN r.referred_id=d.seller_id THEN 'SELLER' ELSE 'BUYER' END AS side
       FROM ambassador_referrals r JOIN deals d ON (d.seller_id=r.referred_id OR d.buyer_id=r.referred_id)
       WHERE r.ambassador_id=$1 AND d.status IN ('FUNDED','SHIPPED','DISPUTED') AND ($2 OR NOT d.is_test)`, [userId, this.o.countTest])).rows;
    const pendingMinor = a.status === 'ACTIVE' ? pendingRows.reduce((s, x) => s + Math.floor((Number(x.rev) * this.pctFor(a, x.side)) / 100), 0) : 0;
    const people = (await this.o.db.query(
      `SELECT r.referred_id, r.created_at, r.bonus_at, u.seller_since, COALESCE(u.business_name, u.display_name) AS name,
         (SELECT count(*) FROM deals d WHERE d.seller_id=u.id AND d.status IN ('RELEASING','PAYOUT_PENDING','COMPLETED') AND ($2 OR NOT d.is_test))::int AS sold,
         (SELECT count(*) FROM deals d WHERE d.buyer_id=u.id AND d.status IN ('RELEASING','PAYOUT_PENDING','COMPLETED') AND ($2 OR NOT d.is_test))::int AS bought,
         (SELECT max(d.closed_at) FROM deals d WHERE (d.seller_id=u.id OR d.buyer_id=u.id) AND d.status IN ('RELEASING','PAYOUT_PENDING','COMPLETED')) AS last_at
       FROM ambassador_referrals r JOIN users u ON u.id=r.referred_id WHERE r.ambassador_id=$1 ORDER BY r.created_at DESC LIMIT 500`, [userId, this.o.countTest])).rows;
    const active = (d: Date | null) => !!d && Date.now() - new Date(d).getTime() < 30 * 86400_000;
    const sellers = people.filter((p) => p.seller_since).map((p) => ({ id: p.referred_id, name: p.name ?? 'Seller', orders: p.sold, active: active(p.last_at), joinedAt: p.created_at, bonus: !!p.bonus_at, toBonus: Math.max(0, this.cfg().bonusOrders - p.sold) }));
    const buyers = people.filter((p) => !p.seller_since).map((p) => ({ id: p.referred_id, name: firstOf(p.name) || 'Buyer', orders: p.bought, active: active(p.last_at), joinedAt: p.created_at }));
    const photo = await this.photo({ userId });
    const bank = (await this.o.db.query('SELECT bank_name, account_number FROM bank_accounts WHERE user_id=$1 AND is_default ORDER BY created_at DESC LIMIT 1', [userId])).rows[0];
    const taps = a.slug ? Number((await this.o.db.query(`SELECT COALESCE(sum(t.taps),0)::int AS n FROM ambassador_link_taps t JOIN ambassador_names n ON n.slug=t.slug WHERE n.user_id=$1`, [userId])).rows[0].n) : 0;
    const cfg = this.cfg();
    const owed = Number(totals.owed);
    const nextPayDate = nextPayout(cfg.payoutDay);
    const payouts = (await this.o.db.query(`SELECT * FROM ambassador_payouts WHERE ambassador_id=$1 ORDER BY created_at DESC LIMIT 24`, [userId])).rows.map((p) => ({
      id: p.id, month: keyOf(p.period), amountMinor: Number(p.amount_minor), status: p.status, reference: p.reference, paidAt: p.paid_at, final: p.final,
    }));
    return {
      userId, name: u?.kyc_name ?? u?.display_name ?? null, firstName: firstOf(u?.kyc_name ?? u?.display_name), phone: u?.phone ?? null,
      status: a.status, slug: a.slug, area: a.area, link: a.slug ? this.linkUrl(a.slug) : null, linkText: a.slug ? this.linkText(a.slug) : null,
      term: a.term_months, nextTerm: a.next_term_months, termEnds: a.term_ends_at, activatedAt: a.activated_at, endedAt: a.ended_at, endReason: a.end_reason,
      pct: { seller: this.pctFor(a, 'SELLER'), buyer: this.pctFor(a, 'BUYER'), customSeller: a.seller_pct != null ? Number(a.seller_pct) : null, customBuyer: a.buyer_pct != null ? Number(a.buyer_pct) : null },
      bonus: { amountMinor: cfg.bonusMinor, orders: cfg.bonusOrders }, terms: cfg.terms,
      photo: photo && a.slug ? this.photoUrl(a.slug, photo.version) : null, photoVersion: photo?.version ?? null,
      bank: bank ? { name: shortBank(bank.bank_name), last4: String(bank.account_number).slice(-4) } : null,
      months, month: mk, monthLabel: monthLabel(mk), summary, lines, chart,
      totals: { paidMinor: Number(totals.paid), owedMinor: owed, allTimeMinor: Number(totals.all_time), pendingMinor, pendingOrders: pendingRows.length },
      next: { date: nextPayDate, minMinor: cfg.payoutMinMinor, belowMin: owed < cfg.payoutMinMinor },
      people: { sellers, buyers, activeSellers: sellers.filter((s) => s.active).length },
      taps, payouts,
    };
  }

  /** The console's list of ambassadors. */
  async list() {
    const r = await this.o.db.query(
      `SELECT a.*, COALESCE(u.kyc_name, u.display_name) AS name, u.phone,
         (SELECT count(*) FROM ambassador_referrals r JOIN users p ON p.id=r.referred_id WHERE r.ambassador_id=a.user_id AND p.seller_since IS NOT NULL)::int AS sellers,
         (SELECT count(*) FROM ambassador_referrals r JOIN users p ON p.id=r.referred_id WHERE r.ambassador_id=a.user_id AND p.seller_since IS NULL)::int AS buyers,
         (SELECT COALESCE(sum(amount_minor),0) FROM ambassador_earnings e WHERE e.ambassador_id=a.user_id AND e.status='CONFIRMED' AND e.month=$1)::bigint AS month_minor,
         (SELECT COALESCE(sum(amount_minor),0) FROM ambassador_earnings e WHERE e.ambassador_id=a.user_id AND e.status='CONFIRMED')::bigint AS total_minor,
         (SELECT count(*) FROM ambassador_earnings e WHERE e.ambassador_id=a.user_id AND e.status='HELD')::int AS held
       FROM ambassadors a JOIN users u ON u.id=a.user_id ORDER BY (a.status='ENDED'), a.activated_at DESC NULLS FIRST, a.approved_at DESC`, [monthStart(monthKey())]);
    return r.rows.map((x) => ({
      userId: x.user_id, name: x.name, phone: x.phone, status: x.status as AmbStatus, slug: x.slug, area: x.area, term: x.term_months, termEnds: x.term_ends_at,
      sellers: x.sellers, buyers: x.buyers, monthMinor: Number(x.month_minor), totalMinor: Number(x.total_minor), held: x.held,
      customPct: x.seller_pct != null || x.buyer_pct != null, approvedAt: x.approved_at,
    }));
  }

  async held() {
    const r = await this.o.db.query(
      `SELECT e.*, d.code, COALESCE(a.kyc_name, a.display_name) AS amb_name, COALESCE(p.business_name, p.display_name) AS person
       FROM ambassador_earnings e JOIN deals d ON d.id=e.deal_id JOIN users a ON a.id=e.ambassador_id JOIN users p ON p.id=e.referred_id
       WHERE e.status='HELD' ORDER BY e.created_at`);
    return r.rows.map((x) => ({ id: Number(x.id), userId: x.ambassador_id, ambassador: x.amb_name, person: x.person, side: x.side, kind: x.kind, code: x.code, amountMinor: Number(x.amount_minor), reason: x.hold_reason, at: x.created_at }));
  }

  /** Who brought this person (People page), and their ambassador page if they are one. */
  async personLinks(userId: string) {
    const by = (await this.o.db.query(
      `SELECT r.ambassador_id, r.via, r.created_at, COALESCE(u.kyc_name, u.display_name) AS name, a.slug FROM ambassador_referrals r JOIN users u ON u.id=r.ambassador_id
       LEFT JOIN ambassadors a ON a.user_id=r.ambassador_id WHERE r.referred_id=$1`, [userId])).rows[0];
    const own = await this.get(userId);
    return {
      broughtBy: by ? { userId: by.ambassador_id, name: by.name, slug: by.slug, via: by.via, at: by.created_at } : null,
      ambassador: own ? { status: own.status, slug: own.slug } : null,
    };
  }

  /** Links for the website: each name, who it's for, and where it moves to. */
  async forSite(): Promise<{ slug: string; to: string | null; name: string | null; area: string | null; photo: string | null; active: boolean }[]> {
    const r = await this.o.db.query(
      `SELECT n.slug, a.slug AS current, a.status, a.area, COALESCE(u.kyc_name, u.display_name) AS name, p.sha256
       FROM ambassador_names n JOIN ambassadors a ON a.user_id=n.user_id JOIN users u ON u.id=a.user_id LEFT JOIN ambassador_photos p ON p.user_id=a.user_id ORDER BY n.slug`);
    return r.rows.map((x) => {
      const active = x.status === 'ACTIVE';
      return {
        slug: x.slug, to: x.current && x.current !== x.slug ? x.current : null, active,
        name: active ? (firstOf(x.name) || null) : null, area: active ? x.area : null,
        photo: active && x.sha256 && x.current ? this.photoUrl(x.current, String(x.sha256).slice(0, 12)) : null,
      };
    });
  }

  async tap(slug: string): Promise<void> {
    await this.o.db.query(
      `INSERT INTO ambassador_link_taps (slug, day, taps) SELECT slug, (now() AT TIME ZONE 'Africa/Lagos')::date, 1 FROM ambassador_names WHERE slug=$1
       ON CONFLICT (slug, day) DO UPDATE SET taps=ambassador_link_taps.taps+1`, [slug]);
  }

  /** Programme totals for the console page. */
  async stats() {
    const r = await this.o.db.query(
      `SELECT (SELECT count(*) FROM ambassadors WHERE status='ACTIVE')::int AS active,
              (SELECT count(*) FROM ambassador_applications WHERE status='PENDING')::int AS pending,
              (SELECT count(*) FROM ambassador_referrals)::int AS people,
              (SELECT COALESCE(sum(amount_minor),0) FROM ambassador_earnings WHERE status='CONFIRMED' AND month=$1)::bigint AS month_minor,
              (SELECT COALESCE(sum(amount_minor),0) FROM ambassador_payouts WHERE status='DUE')::bigint AS due_minor,
              (SELECT count(*) FROM ambassador_earnings WHERE status='HELD')::int AS held`, [monthStart(monthKey())]);
    const x = r.rows[0];
    return { active: x.active, pending: x.pending, people: x.people, monthMinor: Number(x.month_minor), dueMinor: Number(x.due_minor), held: x.held };
  }

  // ===================================================================================================
  // Signing in to the web dashboard: a 6-digit code to their WhatsApp, then 30 days on that device
  // ===================================================================================================

  private hash(s: string) { return createHash('sha256').update(`${this.o.secret}:${s}`).digest('hex'); }

  /** Sends a sign-in code to an ambassador's WhatsApp. Always answers the same way, so numbers can't be guessed. */
  async sendCode(rawPhone: string): Promise<'sent' | 'wait' | 'not-ambassador' | 'not-delivered'> {
    const phone = normPhone(rawPhone);
    if (!phone) return 'not-ambassador';
    const a = (await this.o.db.query(`SELECT a.status FROM ambassadors a JOIN users u ON u.id=a.user_id WHERE u.phone=$1`, [phone])).rows[0];
    if (!a || a.status === 'SETUP') return 'not-ambassador';
    const last = (await this.o.db.query('SELECT sent_at FROM ambassador_codes WHERE phone=$1', [phone])).rows[0];
    if (last && Date.now() - new Date(last.sent_at).getTime() < 45_000) return 'wait';
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.o.db.query(
      `INSERT INTO ambassador_codes (phone, code_hash, tries, expires_at, sent_at) VALUES ($1,$2,0,now() + interval '10 minutes', now())
       ON CONFLICT (phone) DO UPDATE SET code_hash=$2, tries=0, expires_at=now() + interval '10 minutes', sent_at=now()`, [phone, this.hash(`${phone}:${code}`)]);
    const status = await this.o.messenger.send(phone, amsg.code(code), { name: SIGN_IN_TEMPLATE, language: 'en', params: [code], codeButton: code, preview: `${code} is your verification code.` }).catch(() => 'FAILED' as const);
    return status === 'FAILED' || status === 'NEEDS_TEMPLATE' ? 'not-delivered' : 'sent';
  }

  /** Checks the code. Right: a new session (the token for the cookie). 5 tries per code. */
  async verifyCode(rawPhone: string, code: string, device: string): Promise<{ token: string; userId: string } | 'wrong' | 'expired' | 'locked'> {
    const phone = normPhone(rawPhone);
    if (!phone) return 'wrong';
    const c = (await this.o.db.query('SELECT * FROM ambassador_codes WHERE phone=$1', [phone])).rows[0];
    if (!c) return 'expired';
    if (new Date(c.expires_at).getTime() < Date.now()) return 'expired';
    if (c.tries >= 5) return 'locked';
    const want = Buffer.from(c.code_hash), got = Buffer.from(this.hash(`${phone}:${String(code).replace(/\D/g, '')}`));
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      await this.o.db.query('UPDATE ambassador_codes SET tries=tries+1 WHERE phone=$1', [phone]);
      return c.tries + 1 >= 5 ? 'locked' : 'wrong';
    }
    await this.o.db.query('DELETE FROM ambassador_codes WHERE phone=$1', [phone]);
    const u = (await this.o.db.query(`SELECT u.id FROM users u JOIN ambassadors a ON a.user_id=u.id WHERE u.phone=$1 AND a.status<>'SETUP'`, [phone])).rows[0];
    if (!u) return 'expired';
    const token = randomBytes(32).toString('base64url');
    const known = (await this.o.db.query('SELECT 1 FROM ambassador_sessions WHERE user_id=$1 AND device=$2 LIMIT 1', [u.id, device.slice(0, 80)])).rowCount;
    await this.o.db.query(`INSERT INTO ambassador_sessions (token_hash, user_id, device, expires_at) VALUES ($1,$2,$3, now() + interval '30 days')`, [this.hash(token), u.id, device.slice(0, 80)]);
    if (!known) await this.send({ phone, message: amsg.newDevice(device), fallback: ambTemplate('signIn', [device], ['amb:signout']) });
    return { token, userId: u.id };
  }

  async session(token: string | undefined): Promise<string | null> {
    if (!token || token.length < 20) return null;
    const r = await this.o.db.query(
      `UPDATE ambassador_sessions SET last_seen_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`, [this.hash(token)]);
    return r.rows[0]?.user_id ?? null;
  }
  async signOut(token: string) { await this.o.db.query('UPDATE ambassador_sessions SET revoked_at=now() WHERE token_hash=$1', [this.hash(token)]); }
  async signOutAll(userId: string) { await this.o.db.query('UPDATE ambassador_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]); }
}

export const SIGN_IN_TEMPLATE = 'hoolam_sign_in_code';

/** The day of the next payout, in Lagos. */
export function nextPayout(day: number, now = new Date()): string {
  const t = new Date(now.getTime() + LAGOS_MS);
  let d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), day, 12));
  if (t.getUTCDate() >= day) d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, day, 12));
  return d.toISOString().slice(0, 10);
}

// ---------- small helpers ----------
function clip(v: unknown, n: number): string | null { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; }
export function firstOf(name: string | null | undefined): string { return String(name ?? '').trim().split(/\s+/)[0] ?? ''; }
/** 0803… / 234803… / +234 803… → +234803… (Nigerian numbers; other full international numbers as typed). */
export function normPhone(raw: unknown): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (/^0[789][01]\d{8}$/.test(d)) return '+234' + d.slice(1);
  if (/^234[789][01]\d{8}$/.test(d)) return '+' + d;
  if (/^[789][01]\d{8}$/.test(d)) return '+234' + d;
  return null;
}
const shortBank = (n: string) => n.replace(/\s*(Microfinance Bank|Bank PLC|Bank Plc|Bank Limited|Bank Ltd|Plc|PLC|Limited)\b.*$/i, '').trim() || n;
async function upsertUserTx(tx: Tx, phone: string, name: string | null): Promise<string> {
  const r = await tx.query(
    `INSERT INTO users (phone, display_name) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET display_name=COALESCE(users.display_name, EXCLUDED.display_name) RETURNING id`, [phone, name]);
  return r.rows[0].id;
}

// =====================================================================================================
// The WhatsApp messages ambassadors get
// =====================================================================================================
const PERF = 'Your share grows when you bring more active sellers and buyers, whatever term you pick.';
export const amsg = {
  approved: (first: string, invited: boolean): Outbound => ({
    kind: 'buttons',
    text: invited
      ? `🤝 *Welcome${first ? `, ${first}` : ''}! You're now a Hoolam ambassador*\n\nYou earn a share of what Hoolam makes on every order from the sellers and buyers you bring, plus a bonus for each new seller.\n\nTap *Get started* to set up. It takes a few minutes.`
      : `🎉 *You're in${first ? `, ${first}` : ''}!*\n\nYour application to be a *Hoolam ambassador* is approved.\n\nTap *Get started* to finish setting up: a quick ID check, where we pay you, your term and your link. It takes a few minutes.`,
    buttons: [{ id: 'amb:setup', title: 'Get started' }],
  }),
  declined: (first: string): Outbound => ({
    kind: 'text',
    text: `Hi${first ? ` ${first}` : ''}, thank you for applying to be a Hoolam ambassador.\n\nWe can't take your application right now. You're still welcome to buy and sell safely with Hoolam, and to apply again later.`,
  }),
  joined: (): Outbound => ({ kind: 'buttons', text: '🎉 *Someone joined Hoolam with your link.*\n\nYou earn from their orders once they complete them.', buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }] }),
  bonus: (seller: string, amount: string, n: number): Outbound => ({
    kind: 'buttons', text: `💰 *${seller}* completed ${n} orders.\n\n*${amount}* bonus added to this month.`, buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }],
  }),
  paid: (amount: string, bank: string, month: string, ref: string): Outbound => ({
    kind: 'buttons', text: `✅ *${amount} paid* to your ${bank} account for ${month}.\n\nReference: ${ref}\n\nThank you for growing Hoolam.`, buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }],
  }),
  termNotice: (months: number, ends: string, next: number | null): Outbound => ({
    kind: 'buttons',
    text: `🗓️ *Your ${months}-month term ends on ${ends}.*\n\nIt renews by itself${next ? ` for *${next} months* (your switch)` : ' on the same term'}, or you can change it.\n\n${PERF}`,
    buttons: [{ id: 'amb:renew', title: 'Renew' }, { id: 'amb:switch', title: 'Switch term' }, { id: 'amb:end', title: 'End' }],
  }),
  renewed: (months: number, ends: string): Outbound => ({ kind: 'text', text: `🗓️ Your ambassador term renewed for *${months} months*, to ${ends}. Keep going! 💪` }),
  ended: (byTeam: boolean, reason: string): Outbound => ({
    kind: 'text',
    text: byTeam
      ? `Your Hoolam ambassador account has ended.${reason ? `\n\nReason: ${reason}` : ''}\n\nEverything you earned will be paid to your account, whatever the amount. Thank you.`
      : '👋 *Your ambassador term has ended.*\n\nEverything you earned will be paid to your account, whatever the amount. Thank you for growing Hoolam. You can apply again any time.',
  }),
  paused: (reason: string): Outbound => ({ kind: 'text', text: `⏸️ Your Hoolam ambassador account is paused for now.${reason ? `\n\nReason: ${reason}` : ''}\n\nWhile paused, new orders don't earn. What you earned is still paid. Talk to a rep if you have questions.` }),
  resumed: (): Outbound => ({ kind: 'buttons', text: '▶️ Your Hoolam ambassador account is active again. Orders from your people earn from now on.', buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }] }),
  photoRemoved: (): Outbound => ({ kind: 'buttons', text: 'We removed the photo on your ambassador link because it didn\'t meet our guidelines. Please send a clear photo of your face.', buttons: [{ id: 'amb:photo', title: 'Send a new photo' }] }),
  monthSummary: (month: string, amount: string, activeSellers: number, url: string): Outbound => ({
    kind: 'buttons', text: `📊 *${month}*\n\nYou earned *${amount}* from ${activeSellers} active seller${activeSellers === 1 ? '' : 's'}.\n\nSee every naira: ${url}`, buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }],
  }),
  code: (code: string): Outbound => ({ kind: 'text', text: `🔐 *${code}* is your code to sign in to your Hoolam ambassador dashboard. It works for 10 minutes.\n\nNever share it. Hoolam will never ask you for it.` }),
  newDevice: (device: string): Outbound => ({
    kind: 'buttons', text: `🔐 You signed in to your ambassador dashboard on *${device}*.\n\nNot you? Tap below to sign everyone out.`, buttons: [{ id: 'amb:signout', title: 'Sign everyone out' }],
  }),
};

/** "Chrome on Android" from a browser's user agent. */
export function deviceName(ua: string): string {
  const s = String(ua ?? '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'a browser';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iPhone' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'a device';
  return `${browser} on ${os}`;
}
