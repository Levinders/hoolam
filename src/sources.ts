import type { Db } from './db.js';
import type { Inbound } from './whatsapp/inbound.js';

/**
 * WHERE EACH PERSON CAME FROM (Console → a person → Source). Decided once, from their first message:
 *   ad / post     a Facebook or Instagram ad or post ("Send WhatsApp message"): WhatsApp tells us which
 *   ambassador    "… sent me (TOBI)" from an ambassador's link (or the ambassador recorded later)
 *   seller_page   "Buy from @bayo-kicks" from a seller's public page
 *   market(_ad)   "I want to buy this: <item>" from an item page or a shared item, with the ad link's name
 *   campaign      a hoolam.com/<name> link, carried through the website's WhatsApp buttons as "(ref: <name>)"
 *   website       a WhatsApp button on hoolam.com, "(ref: web-<page>)"
 *   order         someone's order reached their number before they ever wrote
 *   direct        none of these (a saved number, word of mouth, a forwarded message)
 */
export type SourceKind = 'ad' | 'post' | 'campaign' | 'website' | 'ambassador' | 'order' | 'seller_page' | 'market' | 'market_ad' | 'direct';

/** "(ref: web-pricing)" or "(ref: ig-nov)" at the end of a message from the website's buttons. */
export const REF_RE = /\s*\(ref:\s*([a-z0-9][a-z0-9-]{0,40})\)\s*$/i;
const SENT_ME = /sent me\s*\(([a-z0-9-]{2,30})\)/i;
const BUY_FROM = /^buy from @([a-z0-9-]{1,40})\b/i;
const BUY_THIS = /\bbuy this:?\s*([a-z0-9]+(?:-[a-z0-9]+)+)\b(?:.*?\bad[: ]+([a-z0-9-]{1,30}))?/i;

export class Sources {
  constructor(private readonly db: Db, private readonly log?: (l: string) => void) {}

  /** What a first message says about where they came from. */
  async detect(m: Inbound, phone: string): Promise<{ kind: SourceKind; detail: Record<string, unknown> }> {
    if (m.referral) {
      const r = m.referral;
      const where = /instagram/i.test(r.url ?? '') ? 'Instagram' : /facebook|fb\./i.test(r.url ?? '') ? 'Facebook' : null;
      return { kind: r.type === 'post' ? 'post' : 'ad', detail: { headline: r.headline, url: r.url, id: r.id, where } };
    }
    const text = m.text ?? '';
    const amb = text.match(SENT_ME)?.[1];
    if (amb) {
      const a = (await this.db.query(
        `SELECT u.id, COALESCE(NULLIF(u.business_name, ''), u.display_name) AS name FROM ambassador_names n JOIN users u ON u.id=n.user_id WHERE n.slug=lower($1)`, [amb]).catch(() => null))?.rows[0];
      return { kind: 'ambassador', detail: { slug: amb.toLowerCase(), by: a?.id ?? null, byName: a?.name ?? null, via: 'link' } };
    }
    const slug = text.match(BUY_FROM)?.[1];
    if (slug) {
      const s = (await this.db.query(`SELECT id, COALESCE(NULLIF(business_name, ''), display_name) AS name FROM users WHERE profile_slug=$1`, [slug.toLowerCase()])).rows[0];
      return { kind: 'seller_page', detail: { slug: slug.toLowerCase(), by: s?.id ?? null, byName: s?.name ?? null } };
    }
    const item = text.match(BUY_THIS);
    if (item) {
      const l = (await this.db.query(`SELECT l.id, l.title, l.seller_id, COALESCE(NULLIF(u.business_name, ''), u.display_name) AS seller FROM market_listings l JOIN users u ON u.id=l.seller_id WHERE lower(l.code)=lower($1)`, [item[1]])).rows[0];
      return { kind: item[2] ? 'market_ad' : 'market', detail: { code: item[1]!.toLowerCase(), ad: item[2]?.toLowerCase() ?? null, title: l?.title ?? null, listing: l?.id ?? null, by: l?.seller_id ?? null, byName: l?.seller ?? null } };
    }
    const ref = text.match(REF_RE)?.[1]?.toLowerCase();
    if (ref) return ref.startsWith('web-') ? { kind: 'website', detail: { page: ref.slice(4) } } : { kind: 'campaign', detail: { slug: ref } };
    // someone's order reached their number before they wrote
    const d = (await this.db.query(
      `SELECT d.code, CASE WHEN d.started_by='SELLER' THEN d.seller_id ELSE d.buyer_id END AS by,
         CASE WHEN d.started_by='SELLER' THEN 'buyer' ELSE 'seller' END AS role
       FROM deals d WHERE d.invited_phone=$1 ORDER BY d.created_at LIMIT 1`, [phone])).rows[0];
    if (d) {
      const by = d.by ? (await this.db.query(`SELECT COALESCE(NULLIF(business_name, ''), display_name) AS name FROM users WHERE id=$1`, [d.by])).rows[0]?.name ?? null : null;
      return { kind: 'order', detail: { code: d.code, by: d.by, byName: by, role: d.role } };
    }
    return { kind: 'direct', detail: {} };
  }

  /** On someone's first message: their source, once (an earlier one is never replaced). */
  async first(m: Inbound, userId: string): Promise<void> {
    try {
      const s = await this.detect(m, m.phone);
      await this.db.query(`UPDATE users SET source=$2, source_detail=$3, source_at=now() WHERE id=$1 AND source IS NULL`, [userId, s.kind, JSON.stringify(s.detail)]);
    } catch (e) { this.log?.(`source: ${(e as Error).message}`); }
  }

  /** New people in the last N days by source, for Insights. */
  async summary(days = 30): Promise<{ source: string; n: number }[]> {
    return (await this.db.query(
      `SELECT COALESCE(source, 'unknown') AS source, count(*)::int AS n FROM users WHERE created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 2 DESC`, [days])).rows;
  }
}
