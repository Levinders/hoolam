import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { Db, Queryable } from '../db.js';
import type { Settings } from '../settings.js';
import { categoryTitle } from '../deals/categories.js';
import { formatMoney, type Currency } from '../money.js';
import type { Place } from './areas.js';

/**
 * THE HOOLAM MARKET: sellers list items, buyers browse them near them first and then nationwide, save favourites,
 * and buy one item (or a basket from one seller) as an ordinary Hoolam order. Everything here is rules and data;
 * the WhatsApp side is in market-flow.ts, the pictures in chat-art, the pages in market-page.ts.
 */

export type Delivery = 'pickup' | 'rider' | 'waybill';
export const DELIVERY: Delivery[] = ['pickup', 'rider', 'waybill'];
export const DELIVERY_WORDS: Record<Delivery, string> = { pickup: 'Pickup', rider: 'Dispatch rider', waybill: 'Waybill' };
export type ListingStatus = 'LIVE' | 'PAUSED' | 'HIDDEN' | 'SOLD_OUT' | 'EXPIRED' | 'REMOVED' | 'DELETED';

export interface Listing {
  id: number; code: string; seller_id: string; title: string; details: string | null; category: string;
  price_minor: number; promo_minor: number | null; promo_ends: Date | null; stock: number; delivery: Delivery[];
  area: string | null; city: string | null; state: string | null; status: ListingStatus; status_reason: string | null;
  kept_at: Date | null; expires_at: Date; created_at: Date; updated_at: Date; is_test: boolean;
}
/** A listing as buyers see it: its live price, the seller's record and photo, how many photos. */
export interface Card extends Listing {
  now_minor: number; on_promo: boolean; off_pct: number | null; photos: number;
  seller_name: string; seller_verified: boolean; seller_orders: number; seller_happy: number | null; seller_rated: number; seller_photo: boolean; seller_slug: string | null;
  rank?: number;
}

export interface NewListing {
  title: string; details?: string | null; category: string; priceMinor: number; promoMinor?: number | null; promoEnds?: Date | null;
  stock: number; delivery: Delivery[]; place: Place | null; photos: { bytes: Buffer; mime?: string | null }[];
}

export class MarketError extends Error {}

/** Lowest believable price per category (naira): a phone for ₦500 is almost always a scam. */
const FLOOR: Record<string, number> = { phones: 3000, electronics: 1000, appliances: 2000, home: 500 };
const CEILING_MAJOR = 50_000_000;

/** Is the promo running now? */
export const onPromo = (l: Pick<Listing, 'promo_minor' | 'promo_ends' | 'price_minor'>, now = Date.now()) =>
  !!l.promo_minor && l.promo_minor < l.price_minor && (!l.promo_ends || new Date(l.promo_ends).getTime() > now);
export const nowPrice = (l: Pick<Listing, 'promo_minor' | 'promo_ends' | 'price_minor'>) => (onPromo(l) ? l.promo_minor! : l.price_minor);

/** A short fingerprint of how a photo looks (8×8, light or dark): the same photo re-saved gives the same code. */
export async function photoLook(bytes: Buffer): Promise<string | null> {
  try {
    const px = await sharp(bytes, { failOn: 'none' }).rotate().greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
    const avg = px.reduce((a, b) => a + b, 0) / px.length;
    let bits = 0n;
    for (let i = 0; i < 64; i++) bits = (bits << 1n) | (px[i]! > avg ? 1n : 0n);
    return bits.toString(16).padStart(16, '0');
  } catch { return null; }
}

/** Typed words → what to look for: "black bag under 20k in lagos" → words [black, bag], max ₦20,000, "lagos". */
export function readSearch(text: string): { words: string[]; maxMinor: number | null; minMinor: number | null; where: string | null } {
  let t = ` ${text.toLowerCase()} `;
  const money = (s: string) => { const m = s.replace(/[,₦\s]|naira/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/); return m ? Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1) * 100) : null; };
  let maxMinor: number | null = null, minMinor: number | null = null, where: string | null = null;
  t = t.replace(/\b(?:under|below|less than|max|not more than|within)\s+([₦\d.,]+\s*[km]?)\b/g, (_, v) => { maxMinor = money(v); return ' '; });
  t = t.replace(/\b(?:above|over|from|more than|min)\s+([₦\d.,]+\s*[km]?)\b/g, (_, v) => { minMinor = money(v); return ' '; });
  t = t.replace(/\b(?:in|near|around|at)\s+([a-z][a-z .'-]{1,40})$/g, (_, v) => { where = v.trim(); return ' '; });
  const STOP = new Set(['i', 'want', 'need', 'looking', 'for', 'a', 'an', 'the', 'some', 'any', 'show', 'me', 'buy', 'please', 'pls', 'abeg', 'of', 'and', 'with', 'new', 'good', 'cheap']);
  const words = t.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).slice(0, 6);
  return { words, maxMinor, minMinor, where };
}

export interface SearchOptions {
  place: Place | null;      // null = all Nigeria
  ring: number;             // 0 area · 1 city · 2 state · 3 all Nigeria
  category?: string | null;
  words?: string[];
  minMinor?: number | null; maxMinor?: number | null;
  verifiedOnly?: boolean; promoOnly?: boolean;
  sellerId?: string | null; ids?: number[] | null; // a seller's items · saved items
  page: number; pageSize?: number;
}
export const RING_WORDS = ['near you', 'your city', 'your state', 'all Nigeria'];
/** The smallest ring a place starts at: its area, else its city, else its state, else all Nigeria. */
export const startRing = (p: Place | null) => (!p ? 3 : p.area ? 0 : p.city ? 1 : 2);

export interface MarketOptions {
  db: Db;
  settings: Settings;
  currency: Currency;
  /** The seller's ID check and payout account (both needed before listing). */
  verified: (userId: string) => Promise<boolean>;
  hasBank: (userId: string) => Promise<boolean>;
  testMode?: boolean;
  log?: (line: string) => void;
}

export class Market {
  constructor(private readonly o: MarketOptions) {}

  cfg() { return this.o.settings.market(); }
  on(): boolean { return this.cfg().on; }
  money(minor: number) { return formatMoney(minor, this.o.currency); }

  // ---------------------------------------------------------------------------------------------
  // sellers: who may list, and how many

  private async sellerRow(userId: string) {
    return (await this.o.db.query('SELECT * FROM market_sellers WHERE user_id=$1', [userId])).rows[0] ?? null;
  }
  async liveCount(userId: string): Promise<number> {
    return (await this.o.db.query(`SELECT count(*)::int AS n FROM market_listings WHERE seller_id=$1 AND status IN ('LIVE','PAUSED','HIDDEN','SOLD_OUT')`, [userId])).rows[0].n;
  }
  /** Their item limit: their own (while a paid upgrade runs, or set by the team), else the setting. */
  async limitFor(userId: string): Promise<number> {
    const r = await this.sellerRow(userId);
    const own = r?.item_limit && (!r.limit_until || new Date(r.limit_until).getTime() > Date.now()) ? Number(r.item_limit) : null;
    return Math.max(own ?? 0, this.cfg().perSeller);
  }

  /** Can this seller list now? The first thing standing in the way, if anything. */
  async canList(user: { id: string; seller_since?: Date | null }): Promise<{ ok: true } | { ok: false; why: 'off' | 'setup' | 'kyc' | 'bank' | 'apply' | 'applied' | 'declined' | 'stopped' | 'limit'; reason?: string | null; limit?: number }> {
    const cfg = this.cfg();
    if (!cfg.on) return { ok: false, why: 'off' };
    if (!user.seller_since) return { ok: false, why: 'setup' };
    const row = await this.sellerRow(user.id);
    if (row?.status === 'STOPPED') return { ok: false, why: 'stopped', reason: row.reason };
    if (cfg.approval) {
      if (!row) return { ok: false, why: 'apply' };
      if (row.status === 'APPLIED') return { ok: false, why: 'applied' };
      if (row.status === 'DECLINED') return { ok: false, why: 'declined', reason: row.reason };
    }
    if (!(await this.o.verified(user.id))) return { ok: false, why: 'kyc' };
    if (!(await this.o.hasBank(user.id))) return { ok: false, why: 'bank' };
    const limit = await this.limitFor(user.id);
    if ((await this.liveCount(user.id)) >= limit) return { ok: false, why: 'limit', limit };
    return { ok: true };
  }

  async apply(userId: string, note: string | null): Promise<void> {
    await this.o.db.query(
      `INSERT INTO market_sellers (user_id, status, note) VALUES ($1,'APPLIED',$2)
       ON CONFLICT (user_id) DO UPDATE SET status='APPLIED', note=COALESCE(EXCLUDED.note, market_sellers.note), reason=NULL, created_at=now()
       WHERE market_sellers.status IN ('DECLINED','APPLIED')`, [userId, note?.slice(0, 200) ?? null]);
  }
  async decide(userId: string, ok: boolean, reason: string | null, staffId: string | null): Promise<void> {
    await this.o.db.query(
      `INSERT INTO market_sellers (user_id, status, reason, decided_by, decided_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, decided_by=EXCLUDED.decided_by, decided_at=now()`,
      [userId, ok ? 'APPROVED' : 'DECLINED', ok ? null : reason, staffId]);
  }
  /** Stop or let a seller list again (strikes, or the team's call). Stopping pauses their live items. */
  async setStopped(userId: string, stopped: boolean, reason: string | null, staffId: string | null): Promise<void> {
    await this.o.db.query(
      `INSERT INTO market_sellers (user_id, status, reason, decided_by, decided_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, decided_by=EXCLUDED.decided_by, decided_at=now()`,
      [userId, stopped ? 'STOPPED' : 'APPROVED', stopped ? reason : null, staffId]);
    if (stopped) await this.o.db.query(`UPDATE market_listings SET status='PAUSED', status_reason=$2, updated_at=now() WHERE seller_id=$1 AND status='LIVE'`, [userId, reason ?? 'Listing stopped']);
    else await this.o.db.query(`DELETE FROM market_strikes WHERE user_id=$1`, [userId]);
  }
  async setLimit(userId: string, limit: number | null, until: Date | null, staffId: string | null): Promise<void> {
    await this.o.db.query(
      `INSERT INTO market_sellers (user_id, item_limit, limit_until, decided_by, decided_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (user_id) DO UPDATE SET item_limit=EXCLUDED.item_limit, limit_until=EXCLUDED.limit_until, decided_by=EXCLUDED.decided_by, decided_at=now()`,
      [userId, limit, until, staffId]);
  }

  /** "Get more items": asked once until the team answers. */
  async askUpgrade(userId: string): Promise<{ items: number; priceMinor: number; already: boolean }> {
    const u = this.cfg().upgrade;
    const open = (await this.o.db.query(`SELECT 1 FROM market_upgrades WHERE user_id=$1 AND status='ASKED'`, [userId])).rowCount;
    if (!open) await this.o.db.query('INSERT INTO market_upgrades (user_id, items, amount_minor) VALUES ($1,$2,$3)', [userId, u.items, u.priceMinor]);
    return { items: u.items, priceMinor: u.priceMinor, already: !!open };
  }
  /** The team confirms an upgrade was paid: the seller's limit rises for 30 days. */
  async doneUpgrade(id: number, ok: boolean, reference: string | null, staffId: string | null): Promise<{ userId: string; items: number } | null> {
    const r = (await this.o.db.query(`UPDATE market_upgrades SET status=$2, reference=$3, decided_by=$4, decided_at=now() WHERE id=$1 AND status='ASKED' RETURNING *`,
      [id, ok ? 'DONE' : 'DECLINED', reference, staffId])).rows[0];
    if (!r) return null;
    if (ok) {
      const row = await this.sellerRow(r.user_id);
      const from = row?.limit_until && new Date(row.limit_until).getTime() > Date.now() ? new Date(row.limit_until).getTime() : Date.now();
      await this.setLimit(r.user_id, Math.max(Number(r.items), Number(row?.item_limit ?? 0)), new Date(from + 30 * 86_400_000), staffId);
    }
    return { userId: r.user_id, items: Number(r.items) };
  }

  // ---------------------------------------------------------------------------------------------
  // listing

  /** Why this listing can't go live, in plain words, or null. */
  async check(sellerId: string, l: Pick<NewListing, 'title' | 'details' | 'category' | 'priceMinor' | 'promoMinor' | 'stock' | 'delivery'>, looks: (string | null)[] = []): Promise<string | null> {
    const cfg = this.cfg();
    const title = (l.title ?? '').trim();
    if (title.length < 3) return 'The item name is too short. Say what it is, like "Nike Air Force 1, size 43".';
    if (title.length > 80) return 'The item name is too long. Keep it under 80 letters.';
    if (!cfg.categories.includes(l.category)) return `${categoryTitle(l.category) ?? 'That category'} isn't open in the market yet. Pick another category.`;
    const text = ` ${`${title} ${l.details ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const bad = cfg.blocked.find((w) => text.includes(` ${w.replace(/[^a-z0-9]+/g, ' ').trim()} `));
    if (bad) return `"${bad}" isn't allowed in the market. Only list items you can sell honestly and legally.`;
    const unit = this.o.currency === 'NGN' ? 100 : 1;
    const floor = (FLOOR[l.category] ?? 100) * unit;
    if (!Number.isInteger(l.priceMinor) || l.priceMinor < floor) return `That price looks too low for ${categoryTitle(l.category)?.toLowerCase() ?? 'this'}. The lowest is ${this.money(floor)}.`;
    if (l.priceMinor > CEILING_MAJOR * unit) return 'That price is too high for the market.';
    if (l.promoMinor != null && (l.promoMinor >= l.priceMinor || l.promoMinor < floor)) return 'The promo price must be lower than the normal price.';
    if (!Number.isInteger(l.stock) || l.stock < 1 || l.stock > 10_000) return 'How many do you have? Type a number from 1.';
    if (!l.delivery.length || l.delivery.some((d) => !DELIVERY.includes(d))) return 'Pick at least one way the buyer gets it.';
    // plain pictures (one colour, nearly blank) say nothing about who took them: only real photos are compared
    const bitsOf = (h: string) => [...BigInt(`0x${h}`).toString(2)].filter((c) => c === '1').length;
    const seen = looks.filter((x): x is string => !!x && bitsOf(x) >= 6 && bitsOf(x) <= 58);
    if (seen.length) {
      const dup = await this.o.db.query(
        `SELECT 1 FROM market_photos p JOIN market_listings l ON l.id=p.listing_id
         WHERE p.look = ANY($1) AND l.seller_id<>$2 AND l.status NOT IN ('DELETED') LIMIT 1`, [seen, sellerId]);
      if (dup.rowCount) return 'One of these photos is already on another seller\'s item. Use your own photos.';
    }
    return null;
  }

  private async newCode(title: string): Promise<string> {
    const word = title.toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(' ').filter((w) => w.length > 1).slice(0, 2).join('-').slice(0, 14) || 'item';
    for (let i = 0; i < 6; i++) {
      const code = `${word}-${randomBytes(3).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4).padEnd(4, 'x')}`;
      if (!(await this.o.db.query('SELECT 1 FROM market_listings WHERE code=$1', [code])).rowCount) return code;
    }
    return `item-${randomBytes(5).toString('hex')}`;
  }

  async create(sellerId: string, l: NewListing): Promise<{ ok: true; listing: Listing } | { ok: false; why: string }> {
    if (!l.photos.length) return { ok: false, why: 'Add at least one photo of the item.' };
    const prepared: { bytes: Buffer; sha: string; look: string | null }[] = [];
    for (const p of l.photos.slice(0, 4)) {
      let bytes: Buffer;
      try { bytes = await sharp(p.bytes, { failOn: 'none' }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer(); }
      catch { return { ok: false, why: 'We couldn\'t read one of the photos. Try another.' }; }
      prepared.push({ bytes, sha: createHash('sha256').update(bytes).digest('hex'), look: await photoLook(bytes) });
    }
    const why = await this.check(sellerId, l, prepared.map((p) => p.look));
    if (why) return { ok: false, why };
    const code = await this.newCode(l.title);
    const days = this.cfg().expireDays;
    const r = await this.o.db.query(
      `INSERT INTO market_listings (code, seller_id, title, details, category, price_minor, promo_minor, promo_ends, stock, delivery, area, city, state, lat, lng, is_test, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now() + make_interval(days => $17)) RETURNING *`,
      [code, sellerId, l.title.trim().slice(0, 80), l.details?.trim().slice(0, 600) || null, l.category, l.priceMinor, l.promoMinor ?? null, l.promoEnds ?? null,
        l.stock, l.delivery, l.place?.area ?? null, l.place?.city || null, l.place?.state ?? null, l.place?.lat ?? null, l.place?.lng ?? null, !!this.o.testMode, days]);
    const listing: Listing = r.rows[0];
    for (const [i, p] of prepared.entries()) {
      await this.o.db.query('INSERT INTO market_photos (listing_id, position, mime, bytes, sha256, look) VALUES ($1,$2,$3,$4,$5,$6)', [listing.id, i, 'image/jpeg', p.bytes, p.sha, p.look]);
    }
    return { ok: true, listing };
  }

  async get(ref: number | string): Promise<Listing | null> {
    const r = typeof ref === 'number'
      ? await this.o.db.query('SELECT * FROM market_listings WHERE id=$1', [ref])
      : await this.o.db.query('SELECT * FROM market_listings WHERE lower(code)=lower($1)', [ref]);
    return r.rows[0] ?? null;
  }
  async photoIds(listingId: number): Promise<number[]> {
    return (await this.o.db.query('SELECT position FROM market_photos WHERE listing_id=$1 ORDER BY position', [listingId])).rows.map((x) => x.position);
  }
  async photo(listingId: number, position = 0): Promise<Buffer | null> {
    return (await this.o.db.query('SELECT bytes FROM market_photos WHERE listing_id=$1 AND position=$2', [listingId, position])).rows[0]?.bytes ?? null;
  }

  /** The seller changes one thing. Returns the listing, or a reason it can't. */
  async edit(sellerId: string, id: number, change:
    | { price: number } | { promo: number | null; ends?: Date | null } | { stock: number } | { delivery: Delivery[] }
    | { action: 'pause' | 'resume' | 'renew' | 'soldout' | 'delete' }): Promise<{ ok: true; listing: Listing; backInStock?: boolean } | { ok: false; why: string }> {
    const l = await this.get(id);
    if (!l || l.seller_id !== sellerId || l.status === 'DELETED') return { ok: false, why: 'That item isn\'t yours, or it was deleted.' };
    if (l.status === 'REMOVED') return { ok: false, why: `This item was removed: ${l.status_reason ?? 'it broke the market rules'}.` };
    const set = async (sql: string, args: unknown[]) => (await this.o.db.query(`UPDATE market_listings SET ${sql}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...args])).rows[0] as Listing;
    if ('price' in change) {
      const why = await this.check(sellerId, { ...this.asInput(l), priceMinor: change.price, promoMinor: l.promo_minor && l.promo_minor < change.price ? l.promo_minor : null });
      if (why) return { ok: false, why };
      return { ok: true, listing: await set('price_minor=$2, promo_minor=CASE WHEN promo_minor < $2 THEN promo_minor END', [change.price]) };
    }
    if ('promo' in change) {
      if (change.promo != null) { const why = await this.check(sellerId, { ...this.asInput(l), promoMinor: change.promo }); if (why) return { ok: false, why }; }
      return { ok: true, listing: await set('promo_minor=$2, promo_ends=$3', [change.promo, change.promo == null ? null : change.ends ?? null]) };
    }
    if ('stock' in change) {
      if (!Number.isInteger(change.stock) || change.stock < 0 || change.stock > 10_000) return { ok: false, why: 'Type how many you have, like 3.' };
      const back = l.status === 'SOLD_OUT' && change.stock > 0;
      const listing = await set(`stock=$2, status=CASE WHEN $2=0 AND status='LIVE' THEN 'SOLD_OUT' WHEN $2>0 AND status='SOLD_OUT' THEN 'LIVE' ELSE status END`, [change.stock]);
      return { ok: true, listing, backInStock: back };
    }
    if ('delivery' in change) {
      if (!change.delivery.length) return { ok: false, why: 'Pick at least one way the buyer gets it.' };
      return { ok: true, listing: await set('delivery=$2', [change.delivery]) };
    }
    const days = this.cfg().expireDays;
    switch (change.action) {
      case 'pause': return { ok: true, listing: await set(`status='PAUSED', status_reason=NULL`, []) };
      case 'resume':
        if (l.status === 'HIDDEN') return { ok: false, why: 'This item is paused while our team looks at it. We\'ll message you.' };
        return { ok: true, listing: await set(`status=CASE WHEN stock>0 THEN 'LIVE' ELSE 'SOLD_OUT' END, status_reason=NULL`, []) };
      case 'renew': return { ok: true, listing: await set(`expires_at=now() + make_interval(days => $2), warned_at=NULL, status=CASE WHEN status='EXPIRED' THEN (CASE WHEN stock>0 THEN 'LIVE' ELSE 'SOLD_OUT' END) ELSE status END`, [days]) };
      case 'soldout': return { ok: true, listing: await set(`stock=0, status='SOLD_OUT'`, []) };
      case 'delete': return { ok: true, listing: await set(`status='DELETED'`, []) };
    }
  }
  private asInput(l: Listing) {
    return { title: l.title, details: l.details, category: l.category, priceMinor: l.price_minor, promoMinor: l.promo_minor, stock: Math.max(1, l.stock), delivery: l.delivery };
  }

  /** A seller's items for My items: counts and the list, newest first. */
  async mine(sellerId: string) {
    const items: Listing[] = (await this.o.db.query(`SELECT * FROM market_listings WHERE seller_id=$1 AND status<>'DELETED' ORDER BY created_at DESC`, [sellerId])).rows;
    const week = (await this.o.db.query(
      `SELECT COALESCE(sum(s.views + s.seen),0)::int AS seen, COALESCE(sum(s.views),0)::int AS views, COALESCE(sum(s.saves),0)::int AS saves, COALESCE(sum(s.orders),0)::int AS orders
       FROM market_stats s JOIN market_listings l ON l.id=s.listing_id WHERE l.seller_id=$1 AND s.day > current_date - 7`, [sellerId])).rows[0];
    const count = (st: ListingStatus) => items.filter((i) => i.status === st).length;
    return { items, live: count('LIVE'), soldOut: count('SOLD_OUT'), paused: count('PAUSED') + count('HIDDEN'), expired: count('EXPIRED'), removed: count('REMOVED'), week, limit: await this.limitFor(sellerId), used: await this.liveCount(sellerId) };
  }
  /** One item's numbers (all time). */
  async itemStats(id: number) {
    return (await this.o.db.query(`SELECT COALESCE(sum(seen),0)::int AS seen, COALESCE(sum(views),0)::int AS views, COALESCE(sum(saves),0)::int AS saves, COALESCE(sum(buys),0)::int AS buys, COALESCE(sum(orders),0)::int AS orders FROM market_stats WHERE listing_id=$1`, [id])).rows[0];
  }

  // ---------------------------------------------------------------------------------------------
  // browsing

  private cardSql(where: string, order: string) {
    return `SELECT l.*, COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS seller_name, u.profile_slug AS seller_slug,
        (u.kyc_status = 'VERIFIED') AS seller_verified, EXISTS (SELECT 1 FROM user_photos ph WHERE ph.user_id=u.id) AS seller_photo,
        (SELECT count(*)::int FROM deals d WHERE d.seller_id=u.id AND d.status='COMPLETED') AS seller_orders,
        (SELECT count(*)::int FROM market_photos p WHERE p.listing_id=l.id) AS photos
      FROM market_listings l JOIN users u ON u.id=l.seller_id
      WHERE ${where} ORDER BY ${order}`;
  }
  private toCard(r: any): Card {
    const promo = onPromo(r);
    const now = promo ? Number(r.promo_minor) : Number(r.price_minor);
    return {
      ...r, price_minor: Number(r.price_minor), promo_minor: r.promo_minor == null ? null : Number(r.promo_minor),
      now_minor: now, on_promo: promo, off_pct: promo ? Math.round((100 * (Number(r.price_minor) - now)) / Number(r.price_minor)) : null,
      seller_happy: null, seller_rated: 0,
    };
  }

  /**
   * One page of results, closest first. `rank`: 0 same area · 1 same city · 2 same state · 3 elsewhere. Items that
   * only go by pickup or rider show only in the seller's city; waybill items show nationwide. Within a ring:
   * verified sellers a little higher, then newest.
   */
  async search(o: SearchOptions): Promise<{ cards: Card[]; total: number; wider: number }> {
    const size = o.pageSize ?? 10;
    const args: unknown[] = [];
    const a = (v: unknown) => { args.push(v); return `$${args.length}`; };
    const p = o.place;
    const rank = p
      ? `CASE WHEN ${p.area ? `lower(l.area) = lower(${a(p.area)}) AND lower(l.city) = lower(${a(p.city)})` : 'false'} THEN 0
              WHEN ${p.city ? `lower(l.city) = lower(${a(p.city)})` : 'false'} THEN 1
              WHEN lower(l.state) = lower(${a(p.state)}) THEN 2 ELSE 3 END`
      : '3';
    const conds = [`l.status = 'LIVE'`, `l.stock > 0`, `l.category = ANY(${a(this.cfg().categories)})`];
    if (o.category) conds.push(`l.category = ${a(o.category)}`);
    if (o.sellerId) conds.push(`l.seller_id = ${a(o.sellerId)}`);
    if (o.ids) conds.push(`l.id = ANY(${a(o.ids)})`);
    for (const w of o.words ?? []) conds.push(`(l.title ILIKE ${a(`%${w}%`)} OR l.details ILIKE ${a(`%${w}%`)} OR l.category ILIKE ${a(`%${w}%`)})`);
    const price = `(CASE WHEN l.promo_minor IS NOT NULL AND l.promo_minor < l.price_minor AND (l.promo_ends IS NULL OR l.promo_ends > now()) THEN l.promo_minor ELSE l.price_minor END)`;
    if (o.maxMinor) conds.push(`${price} <= ${a(o.maxMinor)}`);
    if (o.minMinor) conds.push(`${price} >= ${a(o.minMinor)}`);
    if (o.verifiedOnly) conds.push(`u.kyc_status = 'VERIFIED'`);
    if (o.promoOnly) conds.push(`l.promo_minor IS NOT NULL AND l.promo_minor < l.price_minor AND (l.promo_ends IS NULL OR l.promo_ends > now())`);
    // who can get it: same city for pickup and rider; anywhere by waybill
    const reach = p && !o.sellerId && !o.ids ? `(${rank} <= 1 OR 'waybill' = ANY(l.delivery))` : 'true';
    const base = `${conds.join(' AND ')} AND ${reach}`;
    const sql = (ring: number) => `${base} AND (${rank}) <= ${ring}`;
    const total = (await this.o.db.query(`SELECT count(*)::int AS n FROM market_listings l JOIN users u ON u.id=l.seller_id WHERE ${sql(o.ring)}`, args)).rows[0].n as number;
    const wider = o.ring < 3 ? (await this.o.db.query(`SELECT count(*)::int AS n FROM market_listings l JOIN users u ON u.id=l.seller_id WHERE ${sql(3)}`, args)).rows[0].n - total : 0;
    const rows = (await this.o.db.query(
      `${this.cardSql(sql(o.ring), `${rank}, (u.kyc_status = 'VERIFIED') DESC, l.created_at DESC, l.id DESC`)} LIMIT ${size} OFFSET ${Math.max(0, o.page) * size}`.replace('SELECT l.*', `SELECT l.*, ${rank} AS rank`), args)).rows;
    return { cards: rows.map((r) => this.toCard(r)), total, wider };
  }

  /** Categories that have live items (for the market home), with counts. */
  async categoriesWithItems(): Promise<{ id: string; n: number }[]> {
    const r = await this.o.db.query(`SELECT category AS id, count(*)::int AS n FROM market_listings WHERE status='LIVE' AND stock>0 AND category = ANY($1) GROUP BY category ORDER BY n DESC`, [this.cfg().categories]);
    return r.rows;
  }

  async card(ref: number | string): Promise<Card | null> {
    const r = await this.o.db.query(this.cardSql(typeof ref === 'number' ? 'l.id=$1' : 'lower(l.code)=lower($1)', 'l.id'), [ref]);
    return r.rows[0] ? this.toCard(r.rows[0]) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // where buyers browse, their saves and basket

  async browser(userId: string): Promise<{ place: (Place & { all?: boolean }) | null; browse: any; basket: { sellerId: string; items: { id: number; qty: number }[] } | null; updates_ok: boolean | null; asked_at: Date | null }> {
    const r = (await this.o.db.query('SELECT * FROM market_browsers WHERE user_id=$1', [userId])).rows[0];
    return { place: r?.place ?? null, browse: r?.browse ?? null, basket: r?.basket ?? null, updates_ok: r?.updates_ok ?? null, asked_at: r?.asked_at ?? null };
  }
  async setBrowser(userId: string, patch: { place?: unknown; browse?: unknown; basket?: unknown; updates_ok?: boolean | null; asked?: boolean }): Promise<void> {
    await this.o.db.query(`INSERT INTO market_browsers (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const sets: string[] = [], args: unknown[] = [userId];
    for (const k of ['place', 'browse', 'basket'] as const) if (k in patch) { args.push(patch[k] == null ? null : JSON.stringify(patch[k])); sets.push(`${k}=$${args.length}`); }
    if ('updates_ok' in patch) { args.push(patch.updates_ok); sets.push(`updates_ok=$${args.length}`); }
    if (patch.asked) sets.push('asked_at=now()');
    if (sets.length) await this.o.db.query(`UPDATE market_browsers SET ${sets.join(', ')}, updated_at=now() WHERE user_id=$1`, args);
  }

  async save(userId: string, listingId: number, on: boolean): Promise<void> {
    if (on) {
      const r = await this.o.db.query('INSERT INTO market_saves (user_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, listingId]);
      if (r.rowCount) await this.bump(listingId, 'saves');
    } else await this.o.db.query('DELETE FROM market_saves WHERE user_id=$1 AND listing_id=$2', [userId, listingId]);
  }
  async saved(userId: string): Promise<number[]> {
    return (await this.o.db.query(`SELECT s.listing_id FROM market_saves s JOIN market_listings l ON l.id=s.listing_id WHERE s.user_id=$1 AND l.status NOT IN ('DELETED','REMOVED') ORDER BY s.created_at DESC`, [userId])).rows.map((x) => Number(x.listing_id));
  }
  async isSaved(userId: string, listingId: number): Promise<boolean> {
    return !!(await this.o.db.query('SELECT 1 FROM market_saves WHERE user_id=$1 AND listing_id=$2', [userId, listingId])).rowCount;
  }
  /** Saved cards, sold-out ones included (greyed), newest saved first. */
  async savedCards(userId: string): Promise<Card[]> {
    const ids = await this.saved(userId);
    if (!ids.length) return [];
    const rows = (await this.o.db.query(this.cardSql(`l.id = ANY($1)`, `array_position($1::bigint[], l.id)`), [ids])).rows;
    return rows.map((r) => this.toCard(r));
  }

  /** The basket holds one seller's items. Adding another seller's item says so instead. */
  async addToBasket(userId: string, listing: Listing, qty = 1): Promise<{ ok: true; items: number } | { ok: false; otherSeller: string }> {
    const b = (await this.browser(userId)).basket;
    if (b && b.sellerId !== listing.seller_id && b.items.length) return { ok: false, otherSeller: b.sellerId };
    const items = b && b.sellerId === listing.seller_id ? b.items.filter((i) => i.id !== listing.id) : [];
    items.push({ id: listing.id, qty: Math.max(1, Math.min(qty, listing.stock)) });
    await this.setBrowser(userId, { basket: { sellerId: listing.seller_id, items: items.slice(-10) } });
    return { ok: true, items: items.length };
  }
  async basket(userId: string): Promise<{ sellerId: string; lines: { listing: Card; qty: number }[]; totalMinor: number } | null> {
    const b = (await this.browser(userId)).basket;
    if (!b?.items?.length) return null;
    const lines: { listing: Card; qty: number }[] = [];
    for (const i of b.items) {
      const c = await this.card(i.id);
      if (c && c.status === 'LIVE' && c.stock > 0) lines.push({ listing: c, qty: Math.min(i.qty, c.stock) });
    }
    if (!lines.length) return null;
    return { sellerId: b.sellerId, lines, totalMinor: lines.reduce((s, l) => s + l.listing.now_minor * l.qty, 0) };
  }
  async clearBasket(userId: string, listingId?: number): Promise<void> {
    const b = (await this.browser(userId)).basket;
    if (!b) return;
    const items = listingId ? b.items.filter((i) => i.id !== listingId) : [];
    await this.setBrowser(userId, { basket: items.length ? { ...b, items } : null });
  }

  // ---------------------------------------------------------------------------------------------
  // reports, counts

  /** A buyer reports an item. Enough reports from different buyers hide it until the team looks. */
  async report(listingId: number, userId: string, reason: string): Promise<{ hidden: boolean; listing: Listing | null }> {
    await this.o.db.query('INSERT INTO market_reports (listing_id, user_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [listingId, userId, reason.slice(0, 120)]);
    const n = (await this.o.db.query('SELECT count(*)::int AS n FROM market_reports WHERE listing_id=$1', [listingId])).rows[0].n;
    if (n >= this.cfg().reportsHide) {
      const r = await this.o.db.query(`UPDATE market_listings SET status='HIDDEN', status_reason='Reported by buyers', updated_at=now() WHERE id=$1 AND status='LIVE' AND kept_at IS NULL RETURNING *`, [listingId]);
      if (r.rows[0]) return { hidden: true, listing: r.rows[0] };
    }
    return { hidden: false, listing: null };
  }

  async bump(listingId: number | number[], kind: 'seen' | 'views' | 'saves' | 'buys' | 'orders', by = 1): Promise<void> {
    const ids = Array.isArray(listingId) ? listingId : [listingId];
    if (!ids.length) return;
    await this.o.db.query(
      `INSERT INTO market_stats (listing_id, day, ${kind}) SELECT x, current_date, $2 FROM unnest($1::bigint[]) AS x
       ON CONFLICT (listing_id, day) DO UPDATE SET ${kind} = market_stats.${kind} + EXCLUDED.${kind}`, [ids, by]).catch((e) => this.o.log?.(`market stats: ${(e as Error).message}`));
  }
  async logSearch(query: string, found: number): Promise<void> {
    await this.o.db.query('INSERT INTO market_searches (query, found) VALUES ($1,$2)', [query.slice(0, 120), found]).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------
  // orders from the market

  async attachOrder(q: Queryable, dealId: string, lines: { listing: Listing; qty: number; priceMinor: number }[]): Promise<void> {
    for (const l of lines) {
      await q.query('INSERT INTO market_order_items (deal_id, listing_id, qty, price_minor, title) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [dealId, l.listing.id, l.qty, l.priceMinor, l.listing.title]);
    }
    await q.query('UPDATE deals SET from_market=true WHERE id=$1', [dealId]);
  }
  async orderItems(dealId: string): Promise<{ listing_id: number; qty: number; price_minor: number; title: string; code: string; stock: number; status: ListingStatus }[]> {
    return (await this.o.db.query(`SELECT i.*, l.code, l.stock, l.status FROM market_order_items i JOIN market_listings l ON l.id=i.listing_id WHERE i.deal_id=$1`, [dealId])).rows;
  }
  /** Before paying: is everything in this order still in stock? The first item that isn't, or null. */
  async outOfStock(dealId: string): Promise<string | null> {
    for (const i of await this.orderItems(dealId)) if (i.stock < i.qty || !['LIVE', 'SOLD_OUT'].includes(i.status) || i.stock === 0) return i.title;
    return null;
  }
  /** The buyer paid: stock goes down (once), and items that reach 0 are sold out. Returns the ones that sold out. */
  async onPaid(dealId: string): Promise<Listing[]> {
    const soldOut: Listing[] = [];
    for (const i of await this.orderItems(dealId)) {
      const taken = await this.o.db.query(`UPDATE market_order_items SET stock_taken=true WHERE deal_id=$1 AND listing_id=$2 AND NOT stock_taken RETURNING 1`, [dealId, i.listing_id]);
      if (!taken.rowCount) continue;
      const r = (await this.o.db.query(
        `UPDATE market_listings SET stock=GREATEST(0, stock-$2), status=CASE WHEN stock-$2 <= 0 AND status='LIVE' THEN 'SOLD_OUT' ELSE status END, updated_at=now() WHERE id=$1 RETURNING *`, [i.listing_id, i.qty])).rows[0];
      await this.bump(i.listing_id, 'orders');
      if (r?.status === 'SOLD_OUT' && r.stock === 0) soldOut.push(r);
    }
    return soldOut;
  }
  /** Refunded or cancelled after payment: the stock comes back. Returns items back in stock. */
  async onRefund(dealId: string): Promise<Listing[]> {
    const back: Listing[] = [];
    for (const i of await this.orderItems(dealId)) {
      const given = await this.o.db.query(`UPDATE market_order_items SET stock_taken=false WHERE deal_id=$1 AND listing_id=$2 AND stock_taken RETURNING 1`, [dealId, i.listing_id]);
      if (!given.rowCount) continue;
      const r = (await this.o.db.query(`UPDATE market_listings SET stock=stock+$2, status=CASE WHEN status='SOLD_OUT' THEN 'LIVE' ELSE status END, updated_at=now() WHERE id=$1 RETURNING *`, [i.listing_id, i.qty])).rows[0];
      if (r && i.status === 'SOLD_OUT') back.push(r);
    }
    return back;
  }

  // ---------------------------------------------------------------------------------------------
  // keeping it clean: expiry, the regular check, strikes

  /** Due: listings to warn (3 days before) and listings that expire now. */
  async expiryDue(): Promise<{ warn: Listing[]; expired: Listing[] }> {
    const warn = (await this.o.db.query(`UPDATE market_listings SET warned_at=now() WHERE status IN ('LIVE','SOLD_OUT','PAUSED') AND warned_at IS NULL AND expires_at < now() + interval '3 days' AND expires_at > now() RETURNING *`)).rows;
    const expired = (await this.o.db.query(`UPDATE market_listings SET status='EXPIRED', updated_at=now() WHERE status IN ('LIVE','SOLD_OUT','PAUSED') AND expires_at <= now() RETURNING *`)).rows;
    return { warn, expired };
  }
  /** Promos that ended: cleared, so the normal price shows. Returns them for the seller's message. */
  async promosEnded(): Promise<Listing[]> {
    return (await this.o.db.query(`UPDATE market_listings SET promo_minor=NULL, promo_ends=NULL, updated_at=now() WHERE promo_minor IS NOT NULL AND promo_ends IS NOT NULL AND promo_ends <= now() AND status<>'DELETED' RETURNING *`)).rows;
  }

  async keep(id: number, staffId: string | null): Promise<Listing | null> {
    return (await this.o.db.query(`UPDATE market_listings SET kept_at=now(), kept_by=$2, status=CASE WHEN status='HIDDEN' THEN (CASE WHEN stock>0 THEN 'LIVE' ELSE 'SOLD_OUT' END) ELSE status END, status_reason=CASE WHEN status='HIDDEN' THEN NULL ELSE status_reason END WHERE id=$1 RETURNING *`, [id, staffId])).rows[0] ?? null;
  }
  /** The team removes a listing: a strike for the seller; at the set number, listing stops. */
  async remove(id: number, reason: string, staffId: string | null): Promise<{ listing: Listing; stopped: boolean } | null> {
    const l: Listing | undefined = (await this.o.db.query(`UPDATE market_listings SET status='REMOVED', status_reason=$2, kept_at=now(), kept_by=$3, updated_at=now() WHERE id=$1 AND status<>'REMOVED' RETURNING *`, [id, reason, staffId])).rows[0];
    if (!l) return null;
    await this.o.db.query('INSERT INTO market_strikes (user_id, listing_id, reason) VALUES ($1,$2,$3)', [l.seller_id, l.id, reason]);
    const n = (await this.o.db.query(`SELECT count(*)::int AS n FROM market_strikes WHERE user_id=$1 AND created_at > now() - interval '90 days'`, [l.seller_id])).rows[0].n;
    const stopped = n >= this.cfg().strikes;
    if (stopped) await this.setStopped(l.seller_id, true, `${n} items were removed`, staffId);
    return { listing: l, stopped };
  }

  // ---------------------------------------------------------------------------------------------
  // the console

  /** Listings since the last check (never kept or removed), newest first, with reports. */
  async toCheck(limit = 60) {
    return (await this.o.db.query(
      `SELECT l.id, l.code, l.title, l.details, l.category, l.price_minor, l.promo_minor, l.promo_ends, l.stock, l.status, l.status_reason, l.city, l.area, l.created_at, l.delivery,
        COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS seller_name, u.id AS seller_id, u.kyc_status,
        (SELECT count(*)::int FROM market_reports r WHERE r.listing_id=l.id) AS reports,
        (SELECT array_agg(DISTINCT r.reason) FROM market_reports r WHERE r.listing_id=l.id) AS reasons
       FROM market_listings l JOIN users u ON u.id=l.seller_id
       WHERE l.kept_at IS NULL AND l.status NOT IN ('DELETED','REMOVED')
       ORDER BY (l.status='HIDDEN') DESC, l.created_at DESC LIMIT $1`, [limit])).rows;
  }
  async listings(o: { q?: string; status?: string; limit?: number }) {
    const conds = [`l.status<>'DELETED'`], args: unknown[] = [];
    if (o.status) { args.push(o.status); conds.push(`l.status=$${args.length}`); }
    if (o.q) { args.push(`%${o.q}%`); conds.push(`(l.title ILIKE $${args.length} OR l.code ILIKE $${args.length} OR u.display_name ILIKE $${args.length} OR u.business_name ILIKE $${args.length})`); }
    return (await this.o.db.query(
      `SELECT l.id, l.code, l.title, l.category, l.price_minor, l.promo_minor, l.promo_ends, l.stock, l.status, l.status_reason, l.city, l.created_at, l.kept_at,
        COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS seller_name, u.id AS seller_id,
        COALESCE((SELECT sum(views) FROM market_stats s WHERE s.listing_id=l.id),0)::int AS views,
        COALESCE((SELECT sum(orders) FROM market_stats s WHERE s.listing_id=l.id),0)::int AS orders,
        (SELECT count(*)::int FROM market_reports r WHERE r.listing_id=l.id) AS reports
       FROM market_listings l JOIN users u ON u.id=l.seller_id WHERE ${conds.join(' AND ')}
       ORDER BY l.created_at DESC LIMIT ${Math.min(500, o.limit ?? 200)}`, args)).rows;
  }
  async applications() {
    return (await this.o.db.query(
      `SELECT s.user_id, s.status, s.note, s.reason, s.created_at, s.decided_at, COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS name, u.phone, u.kyc_status,
         (SELECT count(*)::int FROM deals d WHERE d.seller_id=u.id AND d.status='COMPLETED') AS completed
       FROM market_sellers s JOIN users u ON u.id=s.user_id WHERE s.status IN ('APPLIED','DECLINED','STOPPED') ORDER BY (s.status='APPLIED') DESC, s.created_at DESC LIMIT 200`)).rows;
  }
  /** Everyone who has listed: live items, their limit, strikes, sales from the market. */
  async sellers() {
    return (await this.o.db.query(
      `SELECT u.id AS user_id, COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS name, u.phone, u.kyc_status,
         ms.status, ms.reason, ms.item_limit, ms.limit_until,
         count(l.id) FILTER (WHERE l.status IN ('LIVE','PAUSED','HIDDEN','SOLD_OUT'))::int AS items,
         count(l.id) FILTER (WHERE l.status='LIVE')::int AS live,
         (SELECT count(*)::int FROM market_strikes k WHERE k.user_id=u.id AND k.created_at > now() - interval '90 days') AS strikes,
         (SELECT count(*)::int FROM deals d WHERE d.seller_id=u.id AND d.from_market AND d.funded_at IS NOT NULL) AS orders,
         max(l.created_at) AS last_listed
       FROM market_listings l JOIN users u ON u.id=l.seller_id LEFT JOIN market_sellers ms ON ms.user_id=u.id
       WHERE l.status<>'DELETED' GROUP BY u.id, ms.user_id ORDER BY max(l.created_at) DESC LIMIT 300`)).rows
      .map((r: any) => ({ ...r, limit: r.item_limit && (!r.limit_until || new Date(r.limit_until) > new Date()) ? r.item_limit : this.cfg().perSeller }));
  }
  async upgrades() {
    return (await this.o.db.query(
      `SELECT g.*, COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS name, u.phone
       FROM market_upgrades g JOIN users u ON u.id=g.user_id ORDER BY (g.status='ASKED') DESC, g.created_at DESC LIMIT 200`)).rows;
  }

  /** Market numbers for the console: totals, the last 30 days by day, what sells, what buyers look for. */
  async overview() {
    const db = this.o.db;
    const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0];
    const totals = await one(
      `SELECT count(*) FILTER (WHERE status='LIVE')::int AS live, count(*) FILTER (WHERE status='SOLD_OUT')::int AS sold_out,
         count(*) FILTER (WHERE status IN ('HIDDEN'))::int AS hidden, count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status<>'DELETED')::int AS new_week,
         count(DISTINCT seller_id) FILTER (WHERE status='LIVE')::int AS sellers,
         count(*) FILTER (WHERE kept_at IS NULL AND status NOT IN ('DELETED','REMOVED'))::int AS to_check
       FROM market_listings`);
    const activity = await one(
      `SELECT COALESCE(sum(seen),0)::int AS seen, COALESCE(sum(views),0)::int AS views, COALESCE(sum(saves),0)::int AS saves, COALESCE(sum(buys),0)::int AS buys, COALESCE(sum(orders),0)::int AS orders
       FROM market_stats WHERE day > current_date - 30`);
    const money = await one(
      `SELECT count(*)::int AS orders, COALESCE(sum(price_minor),0)::bigint AS sales_minor, COALESCE(sum(fee_minor + txn_fee_minor),0)::bigint AS earned_minor
       FROM deals WHERE from_market AND funded_at IS NOT NULL AND funded_at > now() - interval '30 days' AND status NOT IN ('REFUNDED','REFUNDING')`);
    const days = (await db.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(sum(s.views),0)::int AS views, COALESCE(sum(s.buys),0)::int AS buys, COALESCE(sum(s.orders),0)::int AS orders,
         (SELECT count(*)::int FROM market_listings l WHERE l.created_at::date = d) AS listed
       FROM generate_series(current_date - 29, current_date, interval '1 day') AS d LEFT JOIN market_stats s ON s.day = d
       GROUP BY d ORDER BY d`)).rows;
    const top = (await db.query(
      `SELECT l.id, l.code, l.title, l.price_minor, COALESCE(nullif(u.business_name, ''), u.display_name, 'Seller') AS seller,
         sum(s.views)::int AS views, sum(s.saves)::int AS saves, sum(s.orders)::int AS orders
       FROM market_stats s JOIN market_listings l ON l.id=s.listing_id JOIN users u ON u.id=l.seller_id
       WHERE s.day > current_date - 30 GROUP BY l.id, u.id ORDER BY sum(s.orders) DESC, sum(s.views) DESC LIMIT 8`)).rows;
    const categories = (await db.query(
      `SELECT l.category, count(DISTINCT l.id) FILTER (WHERE l.status='LIVE')::int AS live, COALESCE(sum(s.views),0)::int AS views, COALESCE(sum(s.orders),0)::int AS orders
       FROM market_listings l LEFT JOIN market_stats s ON s.listing_id=l.id AND s.day > current_date - 30
       WHERE l.status<>'DELETED' GROUP BY l.category ORDER BY views DESC`)).rows;
    const searches = (await db.query(
      `SELECT lower(query) AS query, count(*)::int AS n, max(found)::int AS found FROM market_searches WHERE created_at > now() - interval '30 days'
       GROUP BY lower(query) ORDER BY count(*) DESC LIMIT 12`)).rows;
    const missing = (await db.query(
      `SELECT lower(query) AS query, count(*)::int AS n FROM market_searches WHERE created_at > now() - interval '30 days' AND found=0
       GROUP BY lower(query) ORDER BY count(*) DESC LIMIT 8`)).rows;
    const waiting = await one(
      `SELECT (SELECT count(*)::int FROM market_sellers WHERE status='APPLIED') AS applications, (SELECT count(*)::int FROM market_upgrades WHERE status='ASKED') AS upgrades,
         (SELECT count(DISTINCT listing_id)::int FROM market_reports r JOIN market_listings l ON l.id=r.listing_id WHERE l.kept_at IS NULL AND l.status NOT IN ('REMOVED','DELETED')) AS reported`);
    return { totals, activity, money: { orders: money.orders, salesMinor: Number(money.sales_minor), earnedMinor: Number(money.earned_minor) }, days, top, categories, searches, missing, waiting };
  }

  // ---------------------------------------------------------------------------------------------
  // bringing people back (each behind its own switch)

  /** Saved by people who said yes to updates, not yet told: for "back in stock". */
  async waitingFor(listingId: number): Promise<{ user_id: string; phone: string }[]> {
    return (await this.o.db.query(
      `SELECT s.user_id, u.phone FROM market_saves s JOIN users u ON u.id=s.user_id JOIN market_browsers b ON b.user_id=s.user_id
       WHERE s.listing_id=$1 AND b.updates_ok AND (s.told_at IS NULL OR s.told_at < now() - interval '7 days')`, [listingId])).rows;
  }
  async told(userId: string, listingId: number): Promise<void> {
    await this.o.db.query('UPDATE market_saves SET told_at=now() WHERE user_id=$1 AND listing_id=$2', [userId, listingId]);
  }
  /** Past buyers of a seller who said yes to updates and weren't messaged about them this week. */
  async pastBuyers(sellerId: string): Promise<{ user_id: string; phone: string }[]> {
    return (await this.o.db.query(
      `SELECT DISTINCT d.buyer_id AS user_id, u.phone FROM deals d JOIN users u ON u.id=d.buyer_id JOIN market_browsers b ON b.user_id=d.buyer_id
       WHERE d.seller_id=$1 AND d.status='COMPLETED' AND b.updates_ok
         AND (b.news_at IS NULL OR b.news_at < now() - interval '7 days')`, [sellerId])).rows;
  }

  async newsSent(userId: string): Promise<void> {
    await this.o.db.query('UPDATE market_browsers SET news_at=now() WHERE user_id=$1', [userId]);
  }
  /** Sellers who listed something new in the last day, with those items (for "new from sellers you bought from"). */
  async newBySeller(): Promise<Map<string, number[]>> {
    const rows = (await this.o.db.query(`SELECT seller_id, array_agg(id ORDER BY created_at DESC) AS ids FROM market_listings WHERE status='LIVE' AND created_at > now() - interval '1 day' GROUP BY seller_id`)).rows;
    return new Map(rows.map((r: { seller_id: string; ids: string[] }) => [r.seller_id, r.ids.map(Number)]));
  }
  /** Buyers to ask once about updates: a completed order lately, never asked. */
  async toAskUpdates(): Promise<{ user_id: string; phone: string }[]> {
    return (await this.o.db.query(
      `SELECT DISTINCT d.buyer_id AS user_id, u.phone FROM deals d JOIN users u ON u.id=d.buyer_id LEFT JOIN market_browsers b ON b.user_id=d.buyer_id
       WHERE d.status='COMPLETED' AND d.closed_at > now() - interval '2 days' AND b.asked_at IS NULL AND b.updates_ok IS NULL LIMIT 100`)).rows;
  }

  async adLink(listingId: number, name: string): Promise<{ id: number; name: string }> {
    const clean = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'ad';
    const r = await this.o.db.query(`INSERT INTO market_ad_links (listing_id, name) VALUES ($1,$2) ON CONFLICT (listing_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id, name`, [listingId, clean]);
    return r.rows[0];
  }
  async adTap(listingId: number, name: string, kind: 'taps' | 'orders'): Promise<void> {
    await this.o.db.query(`UPDATE market_ad_links SET ${kind}=${kind}+1 WHERE listing_id=$1 AND name=$2`, [listingId, name]).catch(() => {});
  }
  async adLinks(listingId?: number) {
    return (await this.o.db.query(
      `SELECT a.*, l.code, l.title FROM market_ad_links a JOIN market_listings l ON l.id=a.listing_id ${listingId ? 'WHERE a.listing_id=$1' : ''} ORDER BY a.created_at DESC LIMIT 200`, listingId ? [listingId] : [])).rows;
  }
}
