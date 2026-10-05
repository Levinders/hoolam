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

export interface Quote {
  priceMinor: number;
  feeMinor: number;
  buyerPaysMinor: number;
  sellerGetsMinor: number;
  note: 'minimum' | 'cap' | null;
}

const MINOR: Record<Currency, number> = { NGN: 100, XOF: 1 };

/**
 * Who pays the fee. Hoolam's rule: whoever starts the deal pays it.
 * Leave it out to use the rules' own buyerShare (the landing page calculator does that).
 */
export type FeePayer = 'buyer' | 'seller';

export function quote(priceMinor: number, currency: Currency, rules: PricingRules = PRICING[currency], payer?: FeePayer): Quote {
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
  return {
    priceMinor,
    feeMinor: Math.round(fee * unit),
    buyerPaysMinor: Math.round((price + buyerPart) * unit),
    sellerGetsMinor: Math.round((price - sellerPart) * unit),
    note,
  };
}
