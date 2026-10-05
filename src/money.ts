// All amounts are integers in the smallest unit (kobo for NGN, francs for XOF).

export type Currency = 'NGN' | 'XOF';

const MINOR_PER_MAJOR: Record<Currency, number> = { NGN: 100, XOF: 1 };

export function toMinor(major: number, currency: Currency): number {
  return Math.round(major * MINOR_PER_MAJOR[currency]);
}

export function toMajor(minor: number, currency: Currency): number {
  return minor / MINOR_PER_MAJOR[currency];
}

/** ₦10,300 or 10 300 CFA. Kobo are shown only when present. */
export function formatMoney(minor: number, currency: Currency): string {
  const major = toMajor(minor, currency);
  if (currency === 'NGN') {
    const hasKobo = minor % 100 !== 0;
    return '₦' + major.toLocaleString('en-NG', { minimumFractionDigits: hasKobo ? 2 : 0, maximumFractionDigits: 2 });
  }
  return String(Math.round(major)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' CFA';
}

/**
 * Reads what people type: "15000", "15,000", "15k", "₦15 000", "N15000", "1.5m".
 * Returns whole major units, or null if it isn't a usable price.
 */
export function parseAmount(text: string): number | null {
  const t = text.toLowerCase().replace(/naira|ngn|fcfa|cfa|[₦n]/g, '').replace(/[\s,]/g, '').trim();
  const m = t.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m || !m[1]) return null;
  let v = parseFloat(m[1]);
  if (m[2] === 'k') v *= 1_000;
  if (m[2] === 'm') v *= 1_000_000;
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}
