import type { Currency } from './money.js';

/**
 * Same rules as the landing page calculator. Keep the two in sync.
 * Values are in MAJOR units (naira / CFA) for readability.
 */
export interface PricingRules {
  ratePercent: number;   // % of the item price, all-in
  min: number;           // smallest fee
  max: number;           // biggest fee
  roundTo: number;       // fees rounded to the nearest roundTo
  buyerShare: number;    // 1 = buyer pays the fee, 0 = seller pays, 0.5 = split
}

// PLACEHOLDER numbers. Set the real ones once fee policy is decided.
export const PRICING: Record<Currency, PricingRules> = {
  NGN: { ratePercent: 2.5, min: 300, max: 5_000, roundTo: 100, buyerShare: 1 },
  XOF: { ratePercent: 2.5, min: 200, max: 5_000, roundTo: 100, buyerShare: 1 },
};

/**
 * Who pays the fee. Hoolam's rule: whoever starts the deal pays it.
 * Leave it out to use the rules' own buyerShare (the landing page calculator does that).
 */
export type FeePayer = 'buyer' | 'seller';

/**
 * TRANSACTION FEE: a flat fee by order size, paid by the side that did NOT start the order
 * (buyer starts: the buyer pays Hoolam's fee and the seller's transaction fee comes out of their payout;
 * seller starts: the seller pays Hoolam's fee and the buyer pays a transaction fee on top).
 * Bands in MAJOR units: `upTo` is the largest total in the band (null = everything above).
 */
export interface FeeBand { upTo: number | null; fee: number }
export interface TxnFees { seller: FeeBand[]; buyer: FeeBand[] }

export const DEFAULT_TXN_BANDS: FeeBand[] = [
  { upTo: 100_000, fee: 500 }, { upTo: 200_000, fee: 1_000 }, { upTo: 300_000, fee: 1_500 }, { upTo: 400_000, fee: 2_000 }, { upTo: null, fee: 2_500 },
];

/** The band fee for a total (major units). */
export function bandFee(bands: FeeBand[], price: number): number {
  for (const b of bands) if (b.upTo == null || price <= b.upTo) return b.fee;
  return bands.at(-1)?.fee ?? 0;
}

/** Checks a band table from the console. Returns an error, or null. */
export function checkBands(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10) return 'Add between 1 and 10 bands.';
  let last = 0;
  for (let i = 0; i < v.length; i++) {
    const b = v[i] as FeeBand;
    if (typeof b !== 'object' || b == null || typeof b.fee !== 'number' || !Number.isFinite(b.fee) || b.fee < 0 || b.fee > 1_000_000) return `Band ${i + 1}: the fee must be a number from 0.`;
    const isLast = i === v.length - 1;
    if (isLast ? b.upTo != null : typeof b.upTo !== 'number' || !Number.isFinite(b.upTo)) return isLast ? 'The last band covers everything above, so it has no "up to".' : `Band ${i + 1}: add the "up to" amount.`;
    if (!isLast && (b.upTo as number) <= last) return `Band ${i + 1}: "up to" must be bigger than the band before it.`;
    if (!isLast) last = b.upTo as number;
  }
  return null;
}

export interface Quote {
  priceMinor: number;
  feeMinor: number;            // Hoolam's fee (the % fee), paid by whoever started the order
  txnFeeMinor: number;         // the flat transaction fee, paid by the other side
  txnPayer: FeePayer | null;   // who pays the transaction fee
  buyerPaysMinor: number;
  sellerGetsMinor: number;
  note: 'minimum' | 'cap' | null;
}

const MINOR: Record<Currency, number> = { NGN: 100, XOF: 1 };


export function quote(priceMinor: number, currency: Currency, rules: PricingRules = PRICING[currency], payer?: FeePayer, txn?: TxnFees): Quote {
  if (payer) rules = { ...rules, buyerShare: payer === 'buyer' ? 1 : 0 };
  if (!Number.isInteger(priceMinor) || priceMinor <= 0) throw new Error('price must be a positive integer (minor units)');
  const unit = MINOR[currency];
  const price = priceMinor / unit;
  const raw = (price * rules.ratePercent) / 100;
  let fee = raw;
  let note: Quote['note'] = null;
  if (raw < rules.min) { fee = rules.min; note = 'minimum'; }
  else if (raw > rules.max) { fee = rules.max; note = 'cap'; }
  const r = rules.roundTo || 1;
  fee = Math.round(fee / r) * r;
  const buyerPart = Math.min(fee, Math.round((fee * rules.buyerShare) / r) * r);
  const sellerPart = fee - buyerPart;
  // the transaction fee: only when we know who started the order (the website calculator leaves it out)
  const txnPayer: FeePayer | null = payer && txn ? (payer === 'buyer' ? 'seller' : 'buyer') : null;
  let txnFee = txnPayer ? bandFee(txnPayer === 'seller' ? txn!.seller : txn!.buyer, price) : 0;
  if (txnPayer === 'seller') txnFee = Math.max(0, Math.min(txnFee, price - sellerPart - 1)); // the seller always gets something
  return {
    priceMinor,
    feeMinor: Math.round(fee * unit),
    txnFeeMinor: Math.round(txnFee * unit),
    txnPayer: txnFee > 0 ? txnPayer : null,
    buyerPaysMinor: Math.round((price + buyerPart + (txnPayer === 'buyer' ? txnFee : 0)) * unit),
    sellerGetsMinor: Math.round((price - sellerPart - (txnPayer === 'seller' ? txnFee : 0)) * unit),
    note,
  };
}
