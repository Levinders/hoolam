import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { withTx, type Db, type Queryable, type Tx } from '../db.js';
import { balance, post } from '../ledger.js';
import type { Currency } from '../money.js';
import { quote, type FeePayer } from '../pricing.js';
import type { PaymentProvider, PayoutResult } from '../payments/provider.js';
import type { Messenger, Outbound, Template } from '../whatsapp/client.js';
import type { Media } from '../whatsapp/media.js';
import type { Trust } from '../trust.js';
import type { Settings } from '../settings.js';
import type { PricingRules } from '../pricing.js';
import { BUYER_ALERT, dealTemplate, SELLER_ALERT } from '../whatsapp/automation.js';
import { categoryTitle } from './categories.js';
import { msg } from '../whatsapp/messages.js';
import { canMove, DealStatus, type DealStatus as Status } from './states.js';

export interface Deal {
  id: string; code: string; seller_id: string | null; buyer_id: string | null; item: string; currency: Currency;
  price_minor: number; fee_minor: number; buyer_pays_minor: number; seller_gets_minor: number;
  seller_account_id: string | null; status: Status; created_at: Date; funded_at: Date | null; shipped_at: Date | null;
  started_by: 'SELLER' | 'BUYER'; invited_phone: string | null; arrive_by: string | Date | null; accept_by: Date | null;
  fee_payer: 'BUYER' | 'SELLER'; counter_price_minor: number | null; counter_seller_id: string | null; counter_account_id: string | null;
  shipping_note: string | null;
  description: string | null; category: string | null; delivery_fee_minor: number | string;
  delivery_address: string | null; dispatch_method: 'PICKUP' | 'RIDER' | 'WAYBILL' | null; pickup_address: string | null;
  courier_name: string | null; courier_phone: string | null; courier_location: string | null; courier_account_id: string | null;
  dispatched_at: Date | null; handover_code: string | null; handover_tries: number; handed_over_at: Date | null; courier_paid_at: Date | null;
  view_token: string | null;
}

/** What a seller gives us to start a deal. */
export interface SellerDealInput {
  sellerId: string;
  item: string;
  priceMinor: number;
  sellerAccountId: string;
  buyerPhone?: string | null;
  photos?: { mediaId: string; mimeType?: string | null }[];
}

/** What a buyer gives us to start a deal (from the WhatsApp form or the chat questions). */
export interface BuyerDealInput {
  item: string;
  priceMinor: number;
  sellerPhone: string | null;
  arriveBy: string | null;                          // YYYY-MM-DD: when they need it (delivered, or picked up)
  photos: { mediaId: string; mimeType?: string | null }[];
  description?: string | null;
  category?: string | null;
  address?: string | null;                          // where to deliver
}

/** What happened to the alert we tried to send the seller. */
export type SellerAlert = 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed';

export const SELLER_ALERT_TEMPLATE = SELLER_ALERT.name;
export type Alert = SellerAlert;
export type MenuMode = 'buyer' | 'seller';
export interface User {
  id: string; phone: string; display_name: string | null; blocked?: boolean; deal_cap_minor?: number | null;
  /** When they became a seller (null = buyer only). */
  seller_since?: Date | null;
  /** Which menu they see. */
  menu_mode?: MenuMode;
}
export interface BankAccount { id: string; user_id: string; bank_code: string; bank_name: string; account_number: string; account_name: string }

/** Messages to send after the transaction commits. `fallback` is the approved template used if they're outside WhatsApp's 24-hour window. */
type Outbox = { phone: string; message: Outbound; fallback?: Template }[];

export class DealError extends Error {
  constructor(public readonly reason: 'NOT_FOUND' | 'NOT_ALLOWED' | 'OWN_DEAL' | 'TAKEN' | 'CLOSED' | 'TOO_BIG', message?: string) {
    super(message ?? reason);
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function newCode(): string {
  const bytes = randomBytes(5);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'HL-' + s;
}

export interface DealServiceOptions {
  db: Db;
  provider: PaymentProvider;
  messenger: Messenger;
  currency: Currency;
  maxDealMinor: number;
  waNumber: () => string;     // digits, for wa.me links (Console → Settings → WhatsApp)
  payBase?: string;           // short branded payment links, e.g. https://pay.hoolam.com
  testMode?: boolean;         // fake money: allow self-deals and show a test hint
  media?: Media;              // photos in and out of WhatsApp
  trust?: Trust;              // seller and buyer records shown on deals
  settings?: Settings;        // fees, limits and timings the console can change
  acceptHours?: number;       // how long a seller has to accept a buyer's deal (default 48)
  orderPageBase?: string;     // where the private order pages live, e.g. https://hoolam.onrender.com
  log?: (line: string) => void;
}

/** What the seller tells us when dispatching a paid order. */
export interface DispatchInput {
  method: 'PICKUP' | 'RIDER' | 'WAYBILL';
  pickupAddress?: string | null;
  courierName?: string | null;     // rider only
  courierPhone?: string | null;    // rider or waybill driver
  location?: string | null;        // drop-off (rider) or delivery location (waybill)
  feeMinor?: number;               // paid to the rider/driver from the held money once the code is right
  account?: { bank_code: string; bank_name: string; account_number: string; account_name: string } | null;
}

export type CodeResult = 'ok' | 'wrong' | 'locked' | 'not-ready';

export class DealService {
  constructor(private readonly o: DealServiceOptions) {}

  private log(line: string) { this.o.log?.(line); }

  get maxDealMinor(): number { return this.o.settings?.maxDealMinor() ?? this.o.maxDealMinor; }

  /** Fee rules for new deals (the console can change them). */
  pricingRules(): PricingRules | undefined { return this.o.settings?.pricing(); }

  /** The most this person can put in one deal: their own cap if staff set one, else the normal cap. */
  capFor(user: Pick<User, 'deal_cap_minor'>): number { return user.deal_cap_minor ?? this.maxDealMinor; }

  /** Run fn in a transaction; send the queued WhatsApp messages only after it commits. */
  private async run<T>(fn: (tx: Tx, out: Outbox) => Promise<T>): Promise<T> {
    const out: Outbox = [];
    const result = await withTx(this.o.db, (tx) => fn(tx, out));
    for (const o of out) {
      try { await this.o.messenger.send(o.phone, o.message, o.fallback); } catch (e) { this.log(`send failed: ${(e as Error).message}`); }
    }
    return result;
  }

  private money(minor: number) { return { minor, currency: this.o.currency }; }
  private text(minor: number) { return msg.moneyText(this.money(minor)); }

  /** Deals paid with pretend money never count on anyone's trust card. */
  private isTest(): boolean { return this.o.provider.sandbox; }
  /** A line under the payment details while testing: how to "pay" without real money. */
  private payHint(): 'fake' | 'sandbox' | null {
    if (!this.o.provider.sandbox) return null;
    return this.o.provider.name === 'fake' ? (this.o.testMode ? 'fake' : null) : 'sandbox';
  }

  /** "🛡️ Bayo · ✅ 48 deals · 👍 96%", or undefined when trust cards are off. */
  async trustLineFor(sellerId: string | null): Promise<string | undefined> {
    if (!sellerId || !this.o.trust) return undefined;
    const t = await this.o.trust.seller(sellerId);
    return t ? msg.trustLine(t) : undefined;
  }

  async buyerLineFor(buyerId: string | null): Promise<string | undefined> {
    if (!buyerId || !this.o.trust) return undefined;
    const b = await this.o.trust.buyer(buyerId);
    return b ? msg.buyerLine(b) : undefined;
  }

  /** "🛡️ Seller's record" on a deal: the full card. */
  async showSellerRecord(code: string, viewer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    const sellerId = deal.seller_id ?? deal.counter_seller_id;
    const t = sellerId && this.o.trust ? await this.o.trust.seller(sellerId) : null;
    if (!t) { await this.o.messenger.send(viewer.phone, msg.dealStatusNow(deal.code, deal.status)); return; }
    const canPay = deal.status === 'AWAITING_PAYMENT' && deal.buyer_id === viewer.id;
    await this.o.messenger.send(viewer.phone, msg.sellerRecord(msg.trustCardText(t), canPay ? deal.code : null, null));
  }

  /** 👍/👎 after "I'm happy". Only the buyer, only on a released deal, only once. */
  async rateDeal(code: string, buyer: User, happy: boolean): Promise<'ok' | 'already' | 'no'> {
    const deal = await this.findByCode(code);
    if (!deal || deal.buyer_id !== buyer.id || !deal.seller_id || !this.o.trust) return 'no';
    if (!['RELEASING', 'PAYOUT_PENDING', 'COMPLETED'].includes(deal.status)) return 'no';
    const fresh = await this.o.trust.rate(deal.id, buyer.id, deal.seller_id, happy);
    if (!fresh) { await this.o.messenger.send(buyer.phone, msg.alreadyRated()); return 'already'; }
    const seller = await this.userById(this.o.db, deal.seller_id);
    await this.o.messenger.send(buyer.phone, happy ? msg.ratedUp(firstName(seller.display_name) ?? 'the seller') : msg.askRatingComment(deal.code));
    return 'ok';
  }

  async rateComment(code: string, buyer: User, comment: string): Promise<void> {
    const deal = await this.findByCode(code);
    if (deal && this.o.trust) await this.o.trust.rateComment(deal.id, buyer.id, comment);
    await this.o.messenger.send(buyer.phone, msg.ratingCommentThanks());
  }

  /** The seller of a deal that is past the "seller accepted" point. */
  private async sellerOf(q: Queryable, deal: Deal): Promise<User> {
    if (!deal.seller_id) throw new Error(`Deal ${deal.code} has no seller yet`);
    return this.userById(q, deal.seller_id);
  }

  // ---------- users & bank accounts ----------
  async upsertUser(phone: string, name: string | null): Promise<User> {
    const r = await this.o.db.query(
      `INSERT INTO users (phone, display_name) VALUES ($1,$2)
       ON CONFLICT (phone) DO UPDATE SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
       RETURNING id, phone, display_name, blocked, deal_cap_minor, seller_since, menu_mode`,
      [phone, name],
    );
    return r.rows[0];
  }

  async userById(q: Queryable, id: string): Promise<User> {
    const r = await q.query('SELECT id, phone, display_name, blocked, deal_cap_minor, seller_since, menu_mode FROM users WHERE id=$1', [id]);
    return r.rows[0];
  }

  async saveBankAccount(userId: string, a: Omit<BankAccount, 'id' | 'user_id'>): Promise<BankAccount> {
    return withTx(this.o.db, async (tx) => {
      await tx.query('UPDATE bank_accounts SET is_default=false WHERE user_id=$1', [userId]);
      const r = await tx.query(
        `INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_number, account_name, is_default)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (user_id, bank_code, account_number) DO UPDATE SET is_default=true, account_name=EXCLUDED.account_name
         RETURNING *`,
        [userId, a.bank_code, a.bank_name, a.account_number, a.account_name],
      );
      return r.rows[0];
    });
  }

  async defaultBankAccount(userId: string): Promise<BankAccount | null> {
    const r = await this.o.db.query('SELECT * FROM bank_accounts WHERE user_id=$1 AND is_default ORDER BY created_at DESC LIMIT 1', [userId]);
    return r.rows[0] ?? null;
  }

  // ---------- reading ----------
  async findByCode(code: string): Promise<Deal | null> {
    const r = await this.o.db.query('SELECT * FROM deals WHERE code=$1', [code.toUpperCase()]);
    return r.rows[0] ?? null;
  }

  private async lockByCode(tx: Tx, code: string): Promise<Deal> {
    const r = await tx.query('SELECT * FROM deals WHERE code=$1 FOR UPDATE', [code.toUpperCase()]);
    if (!r.rows[0]) throw new DealError('NOT_FOUND');
    return r.rows[0];
  }

  private async lockById(tx: Tx, id: string): Promise<Deal> {
    const r = await tx.query('SELECT * FROM deals WHERE id=$1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw new DealError('NOT_FOUND');
    return r.rows[0];
  }

  /**
   * Which menu someone sees. Choosing "seller" also makes them a seller (their trust card starts) the first time.
   * Updates the user object passed in, so the rest of this request sees the change.
   */
  async setMenuMode(user: User, mode: MenuMode): Promise<void> {
    const r = await this.o.db.query(
      `UPDATE users SET menu_mode=$2::text, seller_since = CASE WHEN $2::text='seller' THEN COALESCE(seller_since, now()) ELSE seller_since END
       WHERE id=$1 RETURNING seller_since, menu_mode`, [user.id, mode]);
    if (r.rows[0]) { user.seller_since = r.rows[0].seller_since; user.menu_mode = r.rows[0].menu_mode; }
  }

  /** Orders where this person is the buyer, or the seller. */
  async recentOrders(userId: string, as: MenuMode, limit = 8): Promise<Deal[]> {
    const col = as === 'seller' ? 'seller_id' : 'buyer_id';
    const r = await this.o.db.query(`SELECT * FROM deals WHERE ${col}=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  }

  async recentDeals(userId: string, limit = 5): Promise<Deal[]> {
    const r = await this.o.db.query('SELECT * FROM deals WHERE seller_id=$1 OR buyer_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    return r.rows;
  }

  /** The only way a deal changes status: checked against the allowed moves and written to the audit log. */
  private async move(tx: Tx, deal: Deal, to: Status, actor: string, note?: string): Promise<void> {
    if (deal.status === to) return;
    if (!canMove(deal.status, to)) throw new DealError('NOT_ALLOWED', `Cannot move ${deal.code} from ${deal.status} to ${to}`);
    const stamp = to === 'FUNDED' ? ', funded_at=now()' : to === 'SHIPPED' ? ', shipped_at=now()' : ['COMPLETED', 'REFUNDED', 'CANCELLED', 'EXPIRED'].includes(to) ? ', closed_at=now()' : '';
    await tx.query(`UPDATE deals SET status=$2, updated_at=now()${stamp} WHERE id=$1`, [deal.id, to]);
    await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)', [deal.id, deal.status, to, actor, note ?? null]);
    deal.status = to;
  }

  // ---------- 1. seller creates ----------
  /** Price, fee and totals. Hoolam's rule: whoever starts the deal pays the fee. */
  previewDeal(priceMinor: number, payer: FeePayer = 'seller', capMinor = this.maxDealMinor) {
    if (priceMinor > capMinor) throw new DealError('TOO_BIG');
    return quote(priceMinor, this.o.currency, this.pricingRules(), payer);
  }

  async createDeal(args: SellerDealInput): Promise<{ deal: Deal; link: string; alert: SellerAlert }> {
    const q = this.previewDeal(args.priceMinor, 'seller', this.capFor(await this.userById(this.o.db, args.sellerId)));
    const photos = await this.fetchPhotos(args.photos ?? []);
    const deal = await this.run(async (tx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const r = await tx.query(
          `INSERT INTO deals (code, seller_id, item, currency, price_minor, fee_minor, buyer_pays_minor, seller_gets_minor, seller_account_id, fee_payer, invited_phone, is_test)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SELLER',$10,$11) ON CONFLICT (code) DO NOTHING RETURNING *`,
          [code, args.sellerId, args.item.slice(0, 200), this.o.currency, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor, args.sellerAccountId, args.buyerPhone ?? null, this.isTest()],
        );
        if (!r.rows[0]) continue;
        const d: Deal = r.rows[0];
        await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor) VALUES ($1,NULL,$2,$3)', [d.id, d.status, 'seller']);
        await this.savePhotos(tx, d.id, args.sellerId, photos, 'ITEM');
        return d;
      }
      throw new Error('Could not allocate a deal code');
    });
    const seller = await this.userById(this.o.db, args.sellerId);
    const alert = await this.alertBuyer(deal, seller);
    return { deal, link: this.payLink(deal.code), alert };
  }

  /** Downloads photos from WhatsApp before a transaction (their links only work for a few minutes). */
  private async fetchPhotos(list: { mediaId: string; mimeType?: string | null }[]) {
    const photos: { mediaId: string; mimeType: string; bytes: Buffer | null; sha256: string | null }[] = [];
    for (const p of list.slice(0, 3)) {
      try {
        const d = this.o.media ? await this.o.media.download(p.mediaId) : null;
        photos.push({ mediaId: p.mediaId, mimeType: d?.mimeType ?? p.mimeType ?? 'image/jpeg', bytes: d?.bytes ?? null, sha256: d?.sha256 ?? null });
      } catch (e) { this.log(`photo ${p.mediaId} skipped: ${(e as Error).message}`); }
    }
    return photos;
  }

  private async savePhotos(tx: Tx, dealId: string, userId: string, photos: Awaited<ReturnType<DealService['fetchPhotos']>>, kind: 'ITEM' | 'SHIPPING') {
    for (const p of photos) {
      await tx.query('INSERT INTO deal_photos (deal_id, uploaded_by, mime_type, bytes, sha256, wa_media_id, kind) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [dealId, userId, p.mimeType, p.bytes, p.sha256, p.mediaId, kind]);
    }
  }

  /** One alert, once, to the buyer's number the seller typed. Never to someone who tapped "Not me". */
  private async alertBuyer(deal: Deal, seller: User): Promise<SellerAlert> {
    const phone = deal.invited_phone;
    if (!phone || !this.alertsOn()) return 'none';
    if (phone === seller.phone && !this.o.testMode) return 'own-number';
    const out = await this.o.db.query('SELECT 1 FROM contact_optouts WHERE phone=$1', [phone]);
    if (out.rowCount) return 'opted-out';
    const name = firstName(seller.display_name) ?? 'A seller';
    const total = msg.moneyText(this.money(deal.buyer_pays_minor));
    const status = await this.o.messenger.sendTemplate(phone, {
      name: BUYER_ALERT.name, language: 'en',
      params: [name, deal.item, total, deal.code],
      buttonPayloads: [`bview:${deal.code}`, `bnotme:${deal.code}`],
      buttonTitles: BUYER_ALERT.buttons,
      preview: `💳 Payment request on Hoolam\n\n${name} is selling you ${deal.item} for ${total}. Order ${deal.code}.`,
    });
    if (status === 'FAILED') { this.log(`buyer alert for ${deal.code} failed; the seller still has the link`); return 'failed'; }
    return 'sent';
  }

  /** "Not me" on a seller's alert: wrong number. Close the deal and never alert that number again. */
  async buyerNotMe(code: string, viewer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      await tx.query('INSERT INTO contact_optouts (phone, reason) VALUES ($1,$2) ON CONFLICT (phone) DO NOTHING', [viewer.phone, `Not me on ${deal.code}`]);
      out.push({ phone: viewer.phone, message: msg.sellerNotMeOk() });
      if (deal.status !== 'AWAITING_BUYER' || deal.invited_phone !== viewer.phone) return;
      await this.move(tx, deal, 'CANCELLED', 'buyer', 'Not me: the alerted number is not the buyer');
      const seller = await this.sellerOf(tx, deal);
      out.push({ phone: seller.phone, message: msg.sellerBuyerNotMe(deal.code) });
    });
  }

  payLink(code: string): string {
    if (this.o.payBase) return `${this.o.payBase.replace(/\/+$/, '')}/${code}`;
    return `https://wa.me/${this.o.waNumber()}?text=${encodeURIComponent('Pay ' + code)}`;
  }


  // ---------- 1b. a BUYER starts the deal ----------
  sellerLink(code: string): string {
    return `https://wa.me/${this.o.waNumber()}?text=${encodeURIComponent('View ' + code)}`;
  }

  private acceptHours(): number { return this.o.settings?.acceptHours() ?? this.o.acceptHours ?? 48; }
  private alertsOn(): boolean { return this.o.settings?.alertsEnabled() ?? true; }

  /**
   * The buyer describes what they're buying. We save it (with photos, as proof of what was promised),
   * give the buyer a link for the seller, and alert the seller directly if the buyer gave their number.
   */
  async createBuyerDeal(buyer: User, input: BuyerDealInput): Promise<{ deal: Deal; link: string; alert: SellerAlert }> {
    const q = this.previewDeal(input.priceMinor, 'buyer', this.capFor(buyer));
    const photos = await this.fetchPhotos(input.photos);
    const deal = await this.run(async (tx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const r = await tx.query(
          `INSERT INTO deals (code, buyer_id, item, currency, price_minor, fee_minor, buyer_pays_minor, seller_gets_minor,
                              status, started_by, fee_payer, invited_phone, arrive_by, accept_by, is_test,
                              description, category, delivery_address, view_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AWAITING_SELLER','BUYER','BUYER',$9,$10, now() + make_interval(hours => $11), $12, $13, $14, $15, $16)
           ON CONFLICT (code) DO NOTHING RETURNING *`,
          [code, buyer.id, input.item.slice(0, 200), this.o.currency, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor,
            input.sellerPhone, input.arriveBy, this.acceptHours(), this.isTest(),
            input.description?.slice(0, 600) ?? null, input.category ?? null, input.address?.slice(0, 300) ?? null, randomBytes(12).toString('base64url')],
        );
        if (!r.rows[0]) continue;
        const d: Deal = r.rows[0];
        await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor) VALUES ($1,NULL,$2,$3)', [d.id, d.status, 'buyer']);
        await this.savePhotos(tx, d.id, buyer.id, photos, 'ITEM');
        return d;
      }
      throw new Error('Could not allocate a deal code');
    });

    const link = this.sellerLink(deal.code);
    const alert = await this.alertSeller(deal, buyer);
    await this.o.messenger.send(buyer.phone, msg.buyDealReady(deal.code, link, alert, this.acceptHours(), this.orderPageUrl(deal)));
    if (alert === 'failed') await this.o.messenger.send(buyer.phone, msg.buyerAlertFailed());
    return { deal, link, alert };
  }

  /** One alert, once, to the number the buyer typed. Never to someone who tapped "Not me". */
  private async alertSeller(deal: Deal, buyer: User): Promise<SellerAlert> {
    const phone = deal.invited_phone;
    if (!phone || !this.alertsOn()) return 'none';
    if (phone === buyer.phone && !this.o.testMode) return 'own-number';
    const out = await this.o.db.query('SELECT 1 FROM contact_optouts WHERE phone=$1', [phone]);
    if (out.rowCount) return 'opted-out';
    const name = firstName(buyer.display_name) ?? 'A buyer';
    const price = msg.moneyText(this.money(deal.price_minor));
    const status = await this.o.messenger.sendTemplate(phone, {
      name: SELLER_ALERT_TEMPLATE, language: 'en',
      params: [name, deal.item, price, deal.code],
      buttonPayloads: [`sview:${deal.code}`, `snotme:${deal.code}`],
      buttonTitles: SELLER_ALERT.buttons,
      preview: `🛒 New order request on Hoolam\n\n${name} wants to buy ${deal.item} from you for ${price}. Order ${deal.code}.`,
    });
    if (status === 'FAILED') { this.log(`seller alert for ${deal.code} failed; the buyer still has the link`); return 'failed'; }
    return 'sent';
  }

  /** Someone opened a buyer's deal (from the alert or the link): show them the photos and what's asked. */
  async showToSeller(code: string, viewer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    if (deal.status !== 'AWAITING_SELLER') {
      const isParty = deal.seller_id === viewer.id || deal.buyer_id === viewer.id;
      await this.o.messenger.send(viewer.phone, isParty ? msg.dealStatusNow(deal.code, deal.status) : deal.seller_id ? msg.dealHasSeller(deal.code) : msg.dealClosed(deal.code));
      return;
    }
    if (deal.buyer_id === viewer.id && !this.o.testMode) {
      await this.o.messenger.send(viewer.phone, msg.ownBuyDeal(deal.code, this.sellerLink(deal.code)));
      return;
    }
    if (deal.counter_seller_id) {
      await this.o.messenger.send(viewer.phone, deal.counter_seller_id === viewer.id ? msg.counterWaiting(deal.code) : msg.dealHasSeller(deal.code));
      return;
    }
    const buyer = await this.userById(this.o.db, deal.buyer_id!);
    for (const mediaId of await this.photoIdsForSending(deal.id)) {
      await this.o.messenger.send(viewer.phone, { kind: 'image', mediaId });
    }
    const hoursLeft = deal.accept_by ? Math.max(1, Math.round((new Date(deal.accept_by).getTime() - Date.now()) / 3600_000)) : this.acceptHours();
    await this.o.messenger.send(viewer.phone, msg.sellerDealCard({
      code: deal.code, buyerName: firstName(buyer.display_name) ?? 'A buyer', item: deal.item,
      description: deal.description, category: categoryTitle(deal.category), address: deal.delivery_address,
      price: this.money(deal.price_minor), sellerGets: this.money(deal.seller_gets_minor),
      arriveBy: deal.arrive_by ? dayText(deal.arrive_by) : null, hoursLeft,
      invited: deal.invited_phone === viewer.phone,
      buyerLine: await this.buyerLineFor(deal.buyer_id),
    }));
  }

  /** Re-uploads the deal's photos to WhatsApp (reusing an upload for up to 25 days). */
  private async photoIdsForSending(dealId: string, kind: 'ITEM' | 'SHIPPING' = 'ITEM'): Promise<string[]> {
    const r = await this.o.db.query('SELECT id, mime_type, bytes, sent_media_id, sent_media_at FROM deal_photos WHERE deal_id=$1 AND kind=$2 ORDER BY id', [dealId, kind]);
    const ids: string[] = [];
    for (const p of r.rows) {
      const fresh = p.sent_media_id && p.sent_media_at && Date.now() - new Date(p.sent_media_at).getTime() < 25 * 86400_000;
      if (fresh) { ids.push(p.sent_media_id); continue; }
      try {
        const id = this.o.media ? await this.o.media.upload(p.bytes, p.mime_type) : 'dry-run-media';
        await this.o.db.query('UPDATE deal_photos SET sent_media_id=$2, sent_media_at=now() WHERE id=$1', [p.id, id]);
        ids.push(id);
      } catch (e) { this.log(`photo ${p.id} upload failed: ${(e as Error).message}`); }
    }
    return ids;
  }

  /** The seller says yes. From here on it's a normal deal: the buyer is asked to pay. */
  async acceptAsSeller(code: string, seller: User, accountId: string): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'AWAITING_SELLER') {
        out.push({ phone: seller.phone, message: deal.seller_id === seller.id ? msg.dealStatusNow(deal.code, deal.status) : deal.seller_id ? msg.dealHasSeller(deal.code) : msg.dealClosed(deal.code) });
        return;
      }
      if (deal.accept_by && new Date(deal.accept_by).getTime() < Date.now()) throw new DealError('CLOSED');
      if (deal.buyer_id === seller.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      if (deal.counter_seller_id && deal.counter_seller_id !== seller.id) { out.push({ phone: seller.phone, message: msg.dealHasSeller(deal.code) }); return; }
      if (deal.counter_seller_id) await tx.query('UPDATE deals SET counter_price_minor=NULL, counter_seller_id=NULL, counter_account_id=NULL WHERE id=$1', [deal.id]);
      const acct = await tx.query('SELECT bank_name, account_number FROM bank_accounts WHERE id=$1 AND user_id=$2', [accountId, seller.id]);
      if (!acct.rows[0]) throw new DealError('NOT_ALLOWED');
      await tx.query('UPDATE deals SET seller_id=$2, seller_account_id=$3 WHERE id=$1', [deal.id, seller.id, accountId]);
      await this.move(tx, deal, 'AWAITING_PAYMENT', 'seller', 'Seller accepted the buyer\'s deal');
      const buyer = await this.userById(tx, deal.buyer_id!);
      out.push({ phone: seller.phone, message: msg.sellerAcceptedOk(deal.code, firstName(buyer.display_name) ?? 'The buyer', acct.rows[0].bank_name, String(acct.rows[0].account_number).slice(-4)) });
      out.push({ phone: buyer.phone, message: msg.buyerSellerAccepted(deal.code, firstName(seller.display_name) ?? 'The seller', deal.item, { price: this.money(deal.price_minor), fee: this.money(deal.buyer_pays_minor - deal.price_minor), pay: this.money(deal.buyer_pays_minor) }, await this.trustLineFor(seller.id)), fallback: dealTemplate('sellerAccepted', [deal.code, this.text(deal.buyer_pays_minor)], [`pay:${deal.code}`]) });
    });
  }


  // ---------- Change price: the seller suggests a different price on a buyer's deal ----------
  async counterAsSeller(code: string, seller: User, accountId: string, newPriceMinor: number): Promise<void> {
    if (newPriceMinor > this.maxDealMinor) throw new DealError('TOO_BIG');
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'AWAITING_SELLER') { out.push({ phone: seller.phone, message: deal.seller_id ? msg.dealHasSeller(deal.code) : msg.dealClosed(deal.code) }); return; }
      if (deal.buyer_id === seller.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      if (deal.counter_seller_id && deal.counter_seller_id !== seller.id) { out.push({ phone: seller.phone, message: msg.dealHasSeller(deal.code) }); return; }
      const acct = await tx.query('SELECT 1 FROM bank_accounts WHERE id=$1 AND user_id=$2', [accountId, seller.id]);
      if (!acct.rowCount) throw new DealError('NOT_ALLOWED');
      await tx.query('UPDATE deals SET counter_price_minor=$2, counter_seller_id=$3, counter_account_id=$4, updated_at=now() WHERE id=$1', [deal.id, newPriceMinor, seller.id, accountId]);
      await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)', [deal.id, deal.status, 'seller', `Suggested a new price: ${newPriceMinor}`]);
      const buyer = await this.userById(tx, deal.buyer_id!);
      const q = quote(newPriceMinor, this.o.currency, this.pricingRules(), 'buyer');
      out.push({ phone: seller.phone, message: msg.counterSent(deal.code, firstName(buyer.display_name) ?? 'the buyer', this.money(newPriceMinor)) });
      out.push({ phone: buyer.phone, message: msg.buyerCounterOffer(deal.code, firstName(seller.display_name) ?? 'The seller', deal.item, this.money(deal.price_minor), this.money(newPriceMinor), this.money(q.buyerPaysMinor)), fallback: dealTemplate('counterOffer', [deal.code, this.text(q.buyerPaysMinor)], [`cyes:${deal.code}`, `cancel:${deal.code}`]) });
    });
  }

  /** The buyer agrees to the seller's new price: the deal is on, at the new price. */
  async acceptCounter(code: string, buyer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'AWAITING_SELLER' || !deal.counter_price_minor || !deal.counter_seller_id) { out.push({ phone: buyer.phone, message: msg.dealClosed(deal.code) }); return; }
      const q = quote(deal.counter_price_minor, this.o.currency, this.pricingRules(), 'buyer');
      await tx.query(
        `UPDATE deals SET price_minor=$2, fee_minor=$3, buyer_pays_minor=$4, seller_gets_minor=$5, seller_id=$6, seller_account_id=$7,
                          counter_price_minor=NULL, counter_seller_id=NULL, counter_account_id=NULL WHERE id=$1`,
        [deal.id, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor, deal.counter_seller_id, deal.counter_account_id]);
      const seller = await this.userById(tx, deal.counter_seller_id);
      await this.move(tx, deal, 'AWAITING_PAYMENT', 'buyer', `Buyer accepted the new price ${q.priceMinor}`);
      out.push({ phone: seller.phone, message: msg.sellerCounterAccepted(deal.code, firstName(buyer.display_name) ?? 'The buyer', this.money(q.sellerGetsMinor)) });
      out.push({ phone: buyer.phone, message: msg.buyerSellerAccepted(deal.code, firstName(seller.display_name) ?? 'The seller', deal.item, { price: this.money(q.priceMinor), fee: this.money(q.buyerPaysMinor - q.priceMinor), pay: this.money(q.buyerPaysMinor) }, await this.trustLineFor(seller.id)), fallback: dealTemplate('sellerAccepted', [deal.code, this.text(q.buyerPaysMinor)], [`pay:${deal.code}`]) });
    });
  }

  /** The seller says no, or "Not me" (wrong number: we never alert that number again). */
  async declineAsSeller(code: string, viewer: User, notMe = false): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (notMe) {
        await tx.query('INSERT INTO contact_optouts (phone, reason) VALUES ($1,$2) ON CONFLICT (phone) DO NOTHING', [viewer.phone, `Not me on ${deal.code}`]);
      }
      if (deal.status !== 'AWAITING_SELLER') {
        out.push({ phone: viewer.phone, message: notMe ? msg.sellerNotMeOk() : msg.dealClosed(deal.code) });
        return;
      }
      if (deal.buyer_id === viewer.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      await this.move(tx, deal, 'CANCELLED', 'seller', notMe ? 'Not me: the alerted number is not the seller' : 'Seller declined');
      const buyer = await this.userById(tx, deal.buyer_id!);
      out.push({ phone: viewer.phone, message: notMe ? msg.sellerNotMeOk() : msg.sellerDeclinedOk(deal.code) });
      out.push({ phone: buyer.phone, message: notMe ? msg.buyerNotMe(deal.code) : msg.buyerSellerDeclined(deal.code), fallback: notMe ? undefined : dealTemplate('sellerDeclined', [deal.code], ['menu:buy']) });
    });
  }

  async photosFor(dealId: string): Promise<{ id: number; mime_type: string; size: number | null; created_at: Date }[]> {
    const r = await this.o.db.query('SELECT id, mime_type, octet_length(bytes) AS size, created_at FROM deal_photos WHERE deal_id=$1 ORDER BY id', [dealId]);
    return r.rows;
  }

  // ---------- 2. buyer opens the link ----------
  async joinAsBuyer(code: string, buyer: User): Promise<void> {
    const peek = await this.findByCode(code);
    const canSee = peek && ['AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(peek.status) && (!peek.buyer_id || peek.buyer_id === buyer.id);
    const photoIds = canSee ? await this.photoIdsForSending(peek.id) : [];
    const trust = canSee ? await this.trustLineFor(peek.seller_id) : undefined;
    const buyerLine = canSee && !peek.buyer_id ? await this.buyerLineFor(buyer.id) : undefined;
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.seller_id === buyer.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      if (deal.buyer_id && deal.buyer_id !== buyer.id) throw new DealError('TAKEN');
      if (!['AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(deal.status)) throw new DealError('CLOSED');
      const seller = await this.sellerOf(tx, deal);
      if (!deal.buyer_id) {
        await tx.query('UPDATE deals SET buyer_id=$2 WHERE id=$1', [deal.id, buyer.id]);
        await this.move(tx, deal, 'AWAITING_PAYMENT', 'buyer');
        if (seller.id !== buyer.id) out.push({ phone: seller.phone, message: msg.sellerBuyerJoined(deal.code, buyerLine) });
      }
      for (const mediaId of photoIds) out.push({ phone: buyer.phone, message: { kind: 'image', mediaId } });
      out.push({
        phone: buyer.phone,
        message: msg.dealForBuyer(deal.code, deal.item, firstName(seller.display_name) ?? 'Seller', this.money(deal.price_minor), this.money(deal.buyer_pays_minor - deal.price_minor), this.money(deal.buyer_pays_minor), trust),
      });
    });
  }

  /** Shows the buyer where to transfer. Reuses a still-valid account number if there is one. */
  async requestPayment(code: string, buyer: User, forceNew = false): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
    if (deal.status !== 'AWAITING_PAYMENT') throw new DealError('CLOSED');

    if (!forceNew) {
      const existing = await this.o.db.query(
        `SELECT * FROM payment_intents WHERE deal_id=$1 AND status='PENDING' AND (expires_at IS NULL OR expires_at > now() + interval '5 minutes')
         ORDER BY created_at DESC LIMIT 1`, [deal.id]);
      const pi = existing.rows[0];
      if (pi) {
        await this.o.messenger.send(buyer.phone, msg.payInstructions(this.money(pi.amount_minor), pi.account_number, pi.bank_name, pi.account_name, minutesLeft(pi.expires_at), deal.code, this.payHint()));
        return;
      }
    }

    const paymentReference = `${deal.code}-${randomUUID().slice(0, 8)}`;
    const instr = await this.o.provider.createCollection({
      paymentReference,
      amountMinor: deal.buyer_pays_minor,
      currency: deal.currency,
      description: `Hoolam ${deal.code}: ${deal.item}`,
      customerName: buyer.display_name ?? 'Hoolam buyer',
      customerEmail: `${buyer.phone.replace(/\D/g, '')}@buyers.hoolam.app`,
    });
    await this.o.db.query(
      `INSERT INTO payment_intents (deal_id, provider, payment_reference, provider_reference, amount_minor, currency, account_number, account_name, bank_name, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [deal.id, this.o.provider.name, paymentReference, instr.providerReference, deal.buyer_pays_minor, deal.currency, instr.accountNumber, instr.accountName, instr.bankName, instr.expiresAt],
    );
    await this.o.messenger.send(buyer.phone, msg.payInstructions(this.money(deal.buyer_pays_minor), instr.accountNumber, instr.bankName, instr.accountName, minutesLeft(instr.expiresAt), deal.code, this.payHint()));
  }

  /** Test mode only: the newest unpaid payment this person asked for. */
  async latestPendingPaymentFor(buyerId: string): Promise<string | null> {
    const r = await this.o.db.query(
      `SELECT pi.provider_reference FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id
       WHERE d.buyer_id=$1 AND d.status='AWAITING_PAYMENT' AND pi.status='PENDING' ORDER BY pi.created_at DESC LIMIT 1`, [buyerId]);
    return r.rows[0]?.provider_reference ?? null;
  }

  async cancelByBuyer(code: string, buyer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'AWAITING_PAYMENT' && deal.status !== 'AWAITING_SELLER') throw new DealError('CLOSED');
      const paid = await tx.query(`SELECT 1 FROM payment_intents WHERE deal_id=$1 AND status IN ('PAID','PARTIAL')`, [deal.id]);
      if (paid.rowCount) throw new DealError('NOT_ALLOWED');
      await this.move(tx, deal, 'CANCELLED', 'buyer');
      out.push({ phone: buyer.phone, message: msg.cancelled(deal.code) });
      const sellerId = deal.seller_id ?? deal.counter_seller_id;
      if (sellerId && sellerId !== buyer.id) {
        const seller = await this.userById(tx, sellerId);
        out.push({ phone: seller.phone, message: msg.sellerBuyerCancelled(deal.code) });
      }
    });
  }

  // ---------- 3. money arrives (from the provider webhook) ----------
  /**
   * Called when the provider says a payment arrived. We never trust the webhook alone:
   * we ask the provider for the real status and amount, then update everything in one transaction.
   * Safe to call more than once for the same payment.
   */
  async handleCollection(providerReference: string): Promise<'funded' | 'partial' | 'pending' | 'duplicate' | 'unknown' | 'flagged'> {
    const check = await this.o.provider.checkCollection(providerReference);
    return this.run(async (tx, out) => {
      const pr = await tx.query('SELECT * FROM payment_intents WHERE provider_reference=$1 FOR UPDATE', [providerReference]);
      const pi = pr.rows[0];
      if (!pi) { this.log(`payment for unknown reference ${providerReference}`); return 'unknown'; }
      if (pi.status === 'PAID' || pi.status === 'PARTIAL') return 'duplicate';
      if (check.status === 'PENDING' || check.status === 'FAILED' || check.status === 'EXPIRED') return 'pending';

      const deal = await this.lockById(tx, pi.deal_id);
      const buyer = deal.buyer_id ? await this.userById(tx, deal.buyer_id) : null;
      const seller = await this.sellerOf(tx, deal);
      const cash = `cash:${this.o.provider.name}`;
      const paid = check.amountPaidMinor;

      if (paid < deal.buyer_pays_minor) {
        await tx.query(`UPDATE payment_intents SET status='PARTIAL', amount_paid_minor=$2, updated_at=now() WHERE id=$1`, [pi.id, paid]);
        await post(tx, { dealId: deal.id, currency: deal.currency, memo: `Partial payment ${providerReference}, owed back to buyer`, lines: [{ account: cash, amountMinor: paid }, { account: 'payable:buyer', amountMinor: -paid }] });
        await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)', [deal.id, deal.status, 'provider', `NEEDS_ATTENTION: partial payment ${paid} of ${deal.buyer_pays_minor}`]);
        if (buyer) out.push({ phone: buyer.phone, message: msg.paymentPartial(this.money(paid), this.money(deal.buyer_pays_minor)) });
        return 'partial';
      }

      await tx.query(`UPDATE payment_intents SET status='PAID', amount_paid_minor=$2, updated_at=now() WHERE id=$1`, [pi.id, paid]);
      const extra = paid - deal.buyer_pays_minor;

      if (deal.status !== 'AWAITING_PAYMENT' && deal.status !== 'EXPIRED') {
        // Money landed on a deal that is no longer waiting for it (e.g. paid twice). Hold it for a refund.
        await post(tx, { dealId: deal.id, currency: deal.currency, memo: `Unexpected payment ${providerReference}, owed back to buyer`, lines: [{ account: cash, amountMinor: paid }, { account: 'payable:buyer', amountMinor: -paid }] });
        await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)', [deal.id, deal.status, 'provider', `NEEDS_ATTENTION: unexpected payment ${paid} while ${deal.status}`]);
        return 'flagged';
      }

      await post(tx, {
        dealId: deal.id, currency: deal.currency, memo: `Buyer payment ${providerReference}`,
        lines: [
          { account: cash, amountMinor: paid },
          { account: 'held:deal', amountMinor: -deal.buyer_pays_minor },
          ...(extra > 0 ? [{ account: 'payable:buyer', amountMinor: -extra }] : []),
        ],
      });
      await this.move(tx, deal, 'FUNDED', 'provider', extra > 0 ? `NEEDS_ATTENTION: overpaid by ${extra}` : undefined);
      if (buyer) out.push({ phone: buyer.phone, message: msg.buyerFunded(this.money(deal.buyer_pays_minor), deal.code) });
      if (deal.started_by === 'BUYER') {
        out.push({ phone: seller.phone, message: msg.sellerFundedDispatch(deal.code, this.money(deal.seller_gets_minor), this.orderPageUrl(deal)), fallback: dealTemplate('paidDispatch', [deal.code, this.text(deal.seller_gets_minor)], [`dispatch:${deal.code}`]) });
      } else {
        out.push({ phone: seller.phone, message: msg.sellerFunded(deal.code, this.money(deal.seller_gets_minor)), fallback: dealTemplate('paymentReceived', [deal.code, this.text(deal.seller_gets_minor)], [`shipped:${deal.code}`]) });
      }
      return 'funded';
    });
  }

  // ---------- 4. seller ships ----------
  async markShipped(code: string, seller: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.seller_id !== seller.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'FUNDED') throw new DealError('NOT_ALLOWED');
      await this.move(tx, deal, 'SHIPPED', 'seller');
      const buyer = await this.userById(tx, deal.buyer_id!);
      out.push({ phone: seller.phone, message: msg.sellerShippedOk(deal.code) });
      out.push({ phone: buyer.phone, message: msg.buyerShipped(deal.code), fallback: dealTemplate('itemOnTheWay', [deal.code], [`happy:${deal.code}`, `problem:${deal.code}`]) });
    });
  }

  /** Optional, after "I've sent it": a photo of the package/receipt or a tracking note. Shown to the buyer, kept for disputes. */
  async addShippingProof(code: string, seller: User, proof: { note?: string | null; photo?: { mediaId: string; mimeType?: string | null } | null }): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal || deal.seller_id !== seller.id) throw new DealError('NOT_ALLOWED');
    const photos = proof.photo ? await this.fetchPhotos([proof.photo]) : [];
    const note = proof.note?.trim().slice(0, 300) || null;
    await this.run(async (tx) => {
      await this.savePhotos(tx, deal.id, seller.id, photos, 'SHIPPING');
      if (note) await tx.query(`UPDATE deals SET shipping_note = CASE WHEN shipping_note IS NULL THEN $2 ELSE shipping_note || ' / ' || $2 END WHERE id=$1`, [deal.id, note]);
    });
    if (!deal.buyer_id) return;
    const buyer = await this.userById(this.o.db, deal.buyer_id);
    if (photos.length) {
      const ids = await this.photoIdsForSending(deal.id, 'SHIPPING');
      const last = ids[ids.length - 1];
      if (last) await this.o.messenger.send(buyer.phone, { kind: 'image', mediaId: last, caption: `📦 Proof of shipping for order ${deal.code}` });
    }
    if (note) await this.o.messenger.send(buyer.phone, msg.buyerShippingNote(deal.code, note));
    await this.o.messenger.send(seller.phone, msg.shippingProofSaved(deal.code));
  }

  // ---------- 4b. buyer orders: dispatch, handover code, rider/driver paid ----------
  /** The private order page (photos, details, status), shared only with the two people in the order. */
  orderPageUrl(deal: Pick<Deal, 'code' | 'view_token'>): string | null {
    if (!deal.view_token || !this.o.orderPageBase) return null;
    return `${this.o.orderPageBase.replace(/\/$/, '')}/o/${deal.code}?k=${deal.view_token}`;
  }

  autoReleaseMinutes(): number { return this.o.settings?.autoReleaseMinutes() ?? 1440; }

  /** The seller says how the item will reach the buyer. Gives the buyer a 4-digit handover code. */
  async dispatch(code: string, seller: User, d: DispatchInput): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.seller_id !== seller.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'FUNDED' || deal.dispatched_at) { out.push({ phone: seller.phone, message: msg.dealStatusNow(deal.code, deal.status) }); return; }
      const courier = d.method !== 'PICKUP';
      const fee = courier ? Math.max(0, Math.round(d.feeMinor ?? 0)) : 0;
      if (fee >= deal.seller_gets_minor) throw new DealError('NOT_ALLOWED', 'The delivery fee must be less than what you receive');
      let accountId: string | null = null;
      if (courier && fee > 0) {
        if (!d.account) throw new DealError('NOT_ALLOWED', 'The rider\'s account is missing');
        const a = await tx.query(
          `INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_number, account_name, is_default, holder)
           VALUES ($1,$2,$3,$4,$5,false,'COURIER')
           ON CONFLICT (user_id, bank_code, account_number) DO UPDATE SET account_name=EXCLUDED.account_name RETURNING id`,
          [seller.id, d.account.bank_code, d.account.bank_name, d.account.account_number, d.account.account_name]);
        accountId = a.rows[0].id;
      }
      const handover = String(randomInt(0, 10_000)).padStart(4, '0');
      await tx.query(
        `UPDATE deals SET dispatch_method=$2, pickup_address=$3, courier_name=$4, courier_phone=$5, courier_location=$6,
                          delivery_fee_minor=$7, courier_account_id=$8, handover_code=$9, handover_tries=0, dispatched_at=now(), updated_at=now()
         WHERE id=$1`,
        [deal.id, d.method, d.method === 'PICKUP' ? d.pickupAddress?.slice(0, 300) ?? null : null, d.method === 'RIDER' ? d.courierName?.slice(0, 80) ?? null : null,
          courier ? d.courierPhone ?? null : null, courier ? d.location?.slice(0, 300) ?? null : null, fee, accountId, handover]);
      await this.move(tx, deal, 'SHIPPED', 'seller', `Dispatched: ${d.method}${fee ? `, delivery fee ${fee}` : ''}`);
      const buyer = await this.userById(tx, deal.buyer_id!);
      const info = { code: deal.code, method: d.method, pickupAddress: d.pickupAddress ?? null, courierName: d.courierName ?? null, courierPhone: d.courierPhone ?? null, location: d.location ?? null, page: this.orderPageUrl(deal) };
      out.push({ phone: seller.phone, message: msg.sellerDispatched({ ...info, fee: fee ? this.money(fee) : null }) });
      out.push({ phone: buyer.phone, message: msg.buyerDispatched({ ...info, handover }), fallback: dealTemplate('orderDispatched', [deal.code, handover], [`hcodeshow:${deal.code}`, `problem:${deal.code}`]) });
    });
  }

  /** Shows the buyer their handover code again. */
  async showHandoverCode(code: string, buyer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal || deal.buyer_id !== buyer.id) throw new DealError('NOT_FOUND');
    if (!deal.handover_code || deal.handed_over_at || deal.status !== 'SHIPPED') {
      await this.o.messenger.send(buyer.phone, msg.dealStatusNow(deal.code, deal.status));
      return;
    }
    await this.o.messenger.send(buyer.phone, msg.handoverCode(deal.code, deal.handover_code, deal.dispatch_method));
  }

  /**
   * The seller types the 4 digits the receiver gave the rider. Right: the item reached the right person, the
   * rider/driver is paid their fee, and the buyer gets a set time to say "I'm happy" or report a problem.
   * Five wrong tries lock it for the team.
   */
  async enterHandoverCode(code: string, seller: User, digits: string): Promise<CodeResult> {
    let payoutId: string | null = null;
    const result = await this.run(async (tx, out): Promise<CodeResult> => {
      const deal = await this.lockByCode(tx, code);
      if (deal.seller_id !== seller.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'SHIPPED' || !deal.handover_code || deal.handed_over_at) { out.push({ phone: seller.phone, message: msg.dealStatusNow(deal.code, deal.status) }); return 'not-ready'; }
      if (deal.handover_tries >= 5) { out.push({ phone: seller.phone, message: msg.handoverLocked(deal.code) }); return 'locked'; }
      if (digits.replace(/\D/g, '') !== deal.handover_code) {
        const tries = deal.handover_tries + 1;
        await tx.query('UPDATE deals SET handover_tries=$2 WHERE id=$1', [deal.id, tries]);
        if (tries >= 5) {
          await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)', [deal.id, deal.status, 'seller', 'NEEDS_ATTENTION: handover code locked after 5 wrong tries']);
          out.push({ phone: seller.phone, message: msg.handoverLocked(deal.code) });
          return 'locked';
        }
        out.push({ phone: seller.phone, message: msg.handoverWrong(deal.code, 5 - tries) });
        return 'wrong';
      }
      await tx.query('UPDATE deals SET handed_over_at=now(), updated_at=now() WHERE id=$1', [deal.id]);
      await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)', [deal.id, deal.status, 'seller', 'Handover code confirmed']);
      payoutId = await this.payCourier(tx, deal);
      const buyer = await this.userById(tx, deal.buyer_id!);
      const minutes = this.autoReleaseMinutes();
      out.push({ phone: seller.phone, message: msg.sellerHandedOver(deal.code, payoutId ? this.money(Number(deal.delivery_fee_minor)) : null, deal.courier_name, waitText(minutes)) });
      out.push({ phone: buyer.phone, message: msg.buyerHandedOver(deal.code, waitText(minutes)), fallback: dealTemplate('handedOver', [deal.code, waitText(minutes)], [`happy:${deal.code}`, `problem:${deal.code}`]) });
      return 'ok';
    });
    if (payoutId) await this.submitPayout(payoutId);
    return result;
  }

  /** Moves the delivery fee from the held money to the rider/driver (once). Returns the payout to send, if any. */
  private async payCourier(tx: Tx, deal: Deal): Promise<string | null> {
    const fee = Number(deal.delivery_fee_minor ?? 0);
    if (!fee || deal.courier_paid_at || !deal.courier_account_id || deal.dispatch_method === 'PICKUP') return null;
    await post(tx, {
      dealId: deal.id, currency: deal.currency, memo: `Delivery fee ${deal.code} to the ${deal.dispatch_method === 'WAYBILL' ? 'driver' : 'rider'}`,
      lines: [{ account: 'held:deal', amountMinor: fee }, { account: 'payable:courier', amountMinor: -fee }],
    });
    await tx.query('UPDATE deals SET courier_paid_at=now() WHERE id=$1', [deal.id]);
    deal.courier_paid_at = new Date();
    const r = await tx.query(
      `INSERT INTO payouts (deal_id, kind, provider, reference, amount_minor, currency, bank_account_id) VALUES ($1,'DELIVERY',$2,$3,$4,$5,$6) RETURNING id`,
      [deal.id, this.o.provider.name, `${deal.code}-DLV-${randomUUID().slice(0, 6)}`, fee, deal.currency, deal.courier_account_id]);
    return r.rows[0].id;
  }

  /** What is still held for this order (after any delivery fee went to the rider). */
  private async heldFor(tx: Tx, deal: Deal): Promise<number> {
    return -(await balance(tx, 'held:deal', deal.currency, deal.id));
  }

  /**
   * A paid order that won't go ahead: the seller can't fulfil it, or the buyer asks for their money back
   * because it wasn't dispatched in time. Refunds everything still held. If we don't have the buyer's
   * account yet, we ask them for it and refund the moment they give it.
   */
  async refundPaidOrder(code: string, by: 'seller' | 'buyer', user: User, buyerGaveAccount = false): Promise<'refunding' | 'need-account'> {
    let payoutId: string | null = null;
    const res = await this.run(async (tx, out): Promise<'refunding' | 'need-account'> => {
      const deal = await this.lockByCode(tx, code);
      const allowed = buyerGaveAccount || by === 'buyer' ? deal.buyer_id === user.id : deal.seller_id === user.id;
      if (!allowed) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'FUNDED' || deal.dispatched_at) throw new DealError('NOT_ALLOWED');
      if (by === 'buyer' && !this.isOverdue(deal)) throw new DealError('NOT_ALLOWED');
      const buyer = await this.userById(tx, deal.buyer_id!);
      const acct = await tx.query(`SELECT id FROM bank_accounts WHERE user_id=$1 AND is_default AND holder='SELF' ORDER BY created_at DESC LIMIT 1`, [deal.buyer_id]);
      if (!acct.rows[0]) {
        await tx.query(
          `INSERT INTO chat_sessions (phone, state, data) VALUES ($1,'REFUND_BANK',$2)
           ON CONFLICT (phone) DO UPDATE SET state='REFUND_BANK', data=$2, updated_at=now()`,
          [buyer.phone, JSON.stringify({ code: deal.code, refundNow: by })]);
        out.push({ phone: buyer.phone, message: msg.askRefundAccountNow(deal.code, by) });
        if (by === 'seller') out.push({ phone: user.phone, message: msg.sellerRefundStarted(deal.code, false) });
        return 'need-account';
      }
      const note = by === 'seller' ? 'Seller can\'t fulfil the order' : 'Not dispatched by the expected date; buyer asked for a refund';
      payoutId = await this.startRefund(tx, deal, by, note, acct.rows[0].id);
      const seller = await this.sellerOf(tx, deal);
      if (by === 'seller') out.push({ phone: seller.phone, message: msg.sellerRefundStarted(deal.code, true) });
      else out.push({ phone: seller.phone, message: msg.sellerBuyerTookRefund(deal.code) });
      out.push({ phone: buyer.phone, message: msg.buyerRefundStarted(deal.code, by) });
      return 'refunding';
    });
    if (payoutId) await this.submitPayout(payoutId);
    return res;
  }

  /** Paid, not dispatched, and the date the buyer expected it has passed. */
  isOverdue(deal: Pick<Deal, 'status' | 'dispatched_at' | 'arrive_by'>): boolean {
    if (deal.status !== 'FUNDED' || deal.dispatched_at || !deal.arrive_by) return false;
    const day = typeof deal.arrive_by === 'string' ? deal.arrive_by : deal.arrive_by.toISOString().slice(0, 10);
    return new Date(day + 'T23:59:59+01:00').getTime() < Date.now();
  }

  /** "Send reminder": the buyer nudges a seller who hasn't dispatched. */
  async remindSeller(code: string, buyer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal || deal.buyer_id !== buyer.id || !deal.seller_id) throw new DealError('NOT_FOUND');
    if (deal.status !== 'FUNDED' || deal.dispatched_at) { await this.o.messenger.send(buyer.phone, msg.dealStatusNow(deal.code, deal.status)); return; }
    const seller = await this.userById(this.o.db, deal.seller_id);
    await this.o.messenger.send(seller.phone, msg.sellerDispatchReminder(deal.code, deal.item, true), dealTemplate('dispatchReminder', [deal.code], [`dispatch:${deal.code}`]));
    await this.o.messenger.send(buyer.phone, msg.reminderSent(deal.code));
  }

  // ---------- 5a. buyer is happy → pay the seller ----------
  async confirmHappy(code: string, buyer: User): Promise<void> {
    const payoutIds = await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (!['FUNDED', 'SHIPPED'].includes(deal.status)) throw new DealError('NOT_ALLOWED');
      if (deal.status === 'FUNDED') await this.move(tx, deal, 'SHIPPED', 'buyer', 'Buyer confirmed before seller marked it sent');
      const ids = await this.startRelease(tx, deal, 'buyer');
      const seller = await this.sellerOf(tx, deal);
      out.push({ phone: buyer.phone, message: msg.buyerReleased(deal.code, firstName(seller.display_name) ?? 'the seller') });
      return ids;
    });
    for (const id of payoutIds) await this.submitPayout(id);
  }

  /**
   * Pays the seller what's left: everything still held, minus Hoolam's fee. If a rider or driver was set to be
   * paid and hasn't been yet (no code was entered), they're paid first. Returns the payouts to send.
   */
  private async startRelease(tx: Tx, deal: Deal, actor: string, note?: string): Promise<string[]> {
    if (!deal.seller_account_id) throw new Error(`Order ${deal.code} has no seller bank account`);
    const courierPayout = await this.payCourier(tx, deal);
    await this.move(tx, deal, 'RELEASING', actor, note);
    const fee = deal.buyer_pays_minor - deal.seller_gets_minor;
    const held = await this.heldFor(tx, deal);
    const toSeller = held - fee;
    if (toSeller <= 0) throw new Error(`Order ${deal.code}: nothing left for the seller (held ${held}, fee ${fee})`);
    await post(tx, {
      dealId: deal.id, currency: deal.currency, memo: `Release ${deal.code} to seller`,
      lines: [
        { account: 'held:deal', amountMinor: held },
        { account: 'payable:seller', amountMinor: -toSeller },
        { account: 'revenue:fees', amountMinor: -fee },
      ],
    });
    const r = await tx.query(
      `INSERT INTO payouts (deal_id, kind, provider, reference, amount_minor, currency, bank_account_id) VALUES ($1,'SELLER',$2,$3,$4,$5,$6) RETURNING id`,
      [deal.id, this.o.provider.name, `${deal.code}-PAY-${randomUUID().slice(0, 6)}`, toSeller, deal.currency, deal.seller_account_id],
    );
    return [...(courierPayout ? [courierPayout] : []), r.rows[0].id];
  }

  /** Refunds everything still held for the order (a delivery fee already paid to a rider can't come back). */
  private async startRefund(tx: Tx, deal: Deal, actor: string, note: string, accountId: string): Promise<string> {
    await this.move(tx, deal, 'REFUNDING', actor, note);
    const held = await this.heldFor(tx, deal);
    await post(tx, {
      dealId: deal.id, currency: deal.currency, memo: `Refund ${deal.code} to buyer`,
      lines: [{ account: 'held:deal', amountMinor: held }, { account: 'payable:buyer', amountMinor: -held }],
    });
    const r = await tx.query(
      `INSERT INTO payouts (deal_id, kind, provider, reference, amount_minor, currency, bank_account_id) VALUES ($1,'REFUND',$2,$3,$4,$5,$6) RETURNING id`,
      [deal.id, this.o.provider.name, `${deal.code}-REF-${randomUUID().slice(0, 6)}`, held, deal.currency, accountId],
    );
    return r.rows[0].id;
  }

  // ---------- 5b. buyer reports a problem ----------
  async openDispute(code: string, buyer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (!['FUNDED', 'SHIPPED'].includes(deal.status)) throw new DealError('NOT_ALLOWED');
      await this.move(tx, deal, 'DISPUTED', 'buyer');
      await tx.query('INSERT INTO disputes (deal_id, opened_by) VALUES ($1,$2)', [deal.id, buyer.id]);
      const seller = await this.sellerOf(tx, deal);
      out.push({ phone: buyer.phone, message: msg.askProblem(deal.code) });
      out.push({ phone: seller.phone, message: msg.sellerProblem(deal.code), fallback: dealTemplate('problemReported', [deal.code], ['menu:human']) });
    });
  }

  async addDisputeDetail(code: string, buyer: User, text: string): Promise<string> {
    const deal = await this.findByCode(code);
    if (!deal || deal.buyer_id !== buyer.id) throw new DealError('NOT_FOUND');
    const r = await this.o.db.query(
      `UPDATE disputes SET reason = COALESCE(reason || E'\\n', '') || $2 WHERE id = (SELECT id FROM disputes WHERE deal_id=$1 AND status='OPEN' ORDER BY created_at DESC LIMIT 1) RETURNING id`,
      [deal.id, text.slice(0, 2000)],
    );
    return r.rows[0]?.id ?? '';
  }

  // ---------- admin decisions ----------

  // ---------- staff actions (console) ----------
  /** Close a deal before any money moved. Both sides are told, kindly. */
  async adminCancel(code: string, note: string): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (!['AWAITING_SELLER', 'AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(deal.status)) throw new DealError('NOT_ALLOWED', 'Only orders that haven\'t been paid can be cancelled. Use Refund for paid orders.');
      const paid = await tx.query(`SELECT 1 FROM payment_intents WHERE deal_id=$1 AND status IN ('PAID','PARTIAL')`, [deal.id]);
      if (paid.rowCount) throw new DealError('NOT_ALLOWED', 'Money has arrived on this deal. Use Refund instead.');
      await this.move(tx, deal, 'CANCELLED', 'admin', note);
      for (const id of new Set([deal.buyer_id, deal.seller_id ?? deal.counter_seller_id].filter(Boolean) as string[])) {
        const u = await this.userById(tx, id);
        out.push({ phone: u.phone, message: msg.cancelledByHoolam(deal.code) });
      }
    });
  }

  /** Give a seller more time to accept a buyer's deal. */
  async extendAcceptTime(code: string, hours: number): Promise<Date> {
    const r = await this.o.db.query(
      `UPDATE deals SET accept_by = GREATEST(COALESCE(accept_by, now()), now()) + make_interval(hours => $2), updated_at=now()
       WHERE code=$1 AND status='AWAITING_SELLER' RETURNING accept_by`, [code.toUpperCase(), hours]);
    if (!r.rows[0]) throw new DealError('NOT_ALLOWED', 'Only orders waiting for a seller can be extended.');
    return r.rows[0].accept_by;
  }

  /** A message from the Hoolam team to one side of a deal. Only works within WhatsApp's 24-hour window. */
  async messageParty(code: string, who: 'buyer' | 'seller', text: string): Promise<string> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    const id = who === 'buyer' ? deal.buyer_id : deal.seller_id ?? deal.counter_seller_id;
    if (!id) throw new DealError('NOT_ALLOWED', `This order has no ${who} yet.`);
    const u = await this.userById(this.o.db, id);
    return this.o.messenger.send(u.phone, msg.fromTeam(text));
  }

  async adminRelease(code: string, note: string): Promise<void> {
    const payoutIds = await this.run(async (tx) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'DISPUTED' && deal.status !== 'SHIPPED' && deal.status !== 'FUNDED') throw new DealError('NOT_ALLOWED');
      if (deal.status === 'FUNDED') await this.move(tx, deal, 'SHIPPED', 'admin', note);
      await tx.query(`UPDATE disputes SET status='RESOLVED_RELEASE', resolution_note=$2, resolved_at=now() WHERE deal_id=$1 AND status='OPEN'`, [deal.id, note]);
      return this.startRelease(tx, deal, 'admin', note);
    });
    for (const id of payoutIds) await this.submitPayout(id);
  }

  async adminRefund(code: string, note: string): Promise<void> {
    const payoutId = await this.run(async (tx) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'DISPUTED' && deal.status !== 'FUNDED') throw new DealError('NOT_ALLOWED');
      const acct = await tx.query(`SELECT id FROM bank_accounts WHERE user_id=$1 AND is_default AND holder='SELF' ORDER BY created_at DESC LIMIT 1`, [deal.buyer_id]);
      if (!acct.rows[0]) throw new DealError('NOT_ALLOWED', 'The buyer has not given a refund account yet');
      await tx.query(`UPDATE disputes SET status='RESOLVED_REFUND', resolution_note=$2, resolved_at=now() WHERE deal_id=$1 AND status='OPEN'`, [deal.id, note]);
      // A refund returns everything still held: the fee too. A delivery fee already paid to the rider can't come back.
      return this.startRefund(tx, deal, 'admin', note, acct.rows[0].id);
    });
    await this.submitPayout(payoutId);
  }

  // ---------- payouts ----------
  async submitPayout(payoutId: string): Promise<void> {
    const r = await this.o.db.query(
      `SELECT p.*, b.bank_code, b.account_number, b.account_name, d.code FROM payouts p
       JOIN bank_accounts b ON b.id=p.bank_account_id JOIN deals d ON d.id=p.deal_id WHERE p.id=$1`, [payoutId]);
    const p = r.rows[0];
    if (!p || p.status !== 'CREATED') return;
    let result: PayoutResult;
    try {
      result = await this.o.provider.sendPayout({
        reference: p.reference, amountMinor: p.amount_minor, currency: p.currency,
        bankCode: p.bank_code, accountNumber: p.account_number, accountName: p.account_name,
        narration: `Hoolam ${p.code}`,
      });
    } catch (e) {
      result = { status: 'FAILED', message: (e as Error).message };
    }
    await this.applyPayoutResult(p.reference, result);
  }

  async authorizePayout(reference: string, otp: string): Promise<PayoutResult> {
    const result = await this.o.provider.authorizePayout(reference, otp);
    await this.applyPayoutResult(reference, result);
    return result;
  }

  async retryPayout(reference: string): Promise<void> {
    const r = await this.o.db.query(`UPDATE payouts SET status='CREATED', updated_at=now() WHERE reference=$1 AND status='FAILED' RETURNING id`, [reference]);
    if (r.rows[0]) await this.submitPayout(r.rows[0].id);
  }

  /** Idempotent: applying the same final result twice does nothing the second time. */
  async applyPayoutResult(reference: string, result: PayoutResult): Promise<void> {
    await this.run(async (tx, out) => {
      const r = await tx.query('SELECT * FROM payouts WHERE reference=$1 FOR UPDATE', [reference]);
      const p = r.rows[0];
      if (!p) { this.log(`payout result for unknown reference ${reference}`); return; }
      if (p.status === 'SUCCESS') return;
      const deal = await this.lockById(tx, p.deal_id);
      if (p.kind === 'DELIVERY') return this.applyCourierPayout(tx, out, p, deal, result);
      const holding = p.kind === 'SELLER' ? 'payable:seller' : 'payable:buyer';
      const doneStatus: Status = p.kind === 'SELLER' ? 'COMPLETED' : 'REFUNDED';

      if (result.status === 'SUCCESS') {
        await tx.query(`UPDATE payouts SET status='SUCCESS', provider_message=$2, updated_at=now() WHERE id=$1`, [p.id, result.message ?? null]);
        await post(tx, {
          dealId: deal.id, currency: deal.currency, memo: `${p.kind === 'SELLER' ? 'Payout' : 'Refund'} ${reference} sent`,
          lines: [{ account: holding, amountMinor: p.amount_minor }, { account: `cash:${p.provider}`, amountMinor: -p.amount_minor }],
        });
        await this.move(tx, deal, doneStatus, 'provider');
        const acct = await tx.query('SELECT bank_name FROM bank_accounts WHERE id=$1', [p.bank_account_id]);
        const bankName = acct.rows[0]?.bank_name ?? 'bank';
        if (p.kind === 'SELLER') {
          const seller = await this.sellerOf(tx, deal);
          out.push({ phone: seller.phone, message: msg.sellerPaid(deal.code, this.money(p.amount_minor), bankName), fallback: dealTemplate('sellerPaid', [deal.code, this.text(p.amount_minor), bankName]) });
        } else {
          const buyer = await this.userById(tx, deal.buyer_id!);
          const seller = await this.sellerOf(tx, deal);
          out.push({ phone: buyer.phone, message: msg.buyerRefunded(deal.code, this.money(p.amount_minor), bankName), fallback: dealTemplate('refundSent', [deal.code, this.text(p.amount_minor), bankName]) });
          out.push({ phone: seller.phone, message: msg.sellerRefunded(deal.code) });
        }
        return;
      }

      const newStatus = result.status === 'NEEDS_AUTHORIZATION' ? 'NEEDS_AUTHORIZATION' : result.status === 'SUBMITTED' ? 'SUBMITTED' : result.status;
      await tx.query('UPDATE payouts SET status=$2, provider_message=$3, updated_at=now() WHERE id=$1', [p.id, newStatus, result.message ?? null]);
      if (result.status === 'SUBMITTED') return; // wait for the webhook or the poller
      // Needs a human: OTP approval, or a failed/reversed transfer to retry.
      if (deal.status !== 'PAYOUT_PENDING') {
        await this.move(tx, deal, 'PAYOUT_PENDING', 'provider', `NEEDS_ATTENTION: payout ${reference} ${result.status}${result.message ? ': ' + result.message : ''}`);
        if (p.kind === 'SELLER') {
          const seller = await this.sellerOf(tx, deal);
          out.push({ phone: seller.phone, message: msg.sellerPayoutDelayed(deal.code) });
        }
      }
    });
  }

  /** The rider's/driver's delivery fee landed (or didn't). The order itself carries on either way. */
  private async applyCourierPayout(tx: Tx, out: Outbox, p: any, deal: Deal, result: PayoutResult): Promise<void> {
    const seller = await this.sellerOf(tx, deal);
    if (result.status === 'SUCCESS') {
      await tx.query(`UPDATE payouts SET status='SUCCESS', provider_message=$2, updated_at=now() WHERE id=$1`, [p.id, result.message ?? null]);
      await post(tx, {
        dealId: deal.id, currency: deal.currency, memo: `Delivery fee ${p.reference} sent`,
        lines: [{ account: 'payable:courier', amountMinor: Number(p.amount_minor) }, { account: `cash:${p.provider}`, amountMinor: -Number(p.amount_minor) }],
      });
      const acct = await tx.query('SELECT account_name, bank_name FROM bank_accounts WHERE id=$1', [p.bank_account_id]);
      out.push({ phone: seller.phone, message: msg.courierPaid(deal.code, this.money(Number(p.amount_minor)), acct.rows[0]?.account_name ?? 'the rider', acct.rows[0]?.bank_name ?? 'bank') });
      return;
    }
    await tx.query('UPDATE payouts SET status=$2, provider_message=$3, updated_at=now() WHERE id=$1', [p.id, result.status, result.message ?? null]);
    if (result.status === 'SUBMITTED') return;
    await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)',
      [deal.id, deal.status, 'provider', `NEEDS_ATTENTION: delivery fee payout ${p.reference} ${result.status}${result.message ? ': ' + result.message : ''}`]);
  }

  /** Checks payouts still waiting on the provider. Run on a timer. */
  async pollPayouts(): Promise<void> {
    const r = await this.o.db.query(`SELECT reference FROM payouts WHERE status='SUBMITTED' AND updated_at < now() - interval '2 minutes' LIMIT 20`);
    for (const row of r.rows) {
      try { await this.applyPayoutResult(row.reference, await this.o.provider.checkPayout(row.reference)); }
      catch (e) { this.log(`poll payout ${row.reference}: ${(e as Error).message}`); }
    }
  }

  // ---------- timers ----------
  /** Reminds quiet buyers, expires unpaid deals. Run on a timer. */
  async sweep(opts: { nudgeAfterHours: number; expireUnpaidAfterHours?: number }): Promise<{ nudged: number; expired: number; released?: number }> {
    let nudged = 0;
    let expired = 0;
    let released = 0;
    // Handed over and the buyer said nothing in time: pay the seller.
    const due = await this.o.db.query(
      `SELECT id FROM deals WHERE status='SHIPPED' AND handed_over_at IS NOT NULL AND handed_over_at < now() - make_interval(mins => $1) LIMIT 50`,
      [this.autoReleaseMinutes()]);
    for (const row of due.rows) {
      try {
        const ids = await this.run(async (tx, out) => {
          const deal = await this.lockById(tx, row.id);
          if (deal.status !== 'SHIPPED' || !deal.handed_over_at) return [];
          const ids = await this.startRelease(tx, deal, 'system', `No problem reported within ${waitText(this.autoReleaseMinutes())} of handover`);
          const buyer = await this.userById(tx, deal.buyer_id!);
          out.push({ phone: buyer.phone, message: msg.autoReleased(deal.code) });
          return ids;
        });
        for (const id of ids) await this.submitPayout(id);
        if (ids.length) released++;
      } catch (e) { this.log(`auto-release ${row.id}: ${(e as Error).message}`); }
    }
    const toNudge = await this.o.db.query(
      `SELECT d.code, d.buyer_pays_minor, u.phone FROM deals d JOIN users u ON u.id=d.buyer_id
       WHERE d.status='SHIPPED' AND d.reminded_at IS NULL AND d.shipped_at < now() - make_interval(hours => $1) LIMIT 50`,
      [opts.nudgeAfterHours]);
    for (const row of toNudge.rows) {
      await this.o.db.query('UPDATE deals SET reminded_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.buyerNudge(row.code), dealTemplate('confirmReminder', [row.code, this.text(Number(row.buyer_pays_minor))], [`happy:${row.code}`, `problem:${row.code}`]));
      nudged++;
    }
    // Paid but not dispatched: remind the seller once.
    const waiting = await this.o.db.query(
      `SELECT d.code, d.item, u.phone FROM deals d JOIN users u ON u.id=d.seller_id
       WHERE d.status='FUNDED' AND d.started_by='BUYER' AND d.dispatched_at IS NULL AND d.dispatch_reminded_at IS NULL
         AND d.funded_at < now() - make_interval(hours => $1) LIMIT 50`,
      [this.o.settings?.dispatchRemindHours() ?? 12]);
    for (const row of waiting.rows) {
      await this.o.db.query('UPDATE deals SET dispatch_reminded_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.sellerDispatchReminder(row.code, row.item, false), dealTemplate('dispatchReminder', [row.code], [`dispatch:${row.code}`]));
      nudged++;
    }
    // Still not dispatched after the date the buyer expected: give the buyer their options, once.
    const late = await this.o.db.query(
      `SELECT d.code, d.item, u.phone FROM deals d JOIN users u ON u.id=d.buyer_id
       WHERE d.status='FUNDED' AND d.dispatched_at IS NULL AND d.overdue_notified_at IS NULL AND d.arrive_by IS NOT NULL
         AND (d.arrive_by + 1)::timestamp AT TIME ZONE 'Africa/Lagos' < now() LIMIT 50`);
    for (const row of late.rows) {
      await this.o.db.query('UPDATE deals SET overdue_notified_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.buyerOverdue(row.code, row.item), dealTemplate('overdue', [row.code], [`remind:${row.code}`, `refundme:${row.code}`]));
      nudged++;
    }
    const stale = await this.o.db.query(
      `SELECT id FROM deals WHERE status IN ('AWAITING_BUYER','AWAITING_PAYMENT') AND updated_at < now() - make_interval(hours => $1) LIMIT 100`,
      [opts.expireUnpaidAfterHours ?? 72]);
    for (const row of stale.rows) {
      await this.run(async (tx) => {
        const deal = await this.lockById(tx, row.id);
        if (deal.status === 'AWAITING_BUYER' || deal.status === 'AWAITING_PAYMENT') { await this.move(tx, deal, 'EXPIRED', 'system'); expired++; }
      });
    }
    const unanswered = await this.o.db.query(`SELECT id FROM deals WHERE status='AWAITING_SELLER' AND accept_by < now() LIMIT 100`);
    for (const row of unanswered.rows) {
      await this.run(async (tx, out) => {
        const deal = await this.lockById(tx, row.id);
        if (deal.status !== 'AWAITING_SELLER') return;
        await this.move(tx, deal, 'EXPIRED', 'system', 'Seller did not accept in time');
        const buyer = await this.userById(tx, deal.buyer_id!);
        out.push({ phone: buyer.phone, message: msg.buyerSellerExpired(deal.code), fallback: dealTemplate('sellerNoReply', [deal.code], ['menu:buy']) });
        expired++;
      });
    }
    return { nudged, expired, released };
  }
}

function firstName(name: string | null): string | null {
  const f = name?.trim().split(/\s+/)[0];
  return f ? f.slice(0, 30) : null;
}

/** 30 → "30 minutes", 1440 → "24 hours", 2880 → "2 days" */
export function waitText(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = Math.round(minutes / 60);
  if (h >= 48 && h % 24 === 0) return `${h / 24} days`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** "2026-10-09" → "Fri 9 Oct" */
export function dayText(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d + (d.length === 10 ? 'T12:00:00Z' : '')) : d;
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }).replace(',', '');
}

function minutesLeft(expiresAt: Date | string | null): number | null {
  if (!expiresAt) return null;
  return Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

export { DealStatus };
