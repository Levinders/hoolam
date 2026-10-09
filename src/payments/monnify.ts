import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  Bank, CollectionInstructions, CollectionRequest, PaymentCheck, PaymentProvider, PaymentStatus,
  PayoutRequest, PayoutResult, PayoutStatus, ProviderEvent,
} from './provider.js';

/**
 * Monnify (by Moniepoint).
 * Docs: https://developers.monnify.com
 *  - Pay with transfer: each payment gets a one-time account number (valid up to 40 minutes).
 *  - Disbursements: payouts from your Monnify wallet to any Nigerian bank.
 *  - Webhooks: the `monnify-signature` header is only sent in production, so we always
 *    re-check the transaction with the API before treating money as received.
 *
 * Endpoints marked "confirm in sandbox" follow Monnify's documented naming but should be
 * checked on your first sandbox run.
 */

interface Envelope<T> { requestSuccessful: boolean; responseMessage: string; responseCode: string; responseBody: T }

export interface MonnifyOptions {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
  contractCode: string;
  walletAccountNumber: string;
  requireSignature: boolean;
  fetchImpl?: typeof fetch;
}

const toNaira = (minor: number) => Math.round(minor) / 100;
const toKobo = (naira: number) => Math.round(Number(naira) * 100);

export class MonnifyProvider implements PaymentProvider {
  readonly name = 'monnify';
  get sandbox(): boolean { return /sandbox/i.test(this.o.baseUrl); }
  private token: { value: string; expiresAt: number } | null = null;
  private banksCache: { at: number; banks: Bank[] } | null = null;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: MonnifyOptions) {
    this.fetch = o.fetchImpl ?? fetch;
  }

  // ---------- auth ----------
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.o.apiKey}:${this.o.secretKey}`).toString('base64');
    const res = await this.fetch(`${this.o.baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
    const text = await res.text();
    let body: Envelope<{ accessToken: string; expiresIn?: number }>;
    try { body = JSON.parse(text); } catch { throw new Error(`Monnify login failed: HTTP ${res.status}: ${text.slice(0, 120)}`); }
    if (!res.ok || !body.requestSuccessful) throw new Error(`Monnify login failed: ${body.responseMessage || 'HTTP ' + res.status}`);
    this.token = { value: body.responseBody.accessToken, expiresAt: Date.now() + (body.responseBody.expiresIn ?? 3000) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetch(`${this.o.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body: Envelope<T>;
    try { body = JSON.parse(text) as Envelope<T>; } catch { throw new Error(`Monnify ${method} ${path}: HTTP ${res.status}: ${text.slice(0, 120)}`); }
    if (!res.ok || !body.requestSuccessful) {
      const err = new Error(`Monnify ${method} ${path}: ${body.responseMessage || 'HTTP ' + res.status}`);
      (err as Error & { code?: string }).code = body.responseCode;
      throw err;
    }
    return body.responseBody;
  }

  // ---------- collections ----------
  async createCollection(req: CollectionRequest): Promise<CollectionInstructions> {
    if (req.currency !== 'NGN') throw new Error('Monnify only collects NGN');
    const init = await this.call<{ transactionReference: string }>('POST', '/api/v1/merchant/transactions/init-transaction', {
      amount: toNaira(req.amountMinor),
      customerName: req.customerName,
      customerEmail: req.customerEmail,
      paymentReference: req.paymentReference,
      paymentDescription: req.description.slice(0, 100),
      currencyCode: 'NGN',
      contractCode: this.o.contractCode,
      paymentMethods: ['ACCOUNT_TRANSFER'],
    });
    const acct = await this.call<{ accountNumber: string; accountName: string; bankName: string; accountDurationSeconds?: number }>(
      'POST', '/api/v1/merchant/bank-transfer/init-payment', { transactionReference: init.transactionReference },
    );
    return {
      providerReference: init.transactionReference,
      accountNumber: acct.accountNumber,
      accountName: acct.accountName,
      bankName: acct.bankName,
      expiresAt: acct.accountDurationSeconds ? new Date(Date.now() + acct.accountDurationSeconds * 1000) : null,
    };
  }

  async checkCollection(providerReference: string): Promise<PaymentCheck> {
    const t = await this.call<{ paymentStatus: string; amountPaid: number; paymentReference?: string; transactionReference: string }>(
      'GET', `/api/v2/transactions/${encodeURIComponent(providerReference)}`,
    );
    const map: Record<string, PaymentStatus> = {
      PAID: 'PAID', OVERPAID: 'OVERPAID', PARTIALLY_PAID: 'PARTIAL', PENDING: 'PENDING',
      EXPIRED: 'EXPIRED', FAILED: 'FAILED', CANCELLED: 'FAILED', ABANDONED: 'EXPIRED', REVERSED: 'FAILED',
    };
    return {
      status: map[t.paymentStatus] ?? 'PENDING',
      amountPaidMinor: toKobo(t.amountPaid ?? 0),
      providerReference: t.transactionReference ?? providerReference,
      paymentReference: t.paymentReference ?? null,
    };
  }

  // ---------- banks ----------
  async listBanks(): Promise<Bank[]> {
    if (this.banksCache && Date.now() - this.banksCache.at < 12 * 3600_000) return this.banksCache.banks;
    const rows = await this.call<{ name: string; code: string }[]>('GET', '/api/v1/banks');
    const banks = rows.map((b) => ({ code: String(b.code), name: b.name }));
    this.banksCache = { at: Date.now(), banks };
    return banks;
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<string | null> {
    try {
      const r = await this.call<{ accountName: string }>(
        'GET', `/api/v1/disbursements/account/validate?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`,
      );
      return r.accountName || null;
    } catch {
      return null;
    }
  }

  // ---------- payouts ----------
  private mapPayout(status: string | undefined, message?: string): PayoutResult {
    const s = (status ?? '').toUpperCase();
    const map: Record<string, PayoutStatus> = {
      SUCCESS: 'SUCCESS', COMPLETED: 'SUCCESS', PENDING_AUTHORIZATION: 'NEEDS_AUTHORIZATION',
      PENDING: 'SUBMITTED', IN_PROGRESS: 'SUBMITTED', FAILED: 'FAILED', REVERSED: 'REVERSED',
    };
    return { status: map[s] ?? 'SUBMITTED', message };
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    if (req.currency !== 'NGN') throw new Error('Monnify only pays out NGN');
    const r = await this.call<{ status: string; reference: string }>('POST', '/api/v2/disbursements/single', {
      amount: toNaira(req.amountMinor),
      reference: req.reference,
      narration: req.narration.slice(0, 60),
      destinationBankCode: req.bankCode,
      destinationAccountNumber: req.accountNumber,
      destinationAccountName: req.accountName,
      currency: 'NGN',
      sourceAccountNumber: this.o.walletAccountNumber,
    });
    return this.mapPayout(r.status);
  }

  // confirm in sandbox
  async authorizePayout(reference: string, otp: string): Promise<PayoutResult> {
    const r = await this.call<{ status: string }>('POST', '/api/v2/disbursements/single/validate-otp', { reference, authorizationCode: otp });
    return this.mapPayout(r.status);
  }

  // confirm in sandbox
  async checkPayout(reference: string): Promise<PayoutResult> {
    const r = await this.call<{ status: string }>('GET', `/api/v2/disbursements/single/summary?reference=${encodeURIComponent(reference)}`);
    return this.mapPayout(r.status);
  }

  // ---------- wallet ----------
  // confirm in sandbox
  async walletBalance(): Promise<{ availableMinor: number; ledgerMinor: number }> {
    if (!this.o.walletAccountNumber) throw new Error('MONNIFY_WALLET_ACCOUNT is not set');
    const r = await this.call<{ availableBalance: number; ledgerBalance: number }>(
      'GET', `/api/v2/disbursements/wallet-balance?accountNumber=${encodeURIComponent(this.o.walletAccountNumber)}`);
    return { availableMinor: toKobo(r.availableBalance ?? 0), ledgerMinor: toKobo(r.ledgerBalance ?? 0) };
  }

  // ---------- webhooks ----------
  verifySignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.o.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent | null {
    const sigHeader = headers['monnify-signature'];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (sig) {
      if (!this.verifySignature(rawBody, sig)) return null;
    } else if (this.o.requireSignature) {
      return null;
    }
    let body: { eventType?: string; eventData?: Record<string, unknown> };
    try { body = JSON.parse(rawBody); } catch { return null; }
    const d = body.eventData ?? {};
    switch (body.eventType) {
      case 'SUCCESSFUL_TRANSACTION': {
        const ref = String(d.transactionReference ?? '');
        if (!ref) return null;
        return { kind: 'collection', providerReference: ref, paymentReference: (d.paymentReference as string) ?? null, eventKey: `col:${ref}` };
      }
      case 'SUCCESSFUL_DISBURSEMENT':
      case 'FAILED_DISBURSEMENT':
      case 'REVERSED_DISBURSEMENT': {
        const ref = String(d.reference ?? '');
        if (!ref) return null;
        const status: PayoutStatus = body.eventType === 'SUCCESSFUL_DISBURSEMENT' ? 'SUCCESS' : body.eventType === 'FAILED_DISBURSEMENT' ? 'FAILED' : 'REVERSED';
        return { kind: 'payout', reference: ref, status, eventKey: `${body.eventType}:${ref}` };
      }
      default:
        return { kind: 'ignored', eventKey: `${body.eventType ?? 'unknown'}:${String(d.transactionReference ?? d.reference ?? rawBody.length)}` };
    }
  }
}
