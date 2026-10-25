import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { parseSocial, SOCIAL_KINDS, socialLink, type SocialKind, type SocialLink } from './socials.js';
import type { Db } from './db.js';
import { namesMatch } from './kyc.js';

/**
 * THE TRUST CARD. Every number is counted from real deals paid through Hoolam, so it can't be faked
 * with screenshots. Rules that keep it honest:
 *   - test deals (pretend money) and self-deals never count
 *   - "different buyers" counts each buyer once, so a few friends can't inflate a record
 *   - disputes show how they ended: refunded after review counts against the seller, released doesn't
 *   - ratings only come from the buyer of a completed deal, one per deal
 *   - new sellers get "New on Hoolam", never zeros or a bad score
 */

export interface SellerStats {
  name: string;              // business name, else first WhatsApp name
  city: string | null;
  since: Date;
  completed: number;         // buyer was happy (or a dispute was settled for the seller)
  buyers: number;            // different buyers among those
  shipHours: number | null;  // typical time from "paid" to "I've sent it" (needs 3+ deals)
  problems: number;          // problems reported on their sales
  refunded: number;          // ... that ended in a refund after review
  released: number;          // ... that ended in the seller's favour
  happy: number;             // 👍
  rated: number;             // 👍 + 👎
  bankName: string | null;   // name on their payout account, as the bank gave it
  bankMatches: boolean;      // that name shares a name with their WhatsApp or business name
  verified: boolean;         // ID checked (BVN/NIN) and their payout account is in that name: "Verified seller"
  isNew: boolean;
  slug: string | null;
  isPublic: boolean;
  socials: SocialLink[];     // Instagram, TikTok, Facebook, website (in that order, only the ones set)
  photoVersion: string | null; // short hash of their photo, for /s/:slug/photo.webp?v=
  /** Page views to show buyers (public page, trust card): only with Seller page stats on, a public page, and 50+ views. */
  pageViews?: number | null;
  /** The seller's own numbers (My page), only with Seller page stats on. */
  ownStats?: { views30: number; buys30: number; total: number } | null;
  /** When their last order was completed (the buyer was happy), for "Last order completed 2 days ago". */
  lastCompletedAt?: Date | null;
  /** Their approved video (only while Seller videos is on): its version, for /s/:slug/video.mp4?v= */
  video?: { version: string; mime: string } | null;
  /** Photo ids of items they've delivered (only when they chose to show them): /s/:slug/delivered/:id.webp */
  delivered?: number[];
  /** What buyers wrote and agreed to show (newest first). */
  reviews?: { text: string; name: string; area: string | null; at: Date }[];
  showDelivered?: boolean;
}

/** Short counts: 950, 1.2k, 15.4k, 1.2m (one decimal, dropped when it's .0). */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  const one = (x: number) => (Math.floor(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return n < 1_000_000 ? `${one(n / 1000)}k` : `${one(n / 1_000_000)}m`;
}

/** Views a public page needs before buyers see the count. */
export const PUBLIC_VIEWS_FROM = 50;
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|skype|discord|slack|headless|curl|wget|python|go-http|java\/|okhttp|lighthouse|pingdom|uptime/i;
/** True for link previews, search engines and scripts: they don't count as views. */
export const isBot = (ua: string | undefined) => !ua || BOT.test(ua);

export interface BuyerStats { name: string; purchases: number; problems: number; refunded: number; isNew: boolean }

const DONE = `('RELEASING','PAYOUT_PENDING','COMPLETED')`;

export class Trust {
  /** includeTest: count pretend-money deals too (only for trying things out on the test number). */
  constructor(private readonly db: Db, private readonly includeTest = false, private readonly skipAccountMatch = false) {}

  /** Console → Settings → Features → Seller page stats. Counting never stops; this only decides whether anyone sees the numbers. */
  statsOn: () => boolean = () => false;
  /** Console → Settings → Features → Seller videos. */
  videoOn: () => boolean = () => false;

  /** Counts a page view, once per visitor per day (visitor: a one-way code, never stored beyond 2 days). */
  async recordView(userId: string, visitor: string): Promise<void> { await this.recordOnce(userId, visitor, 'views'); }
  /** Counts a "Buy" tap, once per visitor per day. */
  async recordBuy(userId: string, visitor: string): Promise<void> { await this.recordOnce(userId, `buy:${visitor}`, 'buys'); }
  /** Counts a tap on one of their social links. */
  async recordSocial(userId: string): Promise<void> {
    await this.db.query(`INSERT INTO seller_page_stats (user_id, day, socials) VALUES ($1, current_date, 1)
      ON CONFLICT (user_id, day) DO UPDATE SET socials=seller_page_stats.socials+1`, [userId]);
  }
  private async recordOnce(userId: string, visitor: string, col: 'views' | 'buys') {
    const first = await this.db.query('INSERT INTO seller_page_seen (user_id, day, visitor) VALUES ($1, current_date, $2) ON CONFLICT DO NOTHING', [userId, visitor]);
    if (!first.rowCount) return;
    await this.db.query(`INSERT INTO seller_page_stats (user_id, day, ${col}) VALUES ($1, current_date, 1)
      ON CONFLICT (user_id, day) DO UPDATE SET ${col}=seller_page_stats.${col}+1`, [userId]);
  }
  /** Removes the one-way visitor codes older than yesterday. */
  async purgeSeen(): Promise<number> { return (await this.db.query(`DELETE FROM seller_page_seen WHERE day < current_date - 1`)).rowCount ?? 0; }

  /** A seller's page numbers: last 30 days and all time (for the console, whatever the switch says). */
  async pageStats(userId: string): Promise<{ views30: number; buys30: number; socials30: number; total: number; totalBuys: number }> {
    const r = (await this.db.query(`SELECT coalesce(sum(views) FILTER (WHERE day > current_date - 30), 0)::int AS views30,
        coalesce(sum(buys) FILTER (WHERE day > current_date - 30), 0)::int AS buys30, coalesce(sum(socials) FILTER (WHERE day > current_date - 30), 0)::int AS socials30,
        coalesce(sum(views), 0)::int AS total, coalesce(sum(buys), 0)::int AS total_buys FROM seller_page_stats WHERE user_id=$1`, [userId])).rows[0];
    return { views30: r.views30, buys30: r.buys30, socials30: r.socials30, total: r.total, totalBuys: r.total_buys };
  }
  /** The most-viewed public pages in the last 30 days (for the console). */
  async topPages(limit = 10): Promise<{ userId: string; name: string; slug: string | null; isPublic: boolean; views30: number; buys30: number }[]> {
    const r = await this.db.query(`SELECT u.id, coalesce(nullif(u.business_name, ''), u.display_name, 'Seller') AS name, u.profile_slug, u.profile_public,
        sum(s.views)::int AS views30, sum(s.buys)::int AS buys30
      FROM seller_page_stats s JOIN users u ON u.id=s.user_id WHERE s.day > current_date - 30
      GROUP BY u.id HAVING sum(s.views) + sum(s.buys) > 0 ORDER BY views30 DESC, buys30 DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ userId: x.id, name: x.name, slug: x.profile_slug, isPublic: x.profile_public, views30: x.views30, buys30: x.buys30 }));
  }

  async seller(userId: string): Promise<SellerStats | null> {
    const u = (await this.db.query(`SELECT u.id, u.display_name, u.business_name, u.city, u.created_at, u.profile_slug, u.profile_public, u.kyc_status, u.kyc_verified_at, u.kyc_name,
        u.social_instagram, u.social_tiktok, u.social_facebook, u.social_website, u.show_delivered, p.sha256 AS photo_sha
      FROM users u LEFT JOIN user_photos p ON p.user_id=u.id WHERE u.id=$1`, [userId])).rows[0];
    if (!u) return null;
    const scope = `seller_id=$1 AND buyer_id IS NOT NULL AND buyer_id<>seller_id AND ($2 OR NOT is_test)`;
    const [d, disputes, ratings, bank, video, delivered, reviews] = await Promise.all([
      this.db.query(
        `SELECT count(*) FILTER (WHERE status IN ${DONE})::int AS completed,
                count(DISTINCT buyer_id) FILTER (WHERE status IN ${DONE})::int AS buyers,
                max(coalesce(closed_at, updated_at)) FILTER (WHERE status IN ${DONE}) AS last_done,
                count(*) FILTER (WHERE shipped_at IS NOT NULL AND funded_at IS NOT NULL)::int AS ship_samples,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM shipped_at - funded_at) / 3600)
                  FILTER (WHERE shipped_at IS NOT NULL AND funded_at IS NOT NULL) AS ship_hours
         FROM deals WHERE ${scope}`, [userId, this.includeTest]),
      this.db.query(
        `SELECT count(*)::int AS problems,
                count(*) FILTER (WHERE x.status='RESOLVED_REFUND')::int AS refunded,
                count(*) FILTER (WHERE x.status='RESOLVED_RELEASE')::int AS released
         FROM disputes x JOIN deals d ON d.id=x.deal_id
         WHERE d.seller_id=$1 AND d.buyer_id IS NOT NULL AND d.buyer_id<>d.seller_id AND ($2 OR NOT d.is_test)`,
        [userId, this.includeTest]),
      this.db.query(
        `SELECT count(*) FILTER (WHERE r.happy)::int AS happy, count(*)::int AS rated
         FROM deal_ratings r JOIN deals d ON d.id=r.deal_id WHERE r.seller_id=$1 AND ($2 OR NOT d.is_test)`, [userId, this.includeTest]),
      this.db.query('SELECT account_name FROM bank_accounts WHERE user_id=$1 AND is_default ORDER BY created_at DESC LIMIT 1', [userId]),
      this.videoOn() ? this.db.query(`SELECT sha256, mime FROM seller_videos WHERE user_id=$1 AND status='APPROVED' ORDER BY reviewed_at DESC NULLS LAST, id DESC LIMIT 1`, [userId]) : Promise.resolve({ rows: [] as any[] }),
      // the seller's own item photos (never a buyer's), one per completed order, newest first
      u.show_delivered ? this.db.query(
        `SELECT DISTINCT ON (d.id) p.id, d.closed_at FROM deal_photos p JOIN deals d ON d.id=p.deal_id
         WHERE d.seller_id=$1 AND d.status IN ${DONE} AND p.kind='ITEM' AND p.uploaded_by=$1 AND p.bytes IS NOT NULL AND ($2 OR NOT d.is_test)
         ORDER BY d.id, p.id`, [userId, this.includeTest]) : Promise.resolve({ rows: [] as any[] }),
      this.db.query(
        `SELECT r.text, r.created_at, b.display_name, b.city FROM seller_reviews r JOIN users b ON b.id=r.buyer_id JOIN deals d ON d.id=r.deal_id
         WHERE r.seller_id=$1 AND r.public AND NOT r.hidden AND ($2 OR NOT d.is_test) ORDER BY r.created_at DESC LIMIT 3`, [userId, this.includeTest]),
    ]);
    const row = d.rows[0];
    const bankName: string | null = bank.rows[0]?.account_name ?? null;
    const stats = this.statsOn() ? await this.pageStats(userId) : null;
    return {
      pageViews: stats && u.profile_public && stats.total >= PUBLIC_VIEWS_FROM ? stats.total : null,
      ownStats: stats ? { views30: stats.views30, buys30: stats.buys30, total: stats.total } : null,
      name: u.business_name || firstName(u.display_name) || 'Seller',
      city: u.city,
      since: new Date(u.created_at),
      completed: row.completed,
      buyers: row.buyers,
      shipHours: row.ship_samples >= 3 && row.ship_hours != null ? Number(row.ship_hours) : null,
      problems: disputes.rows[0].problems,
      refunded: disputes.rows[0].refunded,
      released: disputes.rows[0].released,
      happy: ratings.rows[0].happy,
      rated: ratings.rows[0].rated,
      bankName,
      bankMatches: bankName ? namesOverlap(bankName, [u.display_name, u.business_name]) : false,
      verified: u.kyc_status === 'VERIFIED' && !!u.kyc_verified_at && !!bankName && (this.skipAccountMatch || namesMatch(u.kyc_name, bankName)),
      isNew: row.completed < 3,
      slug: u.profile_slug,
      isPublic: u.profile_public,
      socials: SOCIAL_KINDS.map((k) => socialLink(k, u[`social_${k}`])).filter((x): x is SocialLink => !!x),
      photoVersion: u.photo_sha ? String(u.photo_sha).slice(0, 12) : null,
      lastCompletedAt: row.last_done ? new Date(row.last_done) : null,
      video: video.rows[0] ? { version: String(video.rows[0].sha256).slice(0, 12), mime: video.rows[0].mime } : null,
      delivered: delivered.rows.sort((a: any, b: any) => +new Date(b.closed_at ?? 0) - +new Date(a.closed_at ?? 0)).slice(0, 6).map((x: any) => Number(x.id)),
      reviews: reviews.rows.map((x: any) => ({ text: x.text, name: firstName(x.display_name) ?? 'A buyer', area: x.city ?? null, at: new Date(x.created_at) })),
      showDelivered: !!u.show_delivered,
    };
  }

  async buyer(userId: string): Promise<BuyerStats | null> {
    const u = (await this.db.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0];
    if (!u) return null;
    const r = await this.db.query(
      `SELECT (SELECT count(*) FROM deals WHERE buyer_id=$1 AND seller_id IS NOT NULL AND seller_id<>buyer_id AND status IN ${DONE} AND ($2 OR NOT is_test))::int AS purchases,
              (SELECT count(*) FROM disputes x JOIN deals d ON d.id=x.deal_id WHERE x.opened_by=$1 AND ($2 OR NOT d.is_test))::int AS problems,
              (SELECT count(*) FROM disputes x JOIN deals d ON d.id=x.deal_id WHERE x.opened_by=$1 AND x.status='RESOLVED_REFUND' AND ($2 OR NOT d.is_test))::int AS refunded`,
      [userId, this.includeTest]);
    const s = r.rows[0];
    return { name: firstName(u.display_name) ?? 'The buyer', purchases: s.purchases, problems: s.problems, refunded: s.refunded, isNew: s.purchases < 3 };
  }

  /** Finds a seller by phone number (as typed) or public page name. */
  async findSeller(q: { phone?: string | null; slug?: string | null }): Promise<string | null> {
    if (q.slug) return (await this.db.query('SELECT id FROM users WHERE profile_slug=$1 AND profile_public', [q.slug.toLowerCase()])).rows[0]?.id ?? null;
    if (q.phone) {
      const r = await this.db.query(`SELECT u.id FROM users u WHERE u.phone=$1 AND EXISTS (SELECT 1 FROM deals d WHERE d.seller_id=u.id)`, [q.phone]);
      return r.rows[0]?.id ?? null;
    }
    return null;
  }

  /** Turns the public page on (creating its address the first time) or off. */
  async setPublic(userId: string, on: boolean): Promise<string | null> {
    const u = (await this.db.query('SELECT business_name, display_name, profile_slug FROM users WHERE id=$1', [userId])).rows[0];
    let slug: string | null = u.profile_slug;
    if (on && !slug) {
      const base = slugify(u.business_name || u.display_name || 'seller');
      for (let i = 0; i < 50 && !slug; i++) {
        const candidate = i === 0 ? base : `${base}-${i + 1}`;
        const taken = await this.db.query('SELECT 1 FROM users WHERE profile_slug=$1', [candidate]);
        if (!taken.rowCount) slug = candidate;
      }
    }
    await this.db.query('UPDATE users SET profile_public=$2, profile_slug=COALESCE($3, profile_slug) WHERE id=$1', [userId, on, slug]);
    return slug;
  }

  /** Sets or clears one link. Returns an error message in plain words if the input isn't usable. */
  async setSocial(userId: string, kind: SocialKind, input: string | null): Promise<string | null> {
    if (!SOCIAL_KINDS.includes(kind)) return 'Unknown link';
    let value: string | null = null;
    if (input !== null) {
      const r = parseSocial(kind, input);
      if ('error' in r) return r.error;
      value = r.value;
    }
    await this.db.query(`UPDATE users SET social_${kind}=$2 WHERE id=$1`, [userId, value]);
    return null;
  }

  /** A seller's photo: turned upright, cropped square around the middle, sized for phones. */
  async setPhoto(userId: string, input: Buffer): Promise<string> {
    let out: Buffer;
    try {
      out = await sharp(input, { animated: false }).rotate().resize(640, 640, { fit: 'cover', position: 'attention', withoutEnlargement: false })
        .webp({ quality: 82 }).toBuffer();
    } catch { throw new Error('not an image'); }
    const sha = createHash('sha256').update(out).digest('hex');
    await this.db.query(`INSERT INTO user_photos (user_id, mime, bytes, sha256, updated_at) VALUES ($1,'image/webp',$2,$3,now())
      ON CONFLICT (user_id) DO UPDATE SET mime=EXCLUDED.mime, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, updated_at=now()`, [userId, out, sha]);
    return sha.slice(0, 12);
  }
  async removePhoto(userId: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM user_photos WHERE user_id=$1', [userId])).rowCount ?? 0) > 0;
  }
  async photo(userId: string): Promise<{ mime: string; bytes: Buffer; version: string } | null> {
    const r = (await this.db.query('SELECT mime, bytes, sha256 FROM user_photos WHERE user_id=$1', [userId])).rows[0];
    return r ? { mime: r.mime, bytes: r.bytes, version: String(r.sha256).slice(0, 12) } : null;
  }

  async setProfile(userId: string, p: { businessName?: string | null; city?: string | null }) {
    if (p.businessName !== undefined) await this.db.query('UPDATE users SET business_name=$2 WHERE id=$1', [userId, p.businessName?.trim().slice(0, 40) || null]);
    if (p.city !== undefined) await this.db.query('UPDATE users SET city=$2 WHERE id=$1', [userId, p.city?.trim().slice(0, 30) || null]);
  }

  /** 👍 or 👎 from the buyer of a completed deal. Returns false if it was already rated. */
  async rate(dealId: string, buyerId: string, sellerId: string, happy: boolean): Promise<boolean> {
    const r = await this.db.query(
      'INSERT INTO deal_ratings (deal_id, buyer_id, seller_id, happy) VALUES ($1,$2,$3,$4) ON CONFLICT (deal_id) DO NOTHING', [dealId, buyerId, sellerId, happy]);
    return (r.rowCount ?? 0) > 0;
  }

  async rateComment(dealId: string, buyerId: string, comment: string) {
    await this.db.query('UPDATE deal_ratings SET comment=$3 WHERE deal_id=$1 AND buyer_id=$2', [dealId, buyerId, comment.slice(0, 500)]);
  }

  // ---------- a buyer's few words about the seller (shown only with their yes) ----------
  /** Saves what a buyer wrote after a happy order. `show`: they agreed it goes on the seller's page with their first name and area. */
  async saveReview(dealId: string, buyerId: string, sellerId: string, text: string, show: boolean): Promise<void> {
    await this.db.query(`INSERT INTO seller_reviews (deal_id, buyer_id, seller_id, text, public) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (deal_id) DO UPDATE SET text=EXCLUDED.text, public=EXCLUDED.public`, [dealId, buyerId, sellerId, text.slice(0, REVIEW_MAX), show]);
  }
  /** Every review of a seller, for the console. */
  async reviewsFor(sellerId: string): Promise<{ dealId: string; text: string; public: boolean; hidden: boolean; buyer: string; buyerId: string; at: string }[]> {
    const r = await this.db.query(`SELECT r.deal_id, r.text, r.public, r.hidden, r.created_at, r.buyer_id, coalesce(b.display_name, b.phone) AS buyer
      FROM seller_reviews r JOIN users b ON b.id=r.buyer_id WHERE r.seller_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [sellerId]);
    return r.rows.map((x) => ({ dealId: x.deal_id, text: x.text, public: x.public, hidden: x.hidden, buyer: x.buyer, buyerId: x.buyer_id, at: x.created_at }));
  }
  async hideReview(dealId: string, hidden: boolean, staffId: string | null): Promise<boolean> {
    return ((await this.db.query('UPDATE seller_reviews SET hidden=$2, hidden_by=$3 WHERE deal_id=$1', [dealId, hidden, hidden ? staffId : null])).rowCount ?? 0) > 0;
  }

  // ---------- photos of items they've delivered (the seller chooses) ----------
  async setShowDelivered(userId: string, on: boolean): Promise<void> {
    await this.db.query('UPDATE users SET show_delivered=$2 WHERE id=$1', [userId, on]);
  }
  /** One delivered item's photo, only if it's theirs, on a completed order, and they chose to show them. */
  async deliveredPhoto(userId: string, photoId: number): Promise<Buffer | null> {
    const r = await this.db.query(
      `SELECT p.bytes FROM deal_photos p JOIN deals d ON d.id=p.deal_id JOIN users u ON u.id=d.seller_id
       WHERE p.id=$2 AND d.seller_id=$1 AND u.show_delivered AND d.status IN ${DONE} AND p.kind='ITEM' AND p.uploaded_by=$1 AND p.bytes IS NOT NULL AND ($3 OR NOT d.is_test)`,
      [userId, photoId, this.includeTest]);
    if (!r.rows[0]) return null;
    return sharp(r.rows[0].bytes, { failOn: 'none' }).rotate().resize(480, 480, { fit: 'cover', position: 'attention' }).webp({ quality: 78 }).toBuffer();
  }

  // ---------- the seller's video (Hoolam checks each one) ----------
  /** A new video from the seller: waits for Hoolam's check. Replaces one that was still waiting. */
  async setVideo(userId: string, bytes: Buffer, mime: string): Promise<void> {
    if (bytes.length > VIDEO_MAX_BYTES) throw new Error('too big');
    const sha = createHash('sha256').update(bytes).digest('hex');
    await this.db.query(`DELETE FROM seller_videos WHERE user_id=$1 AND status IN ('PENDING','REJECTED')`, [userId]);
    await this.db.query(`INSERT INTO seller_videos (user_id, mime, bytes, sha256, size_bytes) VALUES ($1,$2,$3,$4,$5)`, [userId, mime, bytes, sha, bytes.length]);
  }
  /** Where their video stands, for My page. */
  async videoState(userId: string): Promise<{ live: boolean; pending: boolean; rejected: string | null }> {
    const r = await this.db.query(`SELECT status, reason FROM seller_videos WHERE user_id=$1 ORDER BY id DESC`, [userId]);
    const by = (st: string) => r.rows.find((x) => x.status === st);
    return { live: !!by('APPROVED'), pending: !!by('PENDING'), rejected: by('REJECTED') && !by('PENDING') ? (by('REJECTED').reason ?? '') : null };
  }
  async removeVideo(userId: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM seller_videos WHERE user_id=$1', [userId])).rowCount ?? 0) > 0;
  }
  /** The live video's file (only while Seller videos is on). */
  async liveVideo(userId: string): Promise<{ bytes: Buffer; mime: string; version: string } | null> {
    if (!this.videoOn()) return null;
    const r = (await this.db.query(`SELECT bytes, mime, sha256 FROM seller_videos WHERE user_id=$1 AND status='APPROVED' ORDER BY reviewed_at DESC NULLS LAST, id DESC LIMIT 1`, [userId])).rows[0];
    return r ? { bytes: r.bytes, mime: r.mime, version: String(r.sha256).slice(0, 12) } : null;
  }
  /** Videos for the console: waiting first, then the recently checked. */
  async videos(): Promise<{ id: number; userId: string; name: string; status: string; reason: string | null; size: number; at: string; reviewedAt: string | null; reviewedBy: string | null }[]> {
    const r = await this.db.query(`SELECT v.id, v.user_id, coalesce(nullif(u.business_name, ''), u.display_name, u.phone) AS name, v.status, v.reason, v.size_bytes, v.created_at, v.reviewed_at, s.name AS reviewed_by
      FROM seller_videos v JOIN users u ON u.id=v.user_id LEFT JOIN staff s ON s.id=v.reviewed_by
      ORDER BY (v.status='PENDING') DESC, coalesce(v.reviewed_at, v.created_at) DESC LIMIT 40`);
    return r.rows.map((x) => ({ id: Number(x.id), userId: x.user_id, name: x.name, status: x.status, reason: x.reason, size: x.size_bytes, at: x.created_at, reviewedAt: x.reviewed_at, reviewedBy: x.reviewed_by }));
  }
  async videoFile(id: number): Promise<{ bytes: Buffer; mime: string } | null> {
    const r = (await this.db.query('SELECT bytes, mime FROM seller_videos WHERE id=$1', [id])).rows[0];
    return r ? { bytes: r.bytes, mime: r.mime } : null;
  }
  /** Approve (it goes live, replacing their old one) or reject (with a reason they're told). Returns the seller, or null. */
  async reviewVideo(id: number, approve: boolean, reason: string | null, staffId: string | null): Promise<string | null> {
    const v = (await this.db.query(`SELECT user_id FROM seller_videos WHERE id=$1 AND status='PENDING'`, [id])).rows[0];
    if (!v) return null;
    if (approve) await this.db.query(`DELETE FROM seller_videos WHERE user_id=$1 AND status='APPROVED'`, [v.user_id]);
    await this.db.query(`UPDATE seller_videos SET status=$2, reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1`, [id, approve ? 'APPROVED' : 'REJECTED', approve ? null : reason, staffId]);
    return v.user_id;
  }
  /** Take a live video down (it's deleted). */
  async takeDownVideo(id: number): Promise<string | null> {
    const r = await this.db.query('DELETE FROM seller_videos WHERE id=$1 RETURNING user_id', [id]);
    return r.rows[0]?.user_id ?? null;
  }
}

/** What a buyer can write about a seller, at most. */
export const REVIEW_MAX = 160;
/** A seller's video, at most (about 30 seconds from a phone, as WhatsApp sends it). */
export const VIDEO_MAX_BYTES = 16 * 1024 * 1024;
/** Words a buyer may show on a seller's page: no links, no phone numbers, no emails. */
export function reviewProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < 3) return 'short';
  if (t.length > REVIEW_MAX) return 'long';
  if (/https?:|www\.|\.(com|ng|net|org)\b|@[a-z0-9_]{2,}|(\+?234|0)[789][01]\d{8}|\d{10,}/i.test(t)) return 'contact';
  return null;
}

// ---------- small helpers, exported for tests ----------
export function firstName(name: string | null | undefined): string | null {
  const f = name?.trim().split(/\s+/)[0];
  return f ? f.slice(0, 30) : null;
}

export function slugify(s: string): string {
  const base = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base || 'seller';
}

/** "ADEYEMI BABATUNDE O." vs "Tunde Adeyemi" → true. Ignores very short words. */
export function namesOverlap(bankName: string, names: (string | null | undefined)[]): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3));
  const bank = words(bankName);
  return names.some((n) => n && [...words(n)].some((w) => bank.has(w)));
}

/** "ADEYEMI BABATUNDE OLUWASEUN" → "Adeyemi B." (enough to recognise, not the full legal name). */
export function shortBankName(bankName: string): string {
  const parts = bankName.trim().split(/\s+/).filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return parts.length > 1 ? `${cap(parts[0]!)} ${parts[1]!.charAt(0).toUpperCase()}.` : cap(parts[0] ?? '');
}

export function shipText(hours: number): string {
  if (hours < 1) return 'within an hour';
  if (hours < 20) return `in about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  if (hours < 36) return 'in about 1 day';
  return `in about ${Math.round(hours / 24)} days`;
}
