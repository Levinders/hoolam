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
