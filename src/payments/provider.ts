import type { Currency } from '../money.js';

/**
 * Everything Hoolam needs from a payment partner. The rest of the code only talks to this,
 * so moving from Monnify to Kuda, Safe Haven, or a Benin mobile money provider means writing
 * one new file, not changing the deal logic.
 */

export interface CollectionRequest {
  paymentReference: string;    // our unique reference
  amountMinor: number;
  currency: Currency;
  description: string;
  customerName: string;
  customerEmail: string;       // providers often require one; we use a placeholder per user
}

export interface CollectionInstructions {
  providerReference: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  expiresAt: Date | null;
}

export type PaymentStatus = 'PENDING' | 'PAID' | 'PARTIAL' | 'OVERPAID' | 'EXPIRED' | 'FAILED';

export interface PaymentCheck {
  status: PaymentStatus;
  amountPaidMinor: number;
  providerReference: string;
  paymentReference: string | null;
}

export interface Bank { code: string; name: string }

export interface PayoutRequest {
  reference: string;
  amountMinor: number;
  currency: Currency;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration: string;
}

export type PayoutStatus = 'SUBMITTED' | 'NEEDS_AUTHORIZATION' | 'SUCCESS' | 'FAILED' | 'REVERSED';

export interface PayoutResult { status: PayoutStatus; message?: string }

/** A normalised webhook event from the provider. Always re-checked with the API before money moves. */
export type ProviderEvent =
  | { kind: 'collection'; providerReference: string; paymentReference: string | null; eventKey: string }
  | { kind: 'payout'; reference: string; status: PayoutStatus; eventKey: string }
  | { kind: 'ignored'; eventKey: string };

export interface PaymentProvider {
  readonly name: string;
  /** True when no real money moves (pretend money, or a provider's test environment). */
  readonly sandbox: boolean;
  createCollection(req: CollectionRequest): Promise<CollectionInstructions>;
  /** Ask the provider directly. Never trust a webhook on its own. */
  checkCollection(providerReference: string): Promise<PaymentCheck>;
  listBanks(): Promise<Bank[]>;
  /** Returns the official account name for this number at this bank, or null. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<string | null>;
  sendPayout(req: PayoutRequest): Promise<PayoutResult>;
  authorizePayout(reference: string, otp: string): Promise<PayoutResult>;
  checkPayout(reference: string): Promise<PayoutResult>;
  /** Verify a raw webhook body + headers. Returns null if it is not genuine. */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent | null;
  /** Money available in the wallet payouts are sent from (minor units). Optional: not every provider has one. */
  walletBalance?(): Promise<{ availableMinor: number; ledgerMinor: number }>;
}
