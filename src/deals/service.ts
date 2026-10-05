import { randomBytes, randomUUID } from 'node:crypto';
import { withTx, type Db, type Queryable, type Tx } from '../db.js';
import { post } from '../ledger.js';
import type { Currency } from '../money.js';
import { quote } from '../pricing.js';
import type { PaymentProvider, PayoutResult } from '../payments/provider.js';
import type { Messenger, Outbound } from '../whatsapp/client.js';
import { msg } from '../whatsapp/messages.js';
import { canMove, DealStatus, type DealStatus as Status } from './states.js';

export interface Deal {
  id: string; code: string; seller_id: string; buyer_id: string | null; item: string; currency: Currency;
  price_minor: number; fee_minor: number; buyer_pays_minor: number; seller_gets_minor: number;
  seller_account_id: string | null; status: Status; created_at: Date; funded_at: Date | null; shipped_at: Date | null;
}
export interface User { id: string; phone: string; display_name: string | null }
export interface BankAccount { id: string; user_id: string; bank_code: string; bank_name: string; account_number: string; account_name: string }

type Outbox = { phone: string; message: Outbound }[];

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
  waNumber: string;           // digits, for wa.me links
  testMode?: boolean;         // fake money: allow self-deals and show a test hint
  log?: (line: string) => void;
}

export class DealService {
  constructor(private readonly o: DealServiceOptions) {}

  private log(line: string) { this.o.log?.(line); }

  get maxDealMinor(): number { return this.o.maxDealMinor; }

  /** Run fn in a transaction; send the queued WhatsApp messages only after it commits. */
  private async run<T>(fn: (tx: Tx, out: Outbox) => Promise<T>): Promise<T> {
    const out: Outbox = [];
    const result = await withTx(this.o.db, (tx) => fn(tx, out));
    for (const o of out) {
      try { await this.o.messenger.send(o.phone, o.message); } catch (e) { this.log(`send failed: ${(e as Error).message}`); }
    }
    return result;
  }

  private money(minor: number) { return { minor, currency: this.o.currency }; }

  // ---------- users & bank accounts ----------
  async upsertUser(phone: string, name: string | null): Promise<User> {
    const r = await this.o.db.query(
      `INSERT INTO users (phone, display_name) VALUES ($1,$2)
       ON CONFLICT (phone) DO UPDATE SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
       RETURNING id, phone, display_name`,
      [phone, name],
    );
    return r.rows[0];
  }

  async userById(q: Queryable, id: string): Promise<User> {
    const r = await q.query('SELECT id, phone, display_name FROM users WHERE id=$1', [id]);
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
  previewDeal(priceMinor: number) {
    if (priceMinor > this.o.maxDealMinor) throw new DealError('TOO_BIG');
    return quote(priceMinor, this.o.currency);
  }

  async createDeal(args: { sellerId: string; item: string; priceMinor: number; sellerAccountId: string }): Promise<{ deal: Deal; link: string }> {
    const q = this.previewDeal(args.priceMinor);
    return this.run(async (tx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const r = await tx.query(
          `INSERT INTO deals (code, seller_id, item, currency, price_minor, fee_minor, buyer_pays_minor, seller_gets_minor, seller_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (code) DO NOTHING RETURNING *`,
          [code, args.sellerId, args.item.slice(0, 200), this.o.currency, q.priceMinor, q.feeMinor, q.buyerPaysMinor, q.sellerGetsMinor, args.sellerAccountId],
        );
        if (r.rows[0]) {
          const deal: Deal = r.rows[0];
          await tx.query('INSERT INTO deal_events (deal_id, from_status, to_status, actor) VALUES ($1,NULL,$2,$3)', [deal.id, deal.status, 'seller']);
          return { deal, link: this.payLink(deal.code) };
        }
      }
      throw new Error('Could not allocate a deal code');
    });
  }

  payLink(code: string): string {
    return `https://wa.me/${this.o.waNumber}?text=${encodeURIComponent('Pay ' + code)}`;
  }

  // ---------- 2. buyer opens the link ----------
  async joinAsBuyer(code: string, buyer: User): Promise<void> {
    await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.seller_id === buyer.id && !this.o.testMode) throw new DealError('OWN_DEAL');
      if (deal.buyer_id && deal.buyer_id !== buyer.id) throw new DealError('TAKEN');
      if (!['AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(deal.status)) throw new DealError('CLOSED');
      const seller = await this.userById(tx, deal.seller_id);
      if (!deal.buyer_id) {
        await tx.query('UPDATE deals SET buyer_id=$2 WHERE id=$1', [deal.id, buyer.id]);
        await this.move(tx, deal, 'AWAITING_PAYMENT', 'buyer');
        if (seller.id !== buyer.id) out.push({ phone: seller.phone, message: msg.sellerBuyerJoined(deal.code) });
      }
      out.push({
        phone: buyer.phone,
        message: msg.dealForBuyer(deal.code, deal.item, seller.display_name ?? 'Seller', this.money(deal.price_minor), this.money(deal.buyer_pays_minor - deal.price_minor), this.money(deal.buyer_pays_minor)),
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
        await this.o.messenger.send(buyer.phone, msg.payInstructions(this.money(pi.amount_minor), pi.account_number, pi.bank_name, pi.account_name, minutesLeft(pi.expires_at), deal.code, this.o.testMode));
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
    await this.o.messenger.send(buyer.phone, msg.payInstructions(this.money(deal.buyer_pays_minor), instr.accountNumber, instr.bankName, instr.accountName, minutesLeft(instr.expiresAt), deal.code, this.o.testMode));
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
      if (deal.status !== 'AWAITING_PAYMENT') throw new DealError('CLOSED');
      const paid = await tx.query(`SELECT 1 FROM payment_intents WHERE deal_id=$1 AND status IN ('PAID','PARTIAL')`, [deal.id]);
      if (paid.rowCount) throw new DealError('NOT_ALLOWED');
      await this.move(tx, deal, 'CANCELLED', 'buyer');
      const seller = await this.userById(tx, deal.seller_id);
      out.push({ phone: buyer.phone, message: msg.cancelled(deal.code) });
      out.push({ phone: seller.phone, message: msg.sellerBuyerCancelled(deal.code) });
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
      const seller = await this.userById(tx, deal.seller_id);
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
      out.push({ phone: seller.phone, message: msg.sellerFunded(deal.code, this.money(deal.seller_gets_minor)) });
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
      out.push({ phone: buyer.phone, message: msg.buyerShipped(deal.code) });
    });
  }

  // ---------- 5a. buyer is happy → pay the seller ----------
  async confirmHappy(code: string, buyer: User): Promise<void> {
    const payoutId = await this.run(async (tx, out) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.buyer_id !== buyer.id) throw new DealError('NOT_ALLOWED');
      if (!['FUNDED', 'SHIPPED'].includes(deal.status)) throw new DealError('NOT_ALLOWED');
      if (deal.status === 'FUNDED') await this.move(tx, deal, 'SHIPPED', 'buyer', 'Buyer confirmed before seller marked it sent');
      const id = await this.startRelease(tx, deal, 'buyer');
      out.push({ phone: buyer.phone, message: msg.buyerReleased(deal.code) });
      return id;
    });
    await this.submitPayout(payoutId);
  }

  private async startRelease(tx: Tx, deal: Deal, actor: string, note?: string): Promise<string> {
    await this.move(tx, deal, 'RELEASING', actor, note);
    const fee = deal.buyer_pays_minor - deal.seller_gets_minor;
    await post(tx, {
      dealId: deal.id, currency: deal.currency, memo: `Release ${deal.code} to seller`,
      lines: [
        { account: 'held:deal', amountMinor: deal.buyer_pays_minor },
        { account: 'payable:seller', amountMinor: -deal.seller_gets_minor },
        { account: 'revenue:fees', amountMinor: -fee },
      ],
    });
    if (!deal.seller_account_id) throw new Error(`Deal ${deal.code} has no seller bank account`);
    const r = await tx.query(
      `INSERT INTO payouts (deal_id, kind, provider, reference, amount_minor, currency, bank_account_id) VALUES ($1,'SELLER',$2,$3,$4,$5,$6) RETURNING id`,
      [deal.id, this.o.provider.name, `${deal.code}-PAY-${randomUUID().slice(0, 6)}`, deal.seller_gets_minor, deal.currency, deal.seller_account_id],
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
      const seller = await this.userById(tx, deal.seller_id);
      out.push({ phone: buyer.phone, message: msg.askProblem(deal.code) });
      out.push({ phone: seller.phone, message: msg.sellerProblem(deal.code) });
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
  async adminRelease(code: string, note: string): Promise<void> {
    const payoutId = await this.run(async (tx) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'DISPUTED' && deal.status !== 'SHIPPED' && deal.status !== 'FUNDED') throw new DealError('NOT_ALLOWED');
      if (deal.status === 'FUNDED') await this.move(tx, deal, 'SHIPPED', 'admin', note);
      await tx.query(`UPDATE disputes SET status='RESOLVED_RELEASE', resolution_note=$2, resolved_at=now() WHERE deal_id=$1 AND status='OPEN'`, [deal.id, note]);
      return this.startRelease(tx, deal, 'admin', note);
    });
    await this.submitPayout(payoutId);
  }

  async adminRefund(code: string, note: string): Promise<void> {
    const payoutId = await this.run(async (tx) => {
      const deal = await this.lockByCode(tx, code);
      if (deal.status !== 'DISPUTED' && deal.status !== 'FUNDED') throw new DealError('NOT_ALLOWED');
      const acct = await tx.query('SELECT id FROM bank_accounts WHERE user_id=$1 AND is_default ORDER BY created_at DESC LIMIT 1', [deal.buyer_id]);
      if (!acct.rows[0]) throw new DealError('NOT_ALLOWED', 'The buyer has not given a refund account yet');
      await this.move(tx, deal, 'REFUNDING', 'admin', note);
      await tx.query(`UPDATE disputes SET status='RESOLVED_REFUND', resolution_note=$2, resolved_at=now() WHERE deal_id=$1 AND status='OPEN'`, [deal.id, note]);
      // Phase 1 policy: a refund returns everything the buyer paid, fee included.
      await post(tx, {
        dealId: deal.id, currency: deal.currency, memo: `Refund ${deal.code} to buyer`,
        lines: [{ account: 'held:deal', amountMinor: deal.buyer_pays_minor }, { account: 'payable:buyer', amountMinor: -deal.buyer_pays_minor }],
      });
      const r = await tx.query(
        `INSERT INTO payouts (deal_id, kind, provider, reference, amount_minor, currency, bank_account_id) VALUES ($1,'REFUND',$2,$3,$4,$5,$6) RETURNING id`,
        [deal.id, this.o.provider.name, `${deal.code}-REF-${randomUUID().slice(0, 6)}`, deal.buyer_pays_minor, deal.currency, acct.rows[0].id],
      );
      return r.rows[0].id;
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
          const seller = await this.userById(tx, deal.seller_id);
          out.push({ phone: seller.phone, message: msg.sellerPaid(deal.code, this.money(p.amount_minor), bankName) });
        } else {
          const buyer = await this.userById(tx, deal.buyer_id!);
          const seller = await this.userById(tx, deal.seller_id);
          out.push({ phone: buyer.phone, message: msg.buyerRefunded(deal.code, this.money(p.amount_minor), bankName) });
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
          const seller = await this.userById(tx, deal.seller_id);
          out.push({ phone: seller.phone, message: msg.sellerPayoutDelayed(deal.code) });
        }
      }
    });
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
  async sweep(opts: { nudgeAfterHours: number; expireUnpaidAfterHours?: number }): Promise<{ nudged: number; expired: number }> {
    let nudged = 0;
    let expired = 0;
    const toNudge = await this.o.db.query(
      `SELECT d.code, u.phone FROM deals d JOIN users u ON u.id=d.buyer_id
       WHERE d.status='SHIPPED' AND d.reminded_at IS NULL AND d.shipped_at < now() - make_interval(hours => $1) LIMIT 50`,
      [opts.nudgeAfterHours]);
    for (const row of toNudge.rows) {
      await this.o.db.query('UPDATE deals SET reminded_at=now() WHERE code=$1', [row.code]);
      await this.o.messenger.send(row.phone, msg.buyerNudge(row.code));
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
    return { nudged, expired };
  }
}

function minutesLeft(expiresAt: Date | string | null): number | null {
  if (!expiresAt) return null;
  return Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

export { DealStatus };
