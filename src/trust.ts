import type { Db } from './db.js';

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
  isNew: boolean;
  slug: string | null;
  isPublic: boolean;
}

export interface BuyerStats { name: string; purchases: number; problems: number; refunded: number; isNew: boolean }

const DONE = `('RELEASING','PAYOUT_PENDING','COMPLETED')`;

export class Trust {
  /** includeTest: count pretend-money deals too (only for trying things out on the test number). */
  constructor(private readonly db: Db, private readonly includeTest = false) {}

  async seller(userId: string): Promise<SellerStats | null> {
    const u = (await this.db.query('SELECT id, display_name, business_name, city, created_at, profile_slug, profile_public FROM users WHERE id=$1', [userId])).rows[0];
    if (!u) return null;
    const scope = `seller_id=$1 AND buyer_id IS NOT NULL AND buyer_id<>seller_id AND ($2 OR NOT is_test)`;
    const [d, disputes, ratings, bank] = await Promise.all([
      this.db.query(
        `SELECT count(*) FILTER (WHERE status IN ${DONE})::int AS completed,
                count(DISTINCT buyer_id) FILTER (WHERE status IN ${DONE})::int AS buyers,
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
    ]);
    const row = d.rows[0];
    const bankName: string | null = bank.rows[0]?.account_name ?? null;
    return {
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
      isNew: row.completed < 3,
      slug: u.profile_slug,
      isPublic: u.profile_public,
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
