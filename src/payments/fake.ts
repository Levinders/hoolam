import { randomUUID } from 'node:crypto';
import type {
  Bank, CollectionInstructions, CollectionRequest, PaymentCheck, PaymentProvider, PayoutRequest, PayoutResult, ProviderEvent,
} from './provider.js';

/**
 * In-memory provider for local development and tests. Use `pay()` to simulate a buyer's transfer
 * and `payoutOutcome` to simulate how payouts behave.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  private collections = new Map<string, { req: CollectionRequest; paidMinor: number }>();
  private payouts = new Map<string, PayoutResult>();
  payoutOutcome: PayoutResult['status'] = 'SUCCESS';
  accountNames: Record<string, string> = {};

  static BANKS: Bank[] = [
    { code: '50515', name: 'Moniepoint MFB' }, { code: '058', name: 'GTBank' }, { code: '044', name: 'Access Bank' },
    { code: '057', name: 'Zenith Bank' }, { code: '011', name: 'First Bank' }, { code: '033', name: 'UBA' },
    { code: '035', name: 'Wema Bank' }, { code: '999992', name: 'OPay' }, { code: '50211', name: 'Kuda' },
    { code: '999991', name: 'PalmPay' },
  ];

  async createCollection(req: CollectionRequest): Promise<CollectionInstructions> {
    const providerReference = 'FAKE|' + randomUUID().slice(0, 8);
    this.collections.set(providerReference, { req, paidMinor: 0 });
    return {
      providerReference,
      accountNumber: String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
      accountName: 'Hoolam / ' + req.customerName,
      bankName: 'Moniepoint MFB',
      expiresAt: new Date(Date.now() + 40 * 60_000),
    };
  }

  /** Simulate the buyer's transfer landing. */
  pay(providerReference: string, amountMinor?: number): void {
    const c = this.collections.get(providerReference);
    if (!c) throw new Error('unknown collection ' + providerReference);
    c.paidMinor += amountMinor ?? c.req.amountMinor;
  }

  /** Build the webhook body the fake would send. */
  webhookFor(providerReference: string): string {
    const c = this.collections.get(providerReference);
    return JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { transactionReference: providerReference, paymentReference: c?.req.paymentReference ?? null } });
  }

  async checkCollection(providerReference: string): Promise<PaymentCheck> {
    const c = this.collections.get(providerReference);
    if (!c) return { status: 'FAILED', amountPaidMinor: 0, providerReference, paymentReference: null };
    const due = c.req.amountMinor;
    const status = c.paidMinor === 0 ? 'PENDING' : c.paidMinor < due ? 'PARTIAL' : c.paidMinor > due ? 'OVERPAID' : 'PAID';
    return { status, amountPaidMinor: c.paidMinor, providerReference, paymentReference: c.req.paymentReference };
  }

  async listBanks(): Promise<Bank[]> { return FakeProvider.BANKS; }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<string | null> {
    if (!/^\d{10}$/.test(accountNumber)) return null;
    return this.accountNames[`${bankCode}:${accountNumber}`] ?? 'TEST ACCOUNT HOLDER';
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const r: PayoutResult = { status: this.payoutOutcome };
    this.payouts.set(req.reference, r);
    return r;
  }

  async authorizePayout(reference: string, otp: string): Promise<PayoutResult> {
    const r: PayoutResult = otp === '000000' ? { status: 'FAILED', message: 'Wrong OTP' } : { status: 'SUCCESS' };
    this.payouts.set(reference, r);
    return r;
  }

  async checkPayout(reference: string): Promise<PayoutResult> {
    return this.payouts.get(reference) ?? { status: 'FAILED', message: 'unknown payout' };
  }

  parseWebhook(rawBody: string): ProviderEvent | null {
    try {
      const b = JSON.parse(rawBody);
      if (b.eventType === 'SUCCESSFUL_TRANSACTION') {
        return { kind: 'collection', providerReference: b.eventData.transactionReference, paymentReference: b.eventData.paymentReference, eventKey: 'col:' + b.eventData.transactionReference };
      }
      return { kind: 'ignored', eventKey: 'other:' + rawBody.length + ':' + Date.now() };
    } catch { return null; }
  }
}
