import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { withTx, type Db, type Queryable, type Tx } from '../db.js';
import { balance, post } from '../ledger.js';
import type { Currency } from '../money.js';
import { DEFAULT_TXN_BANDS, quote, type FeePayer, type Quote, type TxnFees } from '../pricing.js';
import type { PaymentProvider, PayoutResult } from '../payments/provider.js';
import type { Messenger, Outbound, SendStatus, Template } from '../whatsapp/client.js';
import { localPhone } from '../phone.js';
import type { Media } from '../whatsapp/media.js';
import type { Trust } from '../trust.js';
import type { Ambassadors } from '../ambassadors.js';
import type { Settings } from '../settings.js';
import { namesMatch, type KycService } from '../kyc.js';
import { renderBrandCard, renderReceipt, type ReceiptData } from '../receipt.js';
import type { PricingRules } from '../pricing.js';
import { BUYER_ALERT, DEAL_TEMPLATES, dealTemplate, SELLER_ALERT } from '../whatsapp/automation.js';
import { categoryTitle } from './categories.js';
import { mapsLink, msg, type BuyerSum, type SellerSum } from '../whatsapp/messages.js';
import { ART } from '../chat-art/build.js';
import type { Art } from '../chat-art/index.js';
import { canMove, DealStatus, type DealStatus as Status } from './states.js';

export interface Deal {
  id: string; code: string; seller_id: string | null; buyer_id: string | null; item: string; currency: Currency;
  price_minor: number; fee_minor: number; buyer_pays_minor: number; seller_gets_minor: number; txn_fee_minor?: number; txn_fee_payer?: 'BUYER' | 'SELLER' | null;
  seller_account_id: string | null; status: Status; created_at: Date; funded_at: Date | null; shipped_at: Date | null;
  started_by: 'SELLER' | 'BUYER'; invited_phone: string | null; arrive_by: string | Date | null; accept_by: Date | null;
  fee_payer: 'BUYER' | 'SELLER'; counter_price_minor: number | null; counter_reason?: string | null; counter_seller_id: string | null; counter_account_id: string | null;
  shipping_note: string | null;
  description: string | null; category: string | null; delivery_fee_minor: number | string;
  delivery_address: string | null; dispatch_method: 'PICKUP' | 'RIDER' | 'WAYBILL' | null; pickup_address: string | null;
  courier_name: string | null; courier_phone: string | null; courier_location: string | null; courier_account_id: string | null;
  dispatched_at: Date | null; handover_code: string | null; handover_tries: number; handed_over_at: Date | null; courier_paid_at: Date | null;
  handover_by?: 'seller' | 'courier' | null; courier_alert?: string | null;
  view_token: string | null; legacy_ship?: boolean;
  alert_wa_id?: string | null; seen_at?: Date | null; delivery_pin?: string | null; courier_pin?: string | null;
}

/** What a seller gives us to start an order (the mirror of BuyerDealInput). */
export interface SellerDealInput {
  item: string;
  priceMinor: number;
  buyerPhone: string;
  readyBy: string | null;                           // YYYY-MM-DD: when it can be sent or picked up
  photos: { mediaId: string; mimeType?: string | null }[];
  description?: string | null;
  category?: string | null;
  address?: string | null;                          // the buyer's address, if the seller knows it (the buyer confirms or adds it)
  addressPin?: string | null;                       // "lat,lng" when a location was shared for it
  accountId: string;                                // the seller's payout account
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
  addressPin?: string | null;                       // "lat,lng" when a location was shared for it
}

/** What happened to the alert we tried to send the seller. */
export type SellerAlert = 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed';

export const SELLER_ALERT_TEMPLATE = SELLER_ALERT.name;
/** Longest message the team can send from the console (WhatsApp template values must be one paragraph). */
export const SUPPORT_MESSAGE_MAX = 600;

/** The order page key for one side: each sees their own fee. The bare view token still opens a neutral page. */
export function viewKey(viewToken: string, viewer: 'buyer' | 'seller'): string {
  return createHash('sha256').update(`${viewToken}:${viewer}`).digest('base64url').slice(0, 22);
}
export type Alert = SellerAlert;
export type MenuMode = 'buyer' | 'seller';
export interface User {
  id: string; phone: string; display_name: string | null; blocked?: boolean; deal_cap_minor?: number | null;
  /** When they became a seller (null = buyer only). */
  seller_since?: Date | null;
  /** Which menu they see. */
  menu_mode?: MenuMode;
  /** ID check (KYC): VERIFIED once they've checked their BVN or NIN. */
  kyc_status?: string | null;
  kyc_verified_at?: Date | null;
  kyc_name?: string | null;
}
const USER_COLS = 'id, phone, display_name, blocked, deal_cap_minor, seller_since, menu_mode, kyc_status, kyc_verified_at, kyc_name';
/** Has this person checked their ID? */
export function isVerified(u: Pick<User, 'kyc_status' | 'kyc_verified_at'> | null | undefined): boolean {
  return !!u && u.kyc_status === 'VERIFIED' && !!u.kyc_verified_at;
}
export interface BankAccount { id: string; user_id: string; bank_code: string; bank_name: string; account_number: string; account_name: string }

/** Messages to send after the transaction commits. `fallback` is the approved template used if they're outside WhatsApp's 24-hour window. */
/** A branded receipt picture, sent just before the message it belongs to (see sendReceipt). */
export type ReceiptKind = 'payment' | 'payment-seller' | 'payout' | 'refund' | 'courier' | 'courier-seller';
type Outbox = ({ phone: string; message: Outbound; fallback?: Template; receipt?: undefined } | { phone: string; receipt: { dealId: string; kind: ReceiptKind; payoutId?: string } })[];

export class DealError extends Error {
  constructor(public readonly reason: 'NOT_FOUND' | 'NOT_ALLOWED' | 'OWN_DEAL' | 'TAKEN' | 'CLOSED' | 'TOO_BIG' | 'NEEDS_KYC', message?: string) {
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
  kyc?: KycService;           // ID checks (BVN/NIN): above the no-ID limit, and every seller before their payout
  acceptHours?: number;       // how long a seller has to accept a buyer's deal (default 48)
  orderPageBase?: string;     // where the private order pages live, e.g. https://hoolam.onrender.com
  /** The ambassador programme: earnings when an order's money is released (see ambassadors.ts). */
  ambassadors?: Pick<Ambassadors, 'onRelease'>;
  log?: (line: string) => void;
}

/** What the seller tells us when dispatching a paid order. */
export interface DispatchInput {
  method: 'PICKUP' | 'RIDER' | 'WAYBILL';
  pickupAddress?: string | null;
  courierName?: string | null;     // rider only
  courierPhone?: string | null;    // rider or waybill driver
  location?: string | null;        // drop-off (rider) or delivery location (waybill)
  pin?: string | null;             // "lat,lng" when the seller shared the drop-off as a location
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

  /** The most one order can be once the person has checked their ID. */
  get maxDealVerifiedMinor(): number { return this.o.settings?.maxDealVerifiedMinor() ?? Math.max(this.maxDealMinor, 2_000_000_00); }

  /** Can people check their ID right now (Prembly, or pretend checks in test mode)? */
  get kycOn(): boolean { return !!this.o.kyc?.available; }
  /** Is a payout account in the name on the ID? (skipped while real ID checks run with pretend money) */
  accountMatches(idName: string | null | undefined, accountName: string | null | undefined): boolean {
    return this.o.kyc ? this.o.kyc.accountMatches(idName, accountName) : namesMatch(idName, accountName);
  }

  /** The most this person can put in one order: their own limit if staff set one, else the normal one (higher once verified). */
  capFor(user: Pick<User, 'deal_cap_minor' | 'kyc_status' | 'kyc_verified_at'>): number {
    if (user.deal_cap_minor != null) return Number(user.deal_cap_minor);
    return isVerified(user) ? this.maxDealVerifiedMinor : this.maxDealMinor;
  }

  /** The most this person could reach (after an ID check, if that's open to them). For "orders can be up to …". */
  reachFor(user: Pick<User, 'deal_cap_minor' | 'kyc_status' | 'kyc_verified_at'>): number {
    return user.deal_cap_minor == null && this.kycOn ? this.maxDealVerifiedMinor : this.capFor(user);
  }

  /** What an order of this size needs from this person: nothing, an ID check first, or it's over their limit. */
  limitFor(user: Pick<User, 'deal_cap_minor' | 'kyc_status' | 'kyc_verified_at'>, priceMinor: number): 'ok' | 'kyc' | 'too-big' {
    if (priceMinor <= this.capFor(user)) return 'ok';
    if (user.deal_cap_minor == null && !isVerified(user) && this.kycOn && priceMinor <= this.maxDealVerifiedMinor) return 'kyc';
    return 'too-big';
  }

  /** Throws NEEDS_KYC (verify, then try again) or TOO_BIG. `kycOnly`: only the ID check (an order that was fine when made). */
  assertLimit(user: Pick<User, 'deal_cap_minor' | 'kyc_status' | 'kyc_verified_at'>, priceMinor: number, kycOnly = false): void {
    const r = this.limitFor(user, priceMinor);
    if (r === 'kyc') throw new DealError('NEEDS_KYC');
    if (r === 'too-big' && !kycOnly) throw new DealError('TOO_BIG');
  }

  /** Run fn in a transaction; send the queued WhatsApp messages only after it commits. */
  private async run<T>(fn: (tx: Tx, out: Outbox) => Promise<T>): Promise<T> {
    const out: Outbox = [];
    const result = await withTx(this.o.db, (tx) => fn(tx, out));
    for (const o of out) {
      if (o.receipt) { await this.sendReceipt(o.phone, o.receipt.dealId, o.receipt.kind, o.receipt.payoutId); continue; }
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
  /** The seller's trust card as a picture, for the chat. */
  async trustArt(sellerId: string | null): Promise<Art | undefined> {
    if (!sellerId || !this.o.trust) return undefined;
    const t = await this.o.trust.seller(sellerId);
    return t ? ART.trust(t, sellerId) : undefined;
  }

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
    const canAccept = deal.status === 'AWAITING_BUYER' && !deal.legacy_ship && deal.seller_id !== viewer.id;
    await this.o.messenger.send(viewer.phone, msg.sellerRecord(msg.trustCardText(t), canPay ? deal.code : null, null, canAccept ? deal.code : null, ART.trust(t, sellerId!)));
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
       RETURNING ${USER_COLS}`,
      [phone, name],
    );
    return r.rows[0];
  }

  async userById(q: Queryable, id: string): Promise<User> {
    const r = await q.query(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id]);
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
  async recentOrders(userId: string, as: MenuMode, limit = 8): Promise<(Deal & { other_name: string | null })[]> {
    const col = as === 'seller' ? 'seller_id' : 'buyer_id';
    const other = as === 'seller' ? 'd.buyer_id' : 'COALESCE(d.seller_id, d.counter_seller_id)';
    const r = await this.o.db.query(
      `SELECT d.*, (SELECT display_name FROM users WHERE id=${other}) AS other_name FROM deals d WHERE d.${col}=$1 ORDER BY d.created_at DESC LIMIT $2`, [userId, limit]);
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
    return quote(priceMinor, this.o.currency, this.pricingRules(), payer, this.txnFees());
  }
  /** What the buyer's fee line is called: Hoolam's fee when they started the order, the transaction fee otherwise. */
  buyerFeeLabel(d: Deal): string { return d.fee_payer === 'BUYER' ? 'Hoolam fee' : 'Transaction fee'; }
  /** The same for the seller. */
  sellerFeeLabel(d: Deal): string { return d.fee_payer === 'SELLER' ? 'Hoolam fee' : 'Transaction fee'; }
  /** The flat transaction fee bands (from the console; built-in defaults without settings). */
  txnFees(): TxnFees { return this.o.settings?.txnFees() ?? { seller: DEFAULT_TXN_BANDS, buyer: DEFAULT_TXN_BANDS }; }
  private txnPayer(q: Quote): 'BUYER' | 'SELLER' | null { return q.txnPayer === 'buyer' ? 'BUYER' : q.txnPayer === 'seller' ? 'SELLER' : null; }

  /** The seller's money on an order, line by line (total price, their fee, what they receive). */
  sellerSum(d: Pick<Deal, 'price_minor' | 'seller_gets_minor' | 'fee_payer'>): SellerSum {
    return { price: this.money(d.price_minor), fee: this.money(d.price_minor - d.seller_gets_minor), feeLabel: this.sellerFeeLabel(d as Deal), gets: this.money(d.seller_gets_minor) };
  }
  /** The buyer's money on an order, line by line (total price, their fee, what they pay). */
  buyerSum(d: Pick<Deal, 'price_minor' | 'buyer_pays_minor' | 'fee_payer'>): BuyerSum {
    return { price: this.money(d.price_minor), fee: this.money(d.buyer_pays_minor - d.price_minor), feeLabel: this.buyerFeeLabel(d as Deal), pay: this.money(d.buyer_pays_minor) };
  }
  /** The same from a fresh quote (a new price the buyer hasn't accepted yet, or just accepted). */
  private quoteSums(q: Quote, feePayer: 'BUYER' | 'SELLER'): { seller: SellerSum; buyer: BuyerSum } {
    return {
      seller: this.sellerSum({ price_minor: q.priceMinor, seller_gets_minor: q.sellerGetsMinor, fee_payer: feePayer }),
      buyer: this.buyerSum({ price_minor: q.priceMinor, buyer_pays_minor: q.buyerPaysMinor, fee_payer: feePayer }),
    };
  }
  /** The seller's public trust card page, when they have it switched on. */
  async sellerCardUrl(sellerId: string | null): Promise<string | null> {
    if (!sellerId || !this.o.trust || !this.o.orderPageBase) return null;
    const t = await this.o.trust.seller(sellerId);
    return t?.isPublic && t.slug ? `${this.o.orderPageBase.replace(/\/$/, '')}/s/${t.slug}` : null;
  }

  /**
   * The seller describes what they're selling (the mirror of a buyer's order). We save it with photos, alert the
   * buyer's number, and give the seller a backup link. The buyer accepts (confirming the address), then pays.
   */
  async createSellerDeal(seller: User, input: SellerDealInput): Promise<{ deal: Deal; link: string; alert: SellerAlert }> {
    this.assertLimit(seller, input.priceMinor);
    const q = this.previewDeal(input.priceMinor, 'seller', Number.MAX_SAFE_INTEGER);
    const photos = await this.fetchPhotos(input.photos);
    const deal = await this.run(async (tx) => {
      const acct = await tx.query('SELECT 1 FROM bank_accounts WHERE id=$1 AND user_id=$2', [input.accountId, seller.id]);
      if (!acct.rowCount) throw new DealError('NOT_ALLOWED', 'Your payout account is missing');
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const r = await tx.query(
          `INSERT INTO deals (code, seller_id, seller_account_id, item, currency, price_minor, fee_minor, buyer_pays_minor, seller_gets_minor,
                              status, started_by, fee_payer, invited_phone, arrive_by, accept_by, is_test,
                              description, category, delivery_address, view_token, txn_fee_minor, txn_fee_payer)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'AWAITING_BUYER','SELLER','SELLER',$10,$11, now() + make_interval(hours => $12), $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (code) DO NOTHING RETURNING *`,
          [code, seller.id, input.accountId, input.item.slice(0, 200), this.o.currency, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor,
            input.buyerPhone, input.readyBy, this.acceptHours(), this.isTest(),
            input.description?.slice(0, 600) ?? null, input.category ?? null, input.address?.slice(0, 300) || null, randomBytes(12).toString('base64url'), q.txnFeeMinor, this.txnPayer(q)],
        );
        if (!r.rows[0]) continue;
        const d: Deal = r.rows[0];
        if (input.addressPin && input.address) await tx.query('UPDATE deals SET delivery_pin=$2 WHERE id=$1', [d.id, input.addressPin]);
        await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor) VALUES ($1,NULL,$2,$3)', [d.id, d.status, 'seller']);
        await this.savePhotos(tx, d.id, seller.id, photos, 'ITEM');
        return d;
      }
      throw new Error('Could not allocate a deal code');
    });
    const link = this.payLink(deal.code);
    const alert = await this.alertBuyer(deal, seller);
    await this.o.messenger.send(seller.phone, msg.sellDealReady(deal.code, await this.labelFor(input.buyerPhone), link, alert, this.acceptHours(), this.orderPageUrl(deal, 'seller')));
    return { deal, link, alert };
  }

  /** A person's first name, for messages (null when we don't know it). */
  async nameOf(userId: string | null | undefined): Promise<string | null> { return this.who(this.o.db, userId); }

  /** Someone's first name on an order, for "Ada · Order HL-X" (null when we don't know it). */
  private async who(q: Queryable, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const r = await q.query('SELECT display_name FROM users WHERE id=$1', [userId]);
    return firstName(r.rows[0]?.display_name ?? null);
  }

  /** The name someone goes by on Hoolam (first name), or their number the way people write it. */
  async labelFor(phone: string | null): Promise<string> {
    if (!phone) return 'Buyer';
    const r = await this.o.db.query('SELECT display_name FROM users WHERE phone=$1', [phone]);
    return firstName(r.rows[0]?.display_name ?? null) ?? localPhone(phone);
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

  /** One alert, once, to the buyer's number the seller typed. Not if that number said "Not me" to this seller before. */
  private async alertBuyer(deal: Deal, seller: User): Promise<SellerAlert> {
    const phone = deal.invited_phone;
    if (!phone || !this.alertsOn()) return 'none';
    if (phone === seller.phone && !this.o.testMode) return 'own-number';
    if (await this.refused(phone, seller.id)) return 'opted-out';
    const name = await this.shownSellerName(seller);
    const price = msg.moneyText(this.money(deal.price_minor));
    const total = msg.moneyText(this.money(deal.buyer_pays_minor));
    const status = await this.o.messenger.sendTemplate(phone, {
      name: BUYER_ALERT.name, language: 'en', headerImage: await this.alertPicture(deal.id),
      params: [name, deal.item, price, total, deal.code],
      buttonPayloads: [`bview:${deal.code}`, `bnotme:${deal.code}`],
      buttonTitles: BUYER_ALERT.buttons,
      preview: `🛍️ *New order for you* on *Hoolam*\n\n🏷️ Seller: *${name}*\n📦 Item: *${deal.item}*\n💰 Total price: *${price}*\n💳 You pay: *${total}*\n\nOrder *${deal.code}*.`,
    });
    if (status === 'FAILED') { this.log(`buyer alert for ${deal.code} failed; the seller still has the link`); return 'failed'; }
    await this.rememberAlert(deal, phone);
    return 'sent';
  }

  /** Did this number say "Not me" to this person before? Then they can't alert it again (everyone else still can). */
  private async refused(phone: string, fromUserId: string): Promise<boolean> {
    return !!(await this.o.db.query('SELECT 1 FROM alert_refusals WHERE phone=$1 AND from_user_id=$2', [phone, fromUserId])).rowCount;
  }
  private async refuse(tx: Tx, phone: string, fromUserId: string | null, code: string) {
    if (!fromUserId) return;
    await tx.query('INSERT INTO alert_refusals (phone, from_user_id, deal_code) VALUES ($1,$2,$3) ON CONFLICT (phone, from_user_id) DO NOTHING', [phone, fromUserId, code]);
  }

  /** "Not me" on a seller's alert: wrong number. Close the order; that seller can't alert this number again. */
  async buyerNotMe(code: string, viewer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.invited_phone === viewer.phone) await this.refuse(tx, viewer.phone, deal.seller_id, deal.code);
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
    this.assertLimit(buyer, input.priceMinor);
    const q = this.previewDeal(input.priceMinor, 'buyer', Number.MAX_SAFE_INTEGER);
    const photos = await this.fetchPhotos(input.photos);
    const deal = await this.run(async (tx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const r = await tx.query(
          `INSERT INTO deals (code, buyer_id, item, currency, price_minor, fee_minor, buyer_pays_minor, seller_gets_minor,
                              status, started_by, fee_payer, invited_phone, arrive_by, accept_by, is_test,
                              description, category, delivery_address, view_token, txn_fee_minor, txn_fee_payer)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AWAITING_SELLER','BUYER','BUYER',$9,$10, now() + make_interval(hours => $11), $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT (code) DO NOTHING RETURNING *`,
          [code, buyer.id, input.item.slice(0, 200), this.o.currency, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor,
            input.sellerPhone, input.arriveBy, this.acceptHours(), this.isTest(),
            input.description?.slice(0, 600) ?? null, input.category ?? null, input.address?.slice(0, 300) ?? null, randomBytes(12).toString('base64url'), q.txnFeeMinor, this.txnPayer(q)],
        );
        if (!r.rows[0]) continue;
        const d: Deal = r.rows[0];
        if (input.addressPin && input.address) await tx.query('UPDATE deals SET delivery_pin=$2 WHERE id=$1', [d.id, input.addressPin]);
        await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor) VALUES ($1,NULL,$2,$3)', [d.id, d.status, 'buyer']);
        await this.savePhotos(tx, d.id, buyer.id, photos, 'ITEM');
        return d;
      }
      throw new Error('Could not allocate a deal code');
    });

    const link = this.sellerLink(deal.code);
    const alert = await this.alertSeller(deal, buyer);
    await this.o.messenger.send(buyer.phone, msg.buyDealReady(deal.code, link, alert, this.acceptHours(), this.orderPageUrl(deal, 'buyer'), await this.labelFor(input.sellerPhone)));
    if (alert === 'failed') await this.o.messenger.send(buyer.phone, msg.buyerAlertFailed());
    return { deal, link, alert };
  }

  /** One alert, once, to the number the buyer typed. Not if that number said "Not me" to this buyer before. */
  private async alertSeller(deal: Deal, buyer: User): Promise<SellerAlert> {
    const phone = deal.invited_phone;
    if (!phone || !this.alertsOn()) return 'none';
    if (phone === buyer.phone && !this.o.testMode) return 'own-number';
    if (await this.refused(phone, buyer.id)) return 'opted-out';
    const name = firstName(buyer.display_name) ?? 'A buyer';
    const price = msg.moneyText(this.money(deal.price_minor));
    const status = await this.o.messenger.sendTemplate(phone, {
      name: SELLER_ALERT_TEMPLATE, language: 'en', headerImage: await this.alertPicture(deal.id),
      params: [name, deal.item, price, deal.code],
      buttonPayloads: [`sview:${deal.code}`, `snotme:${deal.code}`],
      buttonTitles: SELLER_ALERT.buttons,
      preview: `🛒 New order request on Hoolam\n\n${name} wants to buy ${deal.item} from you for ${price}. Order ${deal.code}.`,
    });
    if (status === 'FAILED') { this.log(`seller alert for ${deal.code} failed; the buyer still has the link`); return 'failed'; }
    await this.rememberAlert(deal, phone);
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
      await this.o.messenger.send(viewer.phone, deal.counter_seller_id === viewer.id ? msg.counterWaiting(deal.code, await this.nameOf(deal.buyer_id)) : msg.dealHasSeller(deal.code));
      return;
    }
    const buyer = await this.userById(this.o.db, deal.buyer_id!);
    await this.markSeen(deal.code, viewer);
    for (const mediaId of await this.photoIdsForSending(deal.id)) {
      await this.o.messenger.send(viewer.phone, { kind: 'image', mediaId });
    }
    const hoursLeft = deal.accept_by ? Math.max(1, Math.round((new Date(deal.accept_by).getTime() - Date.now()) / 3600_000)) : this.acceptHours();
    await this.o.messenger.send(viewer.phone, msg.sellerDealCard({
      code: deal.code, buyerName: firstName(buyer.display_name) ?? 'A buyer', item: deal.item,
      description: deal.description, category: categoryTitle(deal.category), address: deal.delivery_address,
      price: this.money(deal.price_minor), sellerGets: this.money(deal.seller_gets_minor),
      txnFee: deal.txn_fee_payer === 'SELLER' ? this.money(Number(deal.txn_fee_minor ?? 0)) : null,
      arriveBy: deal.arrive_by ? dayText(deal.arrive_by) : null, hoursLeft,
      invited: deal.invited_phone === viewer.phone,
      buyerLine: await this.buyerLineFor(deal.buyer_id), dealId: deal.id,
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
      this.assertLimit(seller, deal.price_minor); // above their limit: they check their ID first (the order waits)
      if (deal.counter_seller_id) await tx.query('UPDATE deals SET counter_price_minor=NULL, counter_seller_id=NULL, counter_account_id=NULL WHERE id=$1', [deal.id]);
      const acct = await tx.query('SELECT bank_name, account_number FROM bank_accounts WHERE id=$1 AND user_id=$2', [accountId, seller.id]);
      if (!acct.rows[0]) throw new DealError('NOT_ALLOWED');
      await tx.query('UPDATE deals SET seller_id=$2, seller_account_id=$3 WHERE id=$1', [deal.id, seller.id, accountId]);
      await this.move(tx, deal, 'AWAITING_PAYMENT', 'seller', 'Seller accepted the buyer\'s deal');
      const buyer = await this.userById(tx, deal.buyer_id!);
      out.push({ phone: seller.phone, message: msg.sellerAcceptedOk(deal.code, firstName(buyer.display_name) ?? 'The buyer', acct.rows[0].bank_name, String(acct.rows[0].account_number).slice(-4), this.sellerSum(deal)) });
      out.push({ phone: buyer.phone, message: msg.buyerSellerAccepted(deal.code, firstName(seller.display_name) ?? 'The seller', deal.item, { price: this.money(deal.price_minor), fee: this.money(deal.buyer_pays_minor - deal.price_minor), pay: this.money(deal.buyer_pays_minor), feeLabel: this.buyerFeeLabel(deal) }, await this.trustLineFor(seller.id), await this.sellerCardUrl(seller.id), await this.trustArt(seller.id)), fallback: dealTemplate('sellerAccepted', [deal.code, this.text(deal.buyer_pays_minor)], [`pay:${deal.code}`]) });
    });
  }


  // ---------- Update price: the seller suggests a different price on a buyer's deal ----------
  async counterAsSeller(code: string, seller: User, accountId: string, newPriceMinor: number, reason: string): Promise<void> {
    this.assertLimit(seller, newPriceMinor);
    reason = reason.replace(/\s+/g, ' ').trim().slice(0, 150);
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'AWAITING_SELLER') { out.push({ phone: seller.phone, message: deal.seller_id ? msg.dealHasSeller(deal.code) : msg.dealClosed(deal.code) }); return; }
      if (deal.buyer_id === seller.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      if (deal.counter_seller_id && deal.counter_seller_id !== seller.id) { out.push({ phone: seller.phone, message: msg.dealHasSeller(deal.code) }); return; }
      const acct = await tx.query('SELECT 1 FROM bank_accounts WHERE id=$1 AND user_id=$2', [accountId, seller.id]);
      if (!acct.rowCount) throw new DealError('NOT_ALLOWED');
      await tx.query('UPDATE deals SET counter_price_minor=$2, counter_seller_id=$3, counter_account_id=$4, counter_reason=$5, updated_at=now() WHERE id=$1', [deal.id, newPriceMinor, seller.id, accountId, reason || null]);
      await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)', [deal.id, deal.status, 'seller', `Suggested a new price: ${newPriceMinor}${reason ? `. Reason: ${reason}` : ''}`]);
      const buyer = await this.userById(tx, deal.buyer_id!);
      const q = quote(newPriceMinor, this.o.currency, this.pricingRules(), 'buyer', this.txnFees());
      out.push({ phone: seller.phone, message: msg.counterSent(deal.code, firstName(buyer.display_name) ?? 'the buyer', this.money(newPriceMinor), this.quoteSums(q, 'BUYER').seller) });
      out.push({ phone: buyer.phone, message: msg.buyerCounterOffer(deal.code, firstName(seller.display_name) ?? 'The seller', deal.item, this.money(deal.price_minor), this.money(newPriceMinor), this.money(q.buyerPaysMinor), reason, this.money(q.buyerPaysMinor - newPriceMinor), deal.id), fallback: dealTemplate('counterOffer', [deal.code, this.text(newPriceMinor), reason || 'not given', this.text(q.buyerPaysMinor - newPriceMinor), this.text(q.buyerPaysMinor)], [`cyes:${deal.code}`, `cancel:${deal.code}`]) });
    });
  }

  /** The buyer agrees to the seller's new price: the deal is on, at the new price. */
  async acceptCounter(code: string, buyer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'AWAITING_SELLER' || !deal.counter_price_minor || !deal.counter_seller_id) { out.push({ phone: buyer.phone, message: msg.dealClosed(deal.code) }); return; }
      this.assertLimit(buyer, Number(deal.counter_price_minor), true);
      const q = quote(deal.counter_price_minor, this.o.currency, this.pricingRules(), 'buyer', this.txnFees());
      await tx.query(
        `UPDATE deals SET price_minor=$2, fee_minor=$3, buyer_pays_minor=$4, seller_gets_minor=$5, seller_id=$6, seller_account_id=$7,
                          counter_price_minor=NULL, counter_seller_id=NULL, counter_account_id=NULL, txn_fee_minor=$8, txn_fee_payer=$9 WHERE id=$1`,
        [deal.id, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor, deal.counter_seller_id, deal.counter_account_id, q.txnFeeMinor, this.txnPayer(q)]);
      const seller = await this.userById(tx, deal.counter_seller_id);
      await this.move(tx, deal, 'AWAITING_PAYMENT', 'buyer', `Buyer accepted the new price ${q.priceMinor}`);
      const sums = this.quoteSums(q, deal.fee_payer);
      out.push({ phone: seller.phone, message: msg.sellerCounterAccepted(deal.code, firstName(buyer.display_name) ?? 'The buyer', sums.seller) });
      out.push({ phone: buyer.phone, message: msg.buyerSellerAccepted(deal.code, firstName(seller.display_name) ?? 'The seller', deal.item, sums.buyer, await this.trustLineFor(seller.id), await this.sellerCardUrl(seller.id), await this.trustArt(seller.id)), fallback: dealTemplate('sellerAccepted', [deal.code, this.text(q.buyerPaysMinor)], [`pay:${deal.code}`]) });
    });
  }

  /** The seller says no, or "Not me" (wrong number: that buyer can't alert this number again). */
  async declineAsSeller(code: string, viewer: User, notMe = false): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (notMe && deal.invited_phone === viewer.phone) await this.refuse(tx, viewer.phone, deal.buyer_id, deal.code);
      if (deal.status !== 'AWAITING_SELLER') {
        out.push({ phone: viewer.phone, message: notMe ? msg.sellerNotMeOk() : msg.dealClosed(deal.code) });
        return;
      }
      if (deal.buyer_id === viewer.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      await this.move(tx, deal, 'CANCELLED', 'seller', notMe ? 'Not me: the alerted number is not the seller' : 'Seller declined');
      const buyer = await this.userById(tx, deal.buyer_id!);
      out.push({ phone: viewer.phone, message: notMe ? msg.sellerNotMeOk() : msg.sellerDeclinedOk(deal.code, await this.who(tx, deal.buyer_id)) });
      out.push({ phone: buyer.phone, message: notMe ? msg.buyerNotMe(deal.code) : msg.buyerSellerDeclined(deal.code, firstName(viewer.display_name)), fallback: notMe ? undefined : dealTemplate('sellerDeclined', [deal.code], ['menu:buy']) });
    });
  }

  async photosFor(dealId: string): Promise<{ id: number; mime_type: string; size: number | null; created_at: Date }[]> {
    const r = await this.o.db.query('SELECT id, mime_type, octet_length(bytes) AS size, created_at FROM deal_photos WHERE deal_id=$1 ORDER BY id', [dealId]);
    return r.rows;
  }

  // ---------- 2. buyer opens the link ----------
  async joinAsBuyer(code: string, buyer: User): Promise<void> {
    const peek = await this.findByCode(code);
    // a seller's new order waits for the buyer to accept it: show it, change nothing yet
    if (peek && peek.status === 'AWAITING_BUYER' && !peek.legacy_ship) return this.showToBuyer(code, buyer);
    const canSee = peek && ['AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(peek.status) && (!peek.buyer_id || peek.buyer_id === buyer.id);
    const photoIds = canSee ? await this.photoIdsForSending(peek.id) : [];
    const trust = canSee ? await this.trustLineFor(peek.seller_id) : undefined;
    const cardUrl = canSee ? await this.sellerCardUrl(peek.seller_id) : null;
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
        message: msg.dealForBuyer(deal.code, deal.item, firstName(seller.display_name) ?? 'Seller', this.money(deal.price_minor), this.money(deal.buyer_pays_minor - deal.price_minor), this.money(deal.buyer_pays_minor), trust, this.buyerFeeLabel(deal), cardUrl, await this.trustArt(seller.id)),
      });
    });
  }

  /** A seller's new order, seen by the buyer (from the alert, the link or the code): the photos, then Accept / Decline. */
  async showToBuyer(code: string, viewer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    if (deal.status !== 'AWAITING_BUYER' || deal.legacy_ship) return this.joinAsBuyer(code, viewer);
    if (deal.seller_id === viewer.id && !this.o.testMode) { await this.o.messenger.send(viewer.phone, msg.ownSellDeal(deal.code, this.payLink(deal.code))); return; }
    const seller = await this.userById(this.o.db, deal.seller_id!);
    for (const mediaId of await this.photoIdsForSending(deal.id)) await this.o.messenger.send(viewer.phone, { kind: 'image', mediaId });
    await this.o.messenger.send(viewer.phone, msg.buyerOrderCard({
      code: deal.code, sellerName: await this.shownSellerName(seller), trust: await this.trustLineFor(seller.id), cardUrl: await this.sellerCardUrl(seller.id),
      item: deal.item, description: deal.description, category: categoryTitle(deal.category), address: deal.delivery_address,
      readyBy: deal.arrive_by ? dayText(deal.arrive_by) : null, sum: this.buyerSum(deal), hoursLeft: this.hoursLeft(deal), dealId: deal.id,
    }));
  }

  /** Hours left to accept (at least 1). */
  hoursLeft(deal: Pick<Deal, 'accept_by'>): number {
    return deal.accept_by ? Math.max(1, Math.round((new Date(deal.accept_by).getTime() - Date.now()) / 3600_000)) : this.acceptHours();
  }

  /**
   * The buyer accepts a seller's order, with the delivery address (the seller's, confirmed or changed, or their own).
   * The seller is told, and the buyer gets the payment details straight away.
   */
  async acceptAsBuyer(code: string, buyer: User, address: string | null, pin: string | null = null): Promise<'ok' | 'need-address' | 'closed'> {
    let sellerName = 'the seller';
    const buyerLine = await this.buyerLineFor(buyer.id); // the seller sees who accepted, as on a buyer's order
    const r = await this.run(async (tx, out): Promise<'ok' | 'need-address' | 'closed'> => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'AWAITING_BUYER' || deal.legacy_ship) {
        out.push({ phone: buyer.phone, message: deal.buyer_id === buyer.id ? msg.dealStatusNow(deal.code, deal.status) : msg.dealClosed(deal.code) });
        return 'closed';
      }
      if (deal.accept_by && new Date(deal.accept_by).getTime() < Date.now()) throw new DealError('CLOSED');
      if (deal.seller_id === buyer.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      this.assertLimit(buyer, deal.price_minor); // above their limit: they check their ID before paying
      const where = (address ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || deal.delivery_address;
      if (!where || where.length < 5) return 'need-address';
      // a new address drops the seller's pin (unless the buyer shared their own)
      await tx.query('UPDATE deals SET buyer_id=$2, delivery_address=$3, delivery_pin=$4 WHERE id=$1', [deal.id, buyer.id, where, pin ?? (where === deal.delivery_address ? deal.delivery_pin ?? null : null)]);
      await this.move(tx, deal, 'AWAITING_PAYMENT', 'buyer', where !== deal.delivery_address ? `Buyer accepted; delivery address: ${where}` : 'Buyer accepted the seller\'s order');
      const seller = await this.userById(tx, deal.seller_id!);
      sellerName = await this.shownSellerName(seller);
      const buyerName = firstName(buyer.display_name) ?? localPhone(buyer.phone);
      out.push({ phone: seller.phone, message: msg.sellerBuyerAccepted(deal.code, buyerName, this.sellerSum(deal), buyerLine), fallback: dealTemplate('buyerAccepted', [buyerName, deal.code]) });
      return 'ok';
    });
    if (r === 'ok') await this.requestPayment(code, buyer, false, `✅ *${sellerName}* · Order *${code.toUpperCase()}* accepted. Here's how to pay:`);
    return r;
  }

  /** The buyer says no to a seller's order, or "Wrong number" (then that seller can't alert this number again). */
  async declineAsBuyer(code: string, viewer: User, notMe = false): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (notMe && deal.invited_phone === viewer.phone) await this.refuse(tx, viewer.phone, deal.seller_id, deal.code);
      if (deal.status !== 'AWAITING_BUYER') { out.push({ phone: viewer.phone, message: notMe ? msg.sellerNotMeOk() : msg.dealClosed(deal.code) }); return; }
      if (deal.seller_id === viewer.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      if (notMe && deal.invited_phone !== viewer.phone) { out.push({ phone: viewer.phone, message: msg.sellerNotMeOk() }); return; }
      await this.move(tx, deal, 'CANCELLED', 'buyer', notMe ? 'Not me: the alerted number is not the buyer' : 'Buyer declined');
      const seller = await this.userById(tx, deal.seller_id!);
      const buyerName = firstName(viewer.display_name) ?? localPhone(viewer.phone);
      out.push({ phone: viewer.phone, message: notMe ? msg.sellerNotMeOk() : msg.buyerDeclinedOk(deal.code, await this.shownSellerName(seller)) });
      out.push({ phone: seller.phone, message: notMe ? msg.sellerBuyerNotMe(deal.code) : msg.sellerBuyerDeclined(deal.code, buyerName), fallback: notMe ? undefined : dealTemplate('buyerDeclined', [buyerName, deal.code], ['menu:sell']) });
    });
  }

  /** The seller takes back an order the buyer hasn't accepted yet. */
  async cancelBySeller(code: string, seller: User): Promise<void> {
    let tell: { phone: string; name: string } | null = null;
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.seller_id !== seller.id) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'AWAITING_BUYER') { out.push({ phone: seller.phone, message: msg.dealStatusNow(deal.code, deal.status) }); return; }
      await this.move(tx, deal, 'CANCELLED', 'seller', 'Seller cancelled before the buyer accepted');
      out.push({ phone: seller.phone, message: msg.sellerCancelledOk(deal.code, await this.labelFor(deal.invited_phone)) });
      if (deal.invited_phone && deal.invited_phone !== seller.phone) tell = { phone: deal.invited_phone, name: await this.shownSellerName(seller) };
    });
    // the buyer only hears about it if they're in the chat with Hoolam (no template needed for a non-event)
    const t = tell as { phone: string; name: string } | null;
    if (t && (await this.canReach(t.phone, '-'))) await this.o.messenger.send(t.phone, msg.buyerSellerCancelled(code.toUpperCase(), t.name));
  }

  /** Shows the buyer where to transfer. Reuses a still-valid account number if there is one. */
  async requestPayment(code: string, buyer: User, forceNew = false, intro?: string): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
    if (deal.status !== 'AWAITING_PAYMENT') throw new DealError('CLOSED');
    this.assertLimit(buyer, deal.price_minor, true);

    if (!forceNew) {
      const existing = await this.o.db.query(
        `SELECT * FROM payment_intents WHERE deal_id=$1 AND status='PENDING' AND (expires_at IS NULL OR expires_at > now() + interval '5 minutes')
         ORDER BY created_at DESC LIMIT 1`, [deal.id]);
      const pi = existing.rows[0];
      if (pi) {
        await this.o.messenger.send(buyer.phone, msg.payInstructions(this.money(pi.amount_minor), pi.account_number, pi.bank_name, pi.account_name, expiry(pi.expires_at), deal.code, this.payHint(), intro));
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
    await this.o.messenger.send(buyer.phone, msg.payInstructions(this.money(deal.buyer_pays_minor), instr.accountNumber, instr.bankName, instr.accountName, expiry(instr.expiresAt), deal.code, this.payHint(), intro));
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
      out.push({ phone: buyer.phone, message: msg.cancelled(deal.code, await this.who(tx, deal.seller_id ?? deal.counter_seller_id)) });
      const sellerId = deal.seller_id ?? deal.counter_seller_id;
      if (sellerId && sellerId !== buyer.id) {
        const seller = await this.userById(tx, sellerId);
        out.push({ phone: seller.phone, message: msg.sellerBuyerCancelled(deal.code, firstName(buyer.display_name) ?? localPhone(buyer.phone)) });
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
      if (buyer) out.push({ phone: buyer.phone, receipt: { dealId: deal.id, kind: 'payment' } });
      out.push({ phone: seller.phone, receipt: { dealId: deal.id, kind: 'payment-seller' } }); // a copy of the buyer's payment, for the seller to trust
      if (buyer) out.push({ phone: buyer.phone, message: msg.buyerFunded(this.money(deal.buyer_pays_minor), deal.code, firstName(seller.display_name) ?? 'the seller', this.buyerSum(deal)) });
      const buyerName = firstName(buyer?.display_name ?? null) ?? 'The buyer';
      if (!deal.legacy_ship) {
        const deliver = deal.delivery_address ? { address: deal.delivery_address, map: mapsLink(deal.delivery_address, deal.delivery_pin) } : null;
        out.push({ phone: seller.phone, message: msg.sellerFundedDispatch(deal.code, this.money(deal.seller_gets_minor), this.orderPageUrl(deal, 'seller'), buyerName, this.sellerSum(deal), deliver), fallback: dealTemplate('paidDispatch', [deal.code, this.text(deal.seller_gets_minor)], [`dispatch:${deal.code}`], ART.moneyHeld('seller', this.text(deal.seller_gets_minor), deal.code, buyerName === 'The buyer' ? null : buyerName)) });
      } else {
        out.push({ phone: seller.phone, message: msg.sellerFunded(deal.code, this.money(deal.seller_gets_minor), buyerName, this.sellerSum(deal)), fallback: dealTemplate('paymentReceived', [deal.code, this.text(deal.seller_gets_minor)], [`shipped:${deal.code}`], ART.moneyHeld('seller', this.text(deal.seller_gets_minor), deal.code, buyerName === 'The buyer' ? null : buyerName)) });
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
      out.push({ phone: seller.phone, message: msg.sellerShippedOk(deal.code, firstName(buyer.display_name)) });
      out.push({ phone: buyer.phone, message: msg.buyerShipped(deal.code, firstName(seller.display_name)), fallback: dealTemplate('itemOnTheWay', [deal.code], [`happy:${deal.code}`, `problem:${deal.code}`]) });
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
  orderPageUrl(deal: Pick<Deal, 'code' | 'view_token'>, viewer: 'buyer' | 'seller'): string | null {
    if (!deal.view_token || !this.o.orderPageBase) return null;
    return `${this.o.orderPageBase.replace(/\/$/, '')}/o/${deal.code}?k=${viewKey(deal.view_token, viewer)}`;
  }

  autoReleaseMinutes(): number { return this.o.settings?.autoReleaseMinutes() ?? 1440; }
  /** Wrong handover codes allowed before the order locks (console → Limits). */
  handoverTries(): number { return this.o.settings?.handoverCodeTries() ?? 5; }

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
      // the drop-off pin: the seller's shared location, or the buyer's when the rider goes to the buyer's address
      const pin = courier ? (d.pin ?? ((d.location ?? deal.delivery_address) === deal.delivery_address ? deal.delivery_pin ?? null : null)) : null;
      if (pin) await tx.query('UPDATE deals SET courier_pin=$2 WHERE id=$1', [deal.id, pin]);
      await this.move(tx, deal, 'SHIPPED', 'seller', `Dispatched: ${d.method}${fee ? `, delivery fee ${fee}` : ''}`);
      const buyer = await this.userById(tx, deal.buyer_id!);
      const buyerName = firstName(buyer.display_name) ?? 'Buyer';
      const sellerName = await this.shownSellerName(seller);
      const info = { code: deal.code, method: d.method, pickupAddress: d.pickupAddress ?? null, courierName: d.courierName ?? null, courierPhone: d.courierPhone ?? null, location: d.location ?? null };

      // the rider/driver gets the delivery details and can enter the buyer's code themselves (second way in; the seller's stays)
      let alert: 'sent' | 'not-sent' | 'skipped' | null = null;
      const courierPhone = courier ? d.courierPhone ?? null : null;
      if (courierPhone) {
        if (courierPhone === seller.phone || courierPhone === buyer.phone) alert = 'skipped';
        else alert = (await this.canReach(courierPhone, DEAL_TEMPLATES.courierJob.name)) ? 'sent' : 'not-sent';
        await tx.query('UPDATE deals SET courier_alert=$2 WHERE id=$1', [deal.id, alert]);
      }
      if (courierPhone && alert === 'sent') {
        const role = d.method === 'WAYBILL' ? 'driver' : 'rider';
        const account = d.account && fee ? { name: d.account.account_name, bank: d.account.bank_name, number: d.account.account_number } : null;
        const address = d.location ?? deal.delivery_address ?? null;
        const map = mapsLink(address, pin);
        out.push({
          phone: courierPhone,
          message: msg.courierJob({ code: deal.code, role, sellerName, buyerName, buyerPhone: buyer.phone, address, fee: fee ? this.money(fee) : null, account, map }),
          fallback: dealTemplate('courierJob', [
            sellerName, buyerName, localPhone(buyer.phone), address ?? 'ask the seller',
            fee ? this.text(fee) : 'none through Hoolam', account ? `${account.name}, ${account.bank} ${account.number}` : 'not needed',
          ], [`hcode:${deal.code}`]),
        });
        // a real map pin (one tap for directions), when there is one and the rider is in the chat with Hoolam
        const mm = this.o.messenger as Partial<Messenger>;
        if (pin && typeof mm.windowOpen === 'function' && (await mm.windowOpen(courierPhone))) {
          const [lat, lng] = pin.split(',').map(Number);
          out.push({ phone: courierPhone, message: { kind: 'location', latitude: lat!, longitude: lng!, name: `Deliver to ${buyerName}`, ...(address ? { address: address.slice(0, 200) } : {}) } });
        }
      }
      out.push({ phone: seller.phone, message: msg.sellerDispatched({ ...info, page: this.orderPageUrl(deal, 'seller'), fee: fee ? this.money(fee) : null, buyerName, courierAlerted: alert === 'sent', sum: this.sellerSum(deal) }) });
      out.push({ phone: buyer.phone, message: msg.buyerDispatched({ ...info, page: this.orderPageUrl(deal, 'buyer'), handover, sellerName }), fallback: dealTemplate('orderDispatched', [deal.code], [`hcodeshow:${deal.code}`, `problem:${deal.code}`]) });
    });
  }

  /** Can we message this number now: they wrote to Hoolam in the last 24 hours, or the template is approved? */
  private async canReach(phone: string, template: string): Promise<boolean> {
    const m = this.o.messenger as Partial<Messenger>;
    if (typeof m.windowOpen === 'function' && (await m.windowOpen(phone))) return true;
    return typeof m.canUseTemplate === 'function' ? m.canUseTemplate(template) : false;
  }

  /** The seller's name as buyers see it (their trust card name), else their first name. */
  private async shownSellerName(seller: User): Promise<string> {
    const t = this.o.trust ? await this.o.trust.seller(seller.id).catch(() => null) : null;
    return t?.name ?? firstName(seller.display_name) ?? 'Your seller';
  }

  /** Is this person the rider/driver on this order (and not the buyer or seller)? */
  private isCourier(deal: Deal, user: User): boolean {
    return !!deal.courier_phone && deal.dispatch_method !== 'PICKUP' && user.phone === deal.courier_phone && user.id !== deal.buyer_id && user.id !== deal.seller_id;
  }

  /** "Enter code" (seller or rider/driver): asks for the 4 digits if the order is waiting for them. True = now waiting for the digits. */
  async askForHandoverCode(code: string, who: User): Promise<boolean> {
    const deal = await this.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    const courier = deal.seller_id !== who.id && this.isCourier(deal, who);
    if (deal.seller_id !== who.id && !courier) throw new DealError('NOT_ALLOWED');
    if (deal.status !== 'SHIPPED' || !deal.handover_code || deal.handed_over_at) {
      await this.o.messenger.send(who.phone, courier ? msg.courierNothingToDo(deal.code, !!deal.handed_over_at, await this.nameOf(deal.buyer_id)) : msg.dealStatusNow(deal.code, deal.status));
      return false;
    }
    if (deal.handover_tries >= this.handoverTries()) { await this.o.messenger.send(who.phone, msg.handoverLocked(deal.code, await this.who(this.o.db, deal.buyer_id))); return false; }
    const r = await this.o.db.query('SELECT display_name FROM users WHERE id=$1', [deal.buyer_id]);
    await this.o.messenger.send(who.phone, msg.askHandoverCode(deal.code, firstName(r.rows[0]?.display_name ?? null)));
    return true;
  }

  /** Shows the buyer their handover code again. */
  async showHandoverCode(code: string, buyer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal || deal.buyer_id !== buyer.id) throw new DealError('NOT_FOUND');
    if (!deal.handover_code || deal.handed_over_at || deal.status !== 'SHIPPED') {
      await this.o.messenger.send(buyer.phone, msg.dealStatusNow(deal.code, deal.status));
      return;
    }
    // the delivery details with the code (this is what "Delivery details" on the dispatched alert brings up)
    const seller = deal.seller_id ? await this.userById(this.o.db, deal.seller_id) : null;
    await this.o.messenger.send(buyer.phone, msg.buyerDispatched({
      code: deal.code, method: deal.dispatch_method ?? 'PICKUP', pickupAddress: deal.pickup_address, courierName: deal.courier_name,
      courierPhone: deal.courier_phone, location: deal.courier_location, handover: deal.handover_code, page: this.orderPageUrl(deal, 'buyer'),
      sellerName: seller ? await this.shownSellerName(seller) : undefined,
    }));
  }

  /**
   * The 4 digits the buyer gives at handover. Two people can enter them: the seller (as always), or the rider/driver
   * themselves from their own WhatsApp (if the number the seller gave is on WhatsApp). Same code, same shared tries;
   * whoever enters it first confirms the handover. Right: the rider/driver is paid their fee, and the buyer gets a set
   * time to say "I'm happy" or report a problem. Too many wrong tries (console → Limits) lock it for the team.
   */
  async enterHandoverCode(code: string, who: User, digits: string): Promise<CodeResult> {
    let payoutId: string | null = null;
    const result = await this.run(async (tx, out): Promise<CodeResult> => {
      const deal = await this.lockByCode(tx, code);
      const courier = deal.seller_id !== who.id && this.isCourier(deal, who);
      if (deal.seller_id !== who.id && !courier) throw new DealError('NOT_ALLOWED');
      if (deal.status !== 'SHIPPED' || !deal.handover_code || deal.handed_over_at) {
        out.push({ phone: who.phone, message: courier ? msg.courierNothingToDo(deal.code, !!deal.handed_over_at, await this.who(tx, deal.buyer_id)) : msg.dealStatusNow(deal.code, deal.status) });
        return 'not-ready';
      }
      const seller = await this.userById(tx, deal.seller_id!);
      const bn = await this.who(tx, deal.buyer_id);
      if (deal.handover_tries >= this.handoverTries()) { out.push({ phone: who.phone, message: msg.handoverLocked(deal.code, bn) }); return 'locked'; }
      if (digits.replace(/\D/g, '') !== deal.handover_code) {
        const tries = deal.handover_tries + 1;
        await tx.query('UPDATE deals SET handover_tries=$2 WHERE id=$1', [deal.id, tries]);
        if (tries >= this.handoverTries()) {
          await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)',
            [deal.id, deal.status, courier ? 'courier' : 'seller', `NEEDS_ATTENTION: handover code locked after ${tries} wrong tries`]);
          out.push({ phone: who.phone, message: msg.handoverLocked(deal.code, bn) });
          if (courier) out.push({ phone: seller.phone, message: msg.handoverLocked(deal.code, bn) });
          return 'locked';
        }
        out.push({ phone: who.phone, message: msg.handoverWrong(deal.code, this.handoverTries() - tries, bn) });
        return 'wrong';
      }
      await tx.query('UPDATE deals SET handed_over_at=now(), handover_by=$2, updated_at=now() WHERE id=$1', [deal.id, courier ? 'courier' : 'seller']);
      await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)',
        [deal.id, deal.status, courier ? 'courier' : 'seller', `Handover code confirmed by the ${courier ? (deal.dispatch_method === 'WAYBILL' ? 'driver' : 'rider') : 'seller'}`]);
      payoutId = await this.payCourier(tx, deal);
      const buyer = await this.userById(tx, deal.buyer_id!);
      const buyerName = firstName(buyer.display_name) ?? 'The buyer';
      const minutes = this.autoReleaseMinutes();
      const role = deal.dispatch_method === 'WAYBILL' ? 'driver' : 'rider';
      const courierFee = payoutId ? this.money(Number(deal.delivery_fee_minor)) : null;
      if (courier) {
        const acct = deal.courier_account_id ? (await tx.query('SELECT account_name, bank_name, account_number FROM bank_accounts WHERE id=$1', [deal.courier_account_id])).rows[0] : null;
        out.push({ phone: who.phone, message: msg.courierConfirmed(deal.code, buyerName, courierFee, acct ? { name: acct.account_name, bank: acct.bank_name, number: acct.account_number } : null) });
      }
      out.push({ phone: seller.phone, message: msg.sellerHandedOver(deal.code, courierFee, deal.courier_name, waitText(minutes), { buyerName, byCourier: courier, role, sum: this.sellerSum(deal) }) });
      out.push({ phone: buyer.phone, message: msg.buyerHandedOver(deal.code, waitText(minutes), firstName(seller.display_name)), fallback: dealTemplate('handedOver', [deal.code, waitText(minutes)], [`happy:${deal.code}`, `problem:${deal.code}`]) });
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
        out.push({ phone: buyer.phone, message: msg.askRefundAccountNow(deal.code, by, await this.who(tx, deal.seller_id)) });
        if (by === 'seller') out.push({ phone: user.phone, message: msg.sellerRefundStarted(deal.code, false, firstName(buyer.display_name)) });
        return 'need-account';
      }
      const note = by === 'seller' ? 'Seller can\'t fulfil the order' : 'Not dispatched by the expected date; buyer asked for a refund';
      payoutId = await this.startRefund(tx, deal, by, note, acct.rows[0].id);
      const seller = await this.sellerOf(tx, deal);
      if (by === 'seller') out.push({ phone: seller.phone, message: msg.sellerRefundStarted(deal.code, true, firstName(buyer.display_name)) });
      else out.push({ phone: seller.phone, message: msg.sellerBuyerTookRefund(deal.code, firstName(buyer.display_name)) });
      out.push({ phone: buyer.phone, message: msg.buyerRefundStarted(deal.code, by, firstName(seller.display_name)) });
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

  /**
   * A message from Hoolam support (typed in the console), sent at any time. It goes as the approved
   * "Hoolam support" template about an order (the one given, or the person's latest), so it reaches them even if they
   * haven't messaged in 24 hours. Before Meta approves it, or for someone with no orders, it goes as a normal chat
   * message (only possible inside their 24-hour window). Their next message goes to the support inbox.
   */
  async sendSupportMessage(phone: string, rawText: string, code?: string | null, replyTo?: string | null): Promise<{ status: SendStatus; via: 'template' | 'chat'; code: string | null }> {
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, SUPPORT_MESSAGE_MAX);
    if (text.length < 2) throw new DealError('NOT_ALLOWED', 'Write a message first.');
    let orderCode = code ?? null;
    if (!orderCode) {
      const r = await this.o.db.query(
        `SELECT d.code FROM deals d JOIN users u ON u.id IN (d.buyer_id, d.seller_id, d.counter_seller_id) WHERE u.phone=$1 ORDER BY d.created_at DESC LIMIT 1`, [phone]);
      orderCode = r.rows[0]?.code ?? null;
    }
    const tpl = DEAL_TEMPLATES.supportMessage;
    let status: SendStatus; let via: 'template' | 'chat';
    if (orderCode && this.o.messenger.canUseTemplate(tpl.name)) {
      status = await this.o.messenger.sendTemplate(phone, { ...dealTemplate('supportMessage', [orderCode, text]), maxParam: SUPPORT_MESSAGE_MAX, ...(replyTo ? { replyTo } : {}) });
      via = 'template';
    } else {
      status = await this.o.messenger.send(phone, { ...msg.fromSupport(text, orderCode), ...(replyTo ? { replyTo } : {}) });
      via = 'chat';
    }
    // their reply goes to the support inbox (unless they're in the middle of something)
    if (status === 'SENT' || status === 'DRY_RUN') {
      await this.o.db.query(`UPDATE chat_sessions SET state='HUMAN_MESSAGE', data=$2 WHERE phone=$1 AND state='IDLE'`, [phone, JSON.stringify(orderCode ? { code: orderCode } : {})]);
    }
    return { status, via, code: orderCode };
  }

  /** "Send reminder": the buyer nudges a seller who hasn't dispatched. */
  async remindSeller(code: string, buyer: User): Promise<void> {
    const deal = await this.findByCode(code);
    if (!deal || deal.buyer_id !== buyer.id || !deal.seller_id) throw new DealError('NOT_FOUND');
    if (deal.status !== 'FUNDED' || deal.dispatched_at) { await this.o.messenger.send(buyer.phone, msg.dealStatusNow(deal.code, deal.status)); return; }
    const seller = await this.userById(this.o.db, deal.seller_id);
    await this.o.messenger.send(seller.phone, msg.sellerDispatchReminder(deal.code, deal.item, true, firstName(buyer.display_name) ?? 'The buyer'), dealTemplate('dispatchReminder', [deal.code], [`dispatch:${deal.code}`]));
    await this.o.messenger.send(buyer.phone, msg.reminderSent(deal.code, await this.who(this.o.db, deal.seller_id)));
  }

  // ---------- 5a. buyer is happy → pay the seller ----------
  async confirmHappy(code: string, buyer: User): Promise<void> {
    const payoutIds = await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (!['FUNDED', 'SHIPPED'].includes(deal.status)) throw new DealError('NOT_ALLOWED');
      if (deal.status === 'FUNDED') await this.move(tx, deal, 'SHIPPED', 'buyer', 'Buyer confirmed before seller marked it sent');
      const ids = await this.startRelease(tx, deal, 'buyer', undefined, out);
      const seller = await this.sellerOf(tx, deal);
      const n = Number((await tx.query(`SELECT count(*) AS n FROM deals WHERE buyer_id=$1 AND (status IN ('RELEASING','PAYOUT_PENDING','COMPLETED') OR id=$2)`, [buyer.id, deal.id])).rows[0].n);
      out.push({ phone: buyer.phone, message: msg.buyerReleased(deal.code, firstName(seller.display_name) ?? 'the seller', ART.complete(deal.item, n, firstName(seller.display_name) ?? null, deal.id)) });
      return ids;
    });
    for (const id of payoutIds) await this.submitPayout(id);
  }

  /**
   * Pays the seller what's left: everything still held, minus Hoolam's fee. If a rider or driver was set to be
   * paid and hasn't been yet (no code was entered), they're paid first. Returns the payouts to send.
   */
  private async startRelease(tx: Tx, deal: Deal, actor: string, note?: string, out?: Outbox): Promise<string[]> {
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
    // the ambassadors of the seller and of the buyer earn their share of what Hoolam earned (and the seller bonus)
    if (this.o.ambassadors) {
      const notices = await this.o.ambassadors.onRelease(tx, { ...deal, is_test: (deal as Deal & { is_test?: boolean }).is_test }, fee);
      for (const n of notices) out?.push({ phone: n.phone, message: n.message, fallback: n.fallback });
    }
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
      out.push({ phone: buyer.phone, message: msg.askProblem(deal.code, firstName(seller.display_name), this.money(deal.buyer_pays_minor)) });
      out.push({ phone: seller.phone, message: msg.sellerProblem(deal.code, firstName(buyer.display_name), this.money(deal.seller_gets_minor)), fallback: dealTemplate('problemReported', [deal.code], ['menu:human']) });
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
      const sellerId = deal.seller_id ?? deal.counter_seller_id;
      for (const id of new Set([deal.buyer_id, sellerId].filter(Boolean) as string[])) {
        const u = await this.userById(tx, id);
        // each side sees the other person's name first
        const other = id === deal.buyer_id ? await this.who(tx, sellerId) : await this.who(tx, deal.buyer_id);
        out.push({ phone: u.phone, message: msg.cancelledByHoolam(deal.code, other) });
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
    const payoutIds = await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'DISPUTED' && deal.status !== 'SHIPPED' && deal.status !== 'FUNDED') throw new DealError('NOT_ALLOWED');
      if (deal.status === 'FUNDED') await this.move(tx, deal, 'SHIPPED', 'admin', note);
      await tx.query(`UPDATE disputes SET status='RESOLVED_RELEASE', resolution_note=$2, resolved_at=now() WHERE deal_id=$1 AND status='OPEN'`, [deal.id, note]);
      return this.startRelease(tx, deal, 'admin', note, out);
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
      `SELECT p.*, b.bank_code, b.account_number, b.account_name, b.bank_name, d.code, d.seller_id, d.buyer_id FROM payouts p
       JOIN bank_accounts b ON b.id=p.bank_account_id JOIN deals d ON d.id=p.deal_id WHERE p.id=$1`, [payoutId]);
    const p = r.rows[0];
    if (!p || p.status !== 'CREATED') return;
    // every seller's ID is checked once before their money leaves, and the account must be in that name
    if (p.kind === 'SELLER' && this.kycOn && p.seller_id) {
      const seller = await this.userById(this.o.db, p.seller_id);
      if (!isVerified(seller) || !this.accountMatches(seller.kyc_name, p.account_name)) return this.holdForKyc(p, seller);
    }
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

  /** The picture at the top of an order alert: the item's first photo, else the Hoolam card. Never throws. */
  private brandCardId: { id: string; at: number } | null = null;
  private async alertPicture(dealId: string): Promise<string | undefined> {
    try {
      const first = (await this.photoIdsForSending(dealId))[0];
      if (first) return first;
      if (!this.o.media) return undefined;
      // our uploads last 30 days on WhatsApp: reuse the card for 20
      if (!this.brandCardId || Date.now() - this.brandCardId.at > 20 * 86_400_000) this.brandCardId = { id: await this.o.media.upload(await renderBrandCard(), 'image/jpeg'), at: Date.now() };
      return this.brandCardId.id;
    } catch (e) { this.log(`alert picture: ${(e as Error).message}`); return undefined; }
  }

  // ---------- "seen": the other side has opened the order ----------
  /** Keeps WhatsApp's id of the order alert, so its "read" receipt can tell the person waiting. */
  private async rememberAlert(deal: Deal, phone: string): Promise<void> {
    const m = this.o.messenger as Partial<Messenger>;
    const id = typeof m.lastSentId === 'function' ? await m.lastSentId(phone).catch(() => null) : null;
    if (id) await this.o.db.query('UPDATE deals SET alert_wa_id=$2 WHERE id=$1', [deal.id, id]);
  }

  /** WhatsApp says a message we sent was read: if it was an order alert, the order has been seen. */
  async seenByMessage(waId: string): Promise<void> {
    const r = await this.o.db.query(`SELECT code FROM deals WHERE alert_wa_id=$1 AND seen_at IS NULL`, [waId]);
    if (r.rows[0]) await this.markSeen(r.rows[0].code, null);
  }

  /**
   * The other side has seen a new order (read the alert, or opened the order). The person waiting is told once:
   * "👀 Mama Bella has seen your order HL-X." Only while it waits for an answer, and only inside their 24 hours.
   */
  async markSeen(code: string, viewer: User | null): Promise<void> {
    const peek = await this.findByCode(code);
    if (!peek || peek.seen_at || !['AWAITING_SELLER', 'AWAITING_BUYER'].includes(peek.status)) return;
    const starterId = peek.status === 'AWAITING_SELLER' ? peek.buyer_id : peek.seller_id;
    if (viewer && viewer.id === starterId) return; // the person who started it, looking at their own order
    const r = await this.o.db.query(`UPDATE deals SET seen_at=now() WHERE id=$1 AND seen_at IS NULL RETURNING *`, [peek.id]);
    const deal = r.rows[0] as Deal | undefined;
    if (!deal || !starterId) return;
    const starter = await this.userById(this.o.db, starterId);
    const other = viewer ?? (deal.invited_phone ? (await this.o.db.query(`SELECT ${USER_COLS} FROM users WHERE phone=$1`, [deal.invited_phone])).rows[0] as User | undefined : undefined) ?? null;
    const name = deal.status === 'AWAITING_SELLER'
      ? (other ? await this.shownSellerName(other) : null) ?? 'The seller'
      : (other ? firstName(other.display_name) : null) ?? 'The buyer';
    const m = this.o.messenger as Partial<Messenger>;
    if (typeof m.windowOpen === 'function' && !(await m.windowOpen(starter.phone))) return; // no template for a "seen" note
    await this.o.messenger.send(starter.phone, msg.orderSeen(deal.code, name, deal.status === 'AWAITING_SELLER' ? 'seller' : 'buyer'));
  }

  // ---------- receipts ----------
  private when(d: Date | string | null | undefined): string {
    return new Date(d ?? Date.now()).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  /** What a receipt says. Null when there's nothing to show yet (e.g. not paid). */
  async receiptData(dealId: string, kind: ReceiptKind, payoutId?: string): Promise<ReceiptData | null> {
    const deal = (await this.o.db.query('SELECT * FROM deals WHERE id=$1', [dealId])).rows[0] as Deal | undefined;
    if (!deal) return null;
    const t = (minor: number) => this.text(Number(minor));
    const seller = deal.seller_id ? await this.userById(this.o.db, deal.seller_id) : null;
    const buyer = deal.buyer_id ? await this.userById(this.o.db, deal.buyer_id) : null;
    const sellerName = seller ? await this.shownSellerName(seller) : 'The seller';
    const buyerName = firstName(buyer?.display_name ?? null) ?? 'The buyer';
    const order = { label: 'Order', value: `${deal.code} · ${deal.item}` };
    if (kind === 'payment' || kind === 'payment-seller') {
      if (!deal.funded_at) return null;
      const pi = (await this.o.db.query(`SELECT payment_reference FROM payment_intents WHERE deal_id=$1 AND status='PAID' ORDER BY updated_at DESC LIMIT 1`, [deal.id])).rows[0];
      const ref = { label: 'Reference', value: pi?.payment_reference ?? deal.code };
      const paidAt = { label: 'Paid', value: this.when(deal.funded_at) };
      if (kind === 'payment') {
        const b = this.buyerSum(deal);
        return {
          title: 'Payment received', amount: t(deal.buyer_pays_minor), tone: 'teal', status: 'Held safely by Hoolam until you’re happy',
          rows: [{ label: 'Total price', value: msg.moneyText(b.price) }, { label: b.feeLabel, value: msg.moneyText(b.fee) }, { label: 'You paid', value: msg.moneyText(b.pay), strong: true }],
          details: [order, { label: 'Seller', value: sellerName }, paidAt, ref],
        };
      }
      const sum = this.sellerSum(deal);
      return {
        title: 'Payment confirmed by Hoolam', amount: t(deal.buyer_pays_minor), tone: 'teal', status: `Held safely by Hoolam. Paid to you when ${buyerName} is happy.`,
        intro: `${buyerName} has paid Hoolam for your order. Send it now.`,
        rows: [{ label: 'Total price', value: msg.moneyText(sum.price) }, { label: sum.feeLabel, value: `−${msg.moneyText(sum.fee)}` }, { label: 'You receive', value: msg.moneyText(sum.gets), strong: true }],
        details: [order, { label: 'Buyer', value: buyerName }, paidAt, ref],
        note: 'This is Hoolam’s own record of the payment. Only trust payments confirmed here, not a buyer’s screenshot.',
      };
    }
    const p = payoutId
      ? (await this.o.db.query(`SELECT p.*, b.bank_name, b.account_number, b.account_name FROM payouts p JOIN bank_accounts b ON b.id=p.bank_account_id WHERE p.id=$1 AND p.status='SUCCESS'`, [payoutId])).rows[0]
      : null;
    if (!p) return null;
    const to = `${p.bank_name} ••••${String(p.account_number).slice(-4)}`;
    const sent = { label: 'Sent', value: this.when(p.updated_at) };
    const ref = { label: 'Reference', value: p.reference };
    const acct = { label: 'Account name', value: p.account_name };
    if (kind === 'payout') {
      const sum = this.sellerSum(deal);
      const delivery = Number(deal.delivery_fee_minor ?? 0) && deal.courier_paid_at ? Number(deal.delivery_fee_minor) : 0;
      return {
        title: 'Payout sent', amount: t(p.amount_minor), status: `Sent to ${to}`,
        rows: [
          { label: 'Total price', value: msg.moneyText(sum.price) }, { label: sum.feeLabel, value: `−${msg.moneyText(sum.fee)}` },
          ...(delivery ? [{ label: deal.dispatch_method === 'WAYBILL' ? 'Driver’s fee (paid)' : 'Rider’s fee (paid)', value: `−${t(delivery)}` }] : []),
          { label: 'Paid to you', value: t(p.amount_minor), strong: true },
        ],
        details: [order, { label: 'Buyer', value: buyerName }, acct, sent, ref],
      };
    }
    if (kind === 'refund') {
      return {
        title: 'Refund sent', amount: t(p.amount_minor), status: `Sent to ${to}`,
        rows: [{ label: 'You paid', value: t(deal.buyer_pays_minor) }, { label: 'Refunded to you', value: t(p.amount_minor), strong: true }],
        details: [order, { label: 'Seller', value: sellerName }, acct, sent, ref],
      };
    }
    const role = deal.dispatch_method === 'WAYBILL' ? 'driver' : 'rider';
    return {
      title: 'Delivery fee sent', amount: t(p.amount_minor), status: `Sent to ${to}`,
      intro: kind === 'courier-seller' ? `Your ${role} was paid from the money held for this order, once the handover code was right.` : `For delivering ${sellerName}’s order to ${buyerName}.`,
      rows: [{ label: kind === 'courier-seller' ? `${role[0]!.toUpperCase()}${role.slice(1)}’s fee` : 'Delivery fee', value: t(p.amount_minor), strong: true }],
      details: [kind === 'courier' ? { label: 'Order', value: deal.code } : order, { label: kind === 'courier' ? 'From' : 'Buyer', value: kind === 'courier' ? sellerName : buyerName }, acct, sent, ref],
    };
  }

  /** The receipt picture (null when there's nothing to show). `small`: a lighter copy for the My orders form. */
  async receiptImage(dealId: string, kind: ReceiptKind, payoutId?: string, small = false): Promise<Buffer | null> {
    const d = await this.receiptData(dealId, kind, payoutId);
    return d ? renderReceipt(d, small ? 0.6 : 1) : null;
  }

  /** The receipts one side of an order can see, newest last. */
  async receiptsFor(dealId: string, side: 'buyer' | 'seller'): Promise<{ kind: ReceiptKind; payoutId?: string; label: string }[]> {
    const d = (await this.o.db.query('SELECT funded_at FROM deals WHERE id=$1', [dealId])).rows[0];
    if (!d) return [];
    const out: { kind: ReceiptKind; payoutId?: string; label: string }[] = [];
    if (d.funded_at) out.push({ kind: side === 'buyer' ? 'payment' : 'payment-seller', label: side === 'buyer' ? 'Payment received' : 'Payment confirmed' });
    const ps = await this.o.db.query(`SELECT id, kind FROM payouts WHERE deal_id=$1 AND status='SUCCESS' ORDER BY updated_at`, [dealId]);
    for (const p of ps.rows) {
      if (side === 'seller' && p.kind === 'SELLER') out.push({ kind: 'payout', payoutId: p.id, label: 'Payout sent' });
      if (side === 'seller' && p.kind === 'DELIVERY') out.push({ kind: 'courier-seller', payoutId: p.id, label: 'Delivery fee sent' });
      if (side === 'buyer' && p.kind === 'REFUND') out.push({ kind: 'refund', payoutId: p.id, label: 'Refund sent' });
    }
    return out;
  }

  /**
   * Sends a receipt picture into the chat. Only inside the person's 24 hours (a picture can't go as a template);
   * outside it, or if the picture can't be made, nothing is lost: the receipt stays in My orders.
   */
  async sendReceipt(phone: string, dealId: string, kind: ReceiptKind, payoutId?: string): Promise<boolean> {
    try {
      const m = this.o.messenger as Partial<Messenger>;
      if (typeof m.windowOpen === 'function' && !(await m.windowOpen(phone))) return false;
      if (!this.o.media) return false;
      const img = await this.receiptImage(dealId, kind, payoutId);
      if (!img) return false;
      const code = (await this.o.db.query('SELECT code FROM deals WHERE id=$1', [dealId])).rows[0]?.code ?? '';
      const mediaId = await this.o.media.upload(img, 'image/jpeg');
      const status = await this.o.messenger.send(phone, { kind: 'image', mediaId, caption: `🧾 Receipt · Order ${code}` });
      return status !== 'FAILED' && status !== 'NEEDS_TEMPLATE';
    } catch (e) {
      this.log(`receipt (${kind}) for …${phone.slice(-4)} not sent: ${(e as Error).message}`);
      return false;
    }
  }

  /** A seller's payout waits for their ID check (or for an account in their own name). They're told what to do. */
  private async holdForKyc(p: any, seller: User): Promise<void> {
    const held = await this.o.db.query(`UPDATE payouts SET status='WAITING_KYC', provider_message=$2, updated_at=now() WHERE id=$1 AND status='CREATED' RETURNING id`,
      [p.id, isVerified(seller) ? 'Waiting for a payout account in the seller\'s own name' : 'Waiting for the seller\'s ID check']);
    if (!held.rowCount) return;
    await this.o.db.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor, note) SELECT id, status, status, $2, $3 FROM deals WHERE id=$1',
      [p.deal_id, 'system', isVerified(seller) ? 'Payout waiting: the payout account isn\'t in the seller\'s ID name' : 'Payout waiting: the seller checks their ID first']);
    const buyerName = await this.who(this.o.db, p.buyer_id);
    if (isVerified(seller)) {
      await this.askForOwnAccount(seller.phone, { payoutFix: true });
      await this.o.messenger.send(seller.phone, msg.payoutAccountMismatch(p.code, this.money(Number(p.amount_minor)), p.account_name, seller.kyc_name ?? '', buyerName));
      return;
    }
    await this.o.messenger.send(seller.phone, msg.sellerPayoutNeedsKyc(p.code, this.money(Number(p.amount_minor)), buyerName));
  }

  /** Waits in the chat for an account number (after "this account isn't in your name"). */
  private async askForOwnAccount(phone: string, data: Record<string, unknown>): Promise<void> {
    await this.o.db.query(
      `INSERT INTO chat_sessions (phone, state, data) VALUES ($1,'ACCOUNT_BANK',$2)
       ON CONFLICT (phone) DO UPDATE SET state='ACCOUNT_BANK', data=$2, updated_at=now()`, [phone, JSON.stringify(data)]);
  }

  /** Seller payouts waiting for this seller's ID check. */
  async heldPayouts(userId: string): Promise<{ id: string; code: string; amount_minor: number; account_name: string }[]> {
    const r = await this.o.db.query(
      `SELECT p.id, d.code, p.amount_minor, b.account_name FROM payouts p JOIN deals d ON d.id=p.deal_id JOIN bank_accounts b ON b.id=p.bank_account_id
       WHERE p.status='WAITING_KYC' AND p.kind='SELLER' AND d.seller_id=$1 ORDER BY p.created_at`, [userId]);
    return r.rows;
  }

  /**
   * After the seller verifies (or adds an account in their own name): sends every payout that was waiting.
   * Payouts going to an account in another name move to their default account if that one matches.
   * 'mismatch': some still need an account in their own name (we've asked for one).
   */
  async releaseHeldPayouts(userId: string): Promise<'none' | 'released' | 'mismatch'> {
    const seller = await this.userById(this.o.db, userId);
    if (!isVerified(seller)) return 'none';
    const held = await this.heldPayouts(userId);
    if (!held.length) return 'none';
    const def = await this.defaultBankAccount(userId);
    const good = def && this.accountMatches(seller.kyc_name, def.account_name) ? def : null;
    const go: string[] = [];
    let stuck: (typeof held)[number] | null = null;
    for (const p of held) {
      if (this.accountMatches(seller.kyc_name, p.account_name)) { go.push(p.id); continue; }
      if (good) {
        await this.o.db.query('UPDATE payouts SET bank_account_id=$2 WHERE id=$1', [p.id, good.id]);
        await this.o.db.query(`UPDATE deals SET seller_account_id=$2 WHERE code=$1`, [p.code, good.id]);
        go.push(p.id);
      } else stuck ??= p;
    }
    for (const id of go) {
      await this.o.db.query(`UPDATE payouts SET status='CREATED', provider_message=NULL, updated_at=now() WHERE id=$1 AND status='WAITING_KYC'`, [id]);
      await this.submitPayout(id);
    }
    if (stuck) {
      await this.askForOwnAccount(seller.phone, { payoutFix: true });
      await this.o.messenger.send(seller.phone, msg.payoutAccountMismatch(stuck.code, this.money(Number(stuck.amount_minor)), stuck.account_name, seller.kyc_name ?? '', null));
      return 'mismatch';
    }
    return 'released';
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
          out.push({ phone: seller.phone, receipt: { dealId: deal.id, kind: 'payout', payoutId: p.id } });
          const buyerName = deal.buyer_id ? firstName((await this.userById(tx, deal.buyer_id)).display_name) : null;
          const delivery = Number(deal.delivery_fee_minor ?? 0) && deal.courier_paid_at ? this.money(Number(deal.delivery_fee_minor)) : null;
          const sum = { ...this.sellerSum(deal), delivery, role: deal.dispatch_method === 'WAYBILL' ? 'driver' as const : 'rider' as const };
          const exact = sum.gets.minor - (delivery?.minor ?? 0) === Number(p.amount_minor);
          out.push({ phone: seller.phone, message: msg.sellerPaid(deal.code, this.money(p.amount_minor), bankName, buyerName, exact ? sum : undefined), fallback: dealTemplate('sellerPaid', [deal.code, this.text(p.amount_minor), bankName], [], ART.paid('paid', this.text(p.amount_minor), { bank: bankName, code: deal.code })) });
        } else {
          const buyer = await this.userById(tx, deal.buyer_id!);
          const seller = await this.sellerOf(tx, deal);
          out.push({ phone: buyer.phone, receipt: { dealId: deal.id, kind: 'refund', payoutId: p.id } });
          out.push({ phone: buyer.phone, message: msg.buyerRefunded(deal.code, this.money(p.amount_minor), bankName, firstName(seller.display_name)), fallback: dealTemplate('refundSent', [deal.code, this.text(p.amount_minor), bankName], [], ART.refund(this.text(p.amount_minor), deal.code, bankName)) });
          out.push({ phone: seller.phone, message: msg.sellerRefunded(deal.code, firstName(buyer.display_name)) });
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
          out.push({ phone: seller.phone, message: msg.sellerPayoutDelayed(deal.code, await this.who(tx, deal.buyer_id)) });
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
      const acct = await tx.query('SELECT account_name, bank_name, account_number FROM bank_accounts WHERE id=$1', [p.bank_account_id]);
      const a = acct.rows[0];
      const buyerName = deal.buyer_id ? firstName((await this.userById(tx, deal.buyer_id)).display_name) : null;
      out.push({ phone: seller.phone, receipt: { dealId: deal.id, kind: 'courier-seller', payoutId: p.id } });
      out.push({ phone: seller.phone, message: msg.courierPaid(deal.code, this.money(Number(p.amount_minor)), a?.account_name ?? 'the rider', a?.bank_name ?? 'bank', buyerName) });
      // the rider/driver too, if they're in the chat with Hoolam (no template for this one: it's a bonus, not a must)
      const m = this.o.messenger as Partial<Messenger>;
      if (a && deal.courier_phone && deal.courier_alert === 'sent' && typeof m.windowOpen === 'function' && (await m.windowOpen(deal.courier_phone))) {
        out.push({ phone: deal.courier_phone, receipt: { dealId: deal.id, kind: 'courier', payoutId: p.id } });
        out.push({ phone: deal.courier_phone, message: msg.courierFeeSent(buyerName ?? 'the buyer', this.money(Number(p.amount_minor)), { name: a.account_name, bank: a.bank_name, number: a.account_number }) });
      }
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
          const ids = await this.startRelease(tx, deal, 'system', `No problem reported within ${waitText(this.autoReleaseMinutes())} of handover`, out);
          const buyer = await this.userById(tx, deal.buyer_id!);
          out.push({ phone: buyer.phone, message: msg.autoReleased(deal.code, await this.who(tx, deal.seller_id)) });
          return ids;
        });
        for (const id of ids) await this.submitPayout(id);
        if (ids.length) released++;
      } catch (e) { this.log(`auto-release ${row.id}: ${(e as Error).message}`); }
    }
    const toNudge = await this.o.db.query(
      `SELECT d.code, d.buyer_pays_minor, u.phone, s.display_name AS seller_name FROM deals d JOIN users u ON u.id=d.buyer_id LEFT JOIN users s ON s.id=d.seller_id
       WHERE d.status='SHIPPED' AND d.reminded_at IS NULL AND d.shipped_at < now() - make_interval(hours => $1) LIMIT 50`,
      [opts.nudgeAfterHours]);
    for (const row of toNudge.rows) {
      await this.o.db.query('UPDATE deals SET reminded_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.buyerNudge(row.code, firstName(row.seller_name)), dealTemplate('confirmReminder', [row.code, this.text(Number(row.buyer_pays_minor))], [`happy:${row.code}`, `problem:${row.code}`]));
      nudged++;
    }
    // Paid but not dispatched: remind the seller once.
    const waiting = await this.o.db.query(
      `SELECT d.code, d.item, u.phone, b.display_name AS buyer_name FROM deals d JOIN users u ON u.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id
       WHERE d.status='FUNDED' AND NOT d.legacy_ship AND d.dispatched_at IS NULL AND d.dispatch_reminded_at IS NULL
         AND d.funded_at < now() - make_interval(hours => $1) LIMIT 50`,
      [this.o.settings?.dispatchRemindHours() ?? 12]);
    for (const row of waiting.rows) {
      await this.o.db.query('UPDATE deals SET dispatch_reminded_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.sellerDispatchReminder(row.code, row.item, false, firstName(row.buyer_name) ?? 'Buyer'), dealTemplate('dispatchReminder', [row.code], [`dispatch:${row.code}`]));
      nudged++;
    }
    // Still not dispatched after the date the buyer expected: give the buyer their options, once.
    const late = await this.o.db.query(
      `SELECT d.code, d.item, d.started_by, u.phone, s.display_name AS seller_name FROM deals d JOIN users u ON u.id=d.buyer_id LEFT JOIN users s ON s.id=d.seller_id
       WHERE d.status='FUNDED' AND d.dispatched_at IS NULL AND d.overdue_notified_at IS NULL AND d.arrive_by IS NOT NULL
         AND (d.arrive_by + 1)::timestamp AT TIME ZONE 'Africa/Lagos' < now() LIMIT 50`);
    for (const row of late.rows) {
      await this.o.db.query('UPDATE deals SET overdue_notified_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.buyerOverdue(row.code, row.item, row.started_by === 'SELLER', firstName(row.seller_name)), dealTemplate('overdue', [row.code], [`remind:${row.code}`, `refundme:${row.code}`]));
      nudged++;
    }
    const stale = await this.o.db.query(
      `SELECT id FROM deals WHERE (status='AWAITING_PAYMENT' OR (status='AWAITING_BUYER' AND accept_by IS NULL)) AND updated_at < now() - make_interval(hours => $1) LIMIT 100`,
      [opts.expireUnpaidAfterHours ?? this.o.settings?.unpaidCloseHours() ?? 72]);
    for (const row of stale.rows) {
      await this.run(async (tx) => {
        const deal = await this.lockById(tx, row.id);
        if (deal.status === 'AWAITING_BUYER' || deal.status === 'AWAITING_PAYMENT') { await this.move(tx, deal, 'EXPIRED', 'system'); expired++; }
      });
    }
    // a seller's order the buyer didn't accept in time (the same console time as for sellers)
    const notAccepted = await this.o.db.query(`SELECT id FROM deals WHERE status='AWAITING_BUYER' AND accept_by < now() LIMIT 100`);
    for (const row of notAccepted.rows) {
      await this.run(async (tx, out) => {
        const deal = await this.lockById(tx, row.id);
        if (deal.status !== 'AWAITING_BUYER') return;
        await this.move(tx, deal, 'EXPIRED', 'system', 'Buyer did not accept in time');
        const seller = await this.userById(tx, deal.seller_id!);
        out.push({ phone: seller.phone, message: msg.sellerBuyerExpired(deal.code, await this.labelFor(deal.invited_phone)), fallback: dealTemplate('buyerNoReply', [deal.code], ['menu:sell']) });
        expired++;
      });
    }
    const unanswered = await this.o.db.query(`SELECT id FROM deals WHERE status='AWAITING_SELLER' AND accept_by < now() LIMIT 100`);
    for (const row of unanswered.rows) {
      await this.run(async (tx, out) => {
        const deal = await this.lockById(tx, row.id);
        if (deal.status !== 'AWAITING_SELLER') return;
        await this.move(tx, deal, 'EXPIRED', 'system', 'Seller did not accept in time');
        const buyer = await this.userById(tx, deal.buyer_id!);
        out.push({ phone: buyer.phone, message: msg.buyerSellerExpired(deal.code, await this.labelFor(deal.invited_phone)), fallback: dealTemplate('sellerNoReply', [deal.code], ['menu:buy']) });
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

function expiry(expiresAt: Date | string | null): Date | null {
  return expiresAt ? new Date(expiresAt) : null;
}

export { DealStatus };
