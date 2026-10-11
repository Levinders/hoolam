/**
 * Phone numbers as Nigerians write them: 07034577787. The country code stays behind the scenes
 * (WhatsApp and payouts need +234…); people never have to see or type it.
 */
export function localPhone(p: string | null | undefined): string {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (/^234\d{10}$/.test(d)) return '0' + d.slice(3);
  if (/^0\d{10}$/.test(d)) return d;
  return String(p);
}

/** Today in Lagos as YYYY-MM-DD, plus `days`. */
export function lagosDate(days = 0, now = new Date()): string {
  const d = new Date(now.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/**
 * A date the way people type it: "tomorrow", "25 Oct", "Oct 25", "25 October", "25/10", "25/10/2026", "25-10-26".
 * Returns YYYY-MM-DD (this year, or next year if that day has passed), or null if it's not a date or it's in the past.
 */
export function parseDay(text: string, now = new Date()): string | null {
  const t = text.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ');
  const today = lagosDate(0, now);
  if (/^today$/.test(t)) return today;
  if (/^(tomorrow|tmrw|tmr)$/.test(t)) return lagosDate(1, now);
  let day: number | null = null, month: number | null = null, year: number | null = null;
  let m = t.match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?$/);
  if (m) { day = +m[1]!; month = +m[2]!; year = m[3] ? +m[3] : null; }
  if (day === null) {
    const a = t.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{2,4}))?$/) ?? null;
    const b = a ? null : t.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?$/);
    const name = a ? a[2]! : b ? b[1]! : '';
    const mi = MONTHS.findIndex((x) => name.startsWith(x));
    if (mi >= 0) { day = +(a ? a[1]! : b![2]!); month = mi + 1; const y = a ? a[3] : b![3]; year = y ? +y : null; }
  }
  if (day === null || month === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const [ty] = today.split('-').map(Number) as [number];
  if (year !== null && year < 100) year += 2000;
  const fmt = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let out = fmt(year ?? ty);
  const check = new Date(`${out}T12:00:00Z`);
  if (check.getUTCDate() !== day) return null; // 31 Feb and friends
  if (out < today) { if (year !== null) return null; out = fmt(ty + 1); }
  return out;
}
