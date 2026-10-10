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
