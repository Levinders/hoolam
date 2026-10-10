import type { Bank } from '../payments/provider.js';

/** "0123456789 GTBank", "GTBank 0123456789", "0123456789 - opay" */
export function parseBankInput(text: string): { accountNumber: string; bankText: string } | null {
  const num = text.match(/\b(\d{10})\b/);
  if (!num) return null;
  const bankText = text.replace(num[1]!, ' ').replace(/[^a-zA-Z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!bankText) return null;
  return { accountNumber: num[1]!, bankText };
}

const ALIASES: Record<string, string[]> = {
  gtb: ['guaranty', 'gtbank'], gtbank: ['guaranty', 'gtbank'], gtco: ['guaranty', 'gtbank'], guaranty: ['guaranty'],
  opay: ['opay', 'paycom'], paycom: ['paycom', 'opay'], palmpay: ['palmpay'], moniepoint: ['moniepoint'], kuda: ['kuda'],
  uba: ['united bank for africa', 'uba'], firstbank: ['first bank'], fbn: ['first bank'], first: ['first bank'],
  zenith: ['zenith'], access: ['access'], diamond: ['access'], wema: ['wema'], alat: ['wema'], fcmb: ['first city', 'fcmb'],
  fidelity: ['fidelity'], sterling: ['sterling'], stanbic: ['stanbic'], union: ['union bank'], polaris: ['polaris'],
  keystone: ['keystone'], ecobank: ['ecobank'], providus: ['providus'], jaiz: ['jaiz'], unity: ['unity'], heritage: ['heritage'],
  globus: ['globus'], titan: ['titan'], taj: ['taj'], vfd: ['vfd'], carbon: ['carbon'], fairmoney: ['fairmoney'],
};

/** Finds the bank someone means from how they typed it. */
export function matchBank(input: string, banks: Bank[]): Bank | null {
  const clean = (s: string) => s.toLowerCase().replace(/\b(bank|plc|mfb|microfinance|limited|ltd|nigeria|of)\b/g, ' ').replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = clean(input);
  if (!q) return null;
  const key = q.replace(/\s/g, '');
  const targets = ALIASES[key] ?? ALIASES[q.split(' ')[0]!] ?? [q];
  const hits = banks.filter((b) => {
    const n = b.name.toLowerCase();
    return targets.some((t) => n.includes(t)) || clean(b.name) === q;
  });
  if (!hits.length) return null;
  // Prefer the shortest name ("Kuda" over "Kuda Microfinance Bank Ltd Lagos branch").
  return hits.sort((a, b) => a.name.length - b.name.length)[0]!;
}

/**
 * NUBAN check: could this 10-digit account number belong to this bank? Nigerian account numbers end in a
 * check digit worked out from the bank's code and the first 9 digits, so most banks can be ruled out.
 * 3-digit codes (commercial banks) become 000xxx, 5-digit ones 9xxxxx; 6-digit codes are used as they are.
 * Returns null when the code isn't one the check works with (then we don't rule the bank out).
 */
export function nubanFits(bankCode: string, accountNumber: string): boolean | null {
  if (!/^\d{10}$/.test(accountNumber)) return false;
  const code = /^\d{3}$/.test(bankCode) ? '000' + bankCode : /^\d{5}$/.test(bankCode) ? '9' + bankCode : /^\d{6}$/.test(bankCode) ? bankCode : null;
  if (!code) return null;
  const digits = (code + accountNumber.slice(0, 9)).split('').map(Number);
  const weights = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];
  const sum = digits.reduce((a, d, i) => a + d * weights[i]!, 0);
  return (10 - (sum % 10)) % 10 === Number(accountNumber[9]);
}

/** The banks and fintechs people use most, in the order we list them. */
const POPULAR = ['opay', 'moniepoint', 'palmpay', 'kuda', 'gtbank', 'access', 'zenith', 'firstbank', 'uba', 'wema', 'fcmb', 'fidelity', 'sterling', 'union', 'stanbic', 'ecobank', 'polaris', 'keystone', 'providus'];
/** Fintechs whose account numbers don't always pass the NUBAN check under the codes payment providers list: always offered. */
const ALWAYS = new Set(['opay', 'moniepoint', 'palmpay', 'kuda']);

/**
 * The banks to offer for an account number, most likely first: the big fintechs always, then the popular banks
 * the number fits, then every other bank it fits (by name). At most `max` (WhatsApp dropdowns allow 200).
 */
export function bankChoices(accountNumber: string, banks: Bank[], max = 200): Bank[] {
  const out: Bank[] = [];
  const seen = new Set<string>();
  const add = (b: Bank | null) => { if (b && !seen.has(b.code) && out.length < max) { seen.add(b.code); out.push(b); } };
  for (const key of POPULAR) {
    const b = matchBank(key, banks);
    if (!b) continue;
    if (ALWAYS.has(key) || nubanFits(b.code, accountNumber) !== false) add(b);
  }
  const rest = banks.filter((b) => !seen.has(b.code) && nubanFits(b.code, accountNumber) !== false).sort((a, b) => a.name.localeCompare(b.name));
  for (const b of rest) add(b);
  return out;
}
