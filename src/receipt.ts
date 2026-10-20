import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';
import { markImage, markKey, refreshMark } from './brand-mark.js';

/**
 * RECEIPTS AS PICTURES. A branded receipt sent into the chat at every point money moves (payment in, payout,
 * refund, delivery fee), so people can keep it or forward it without leaving WhatsApp.
 * Every letter is drawn as a shape from the fonts in assets/fonts, so it looks the same on any server
 * (the server has no fonts of its own).
 */

export const COMPANY = { legalName: 'HOOLAM DIGITAL PLATFORM LTD', rc: '9919417', site: 'hoolam.com' };

const FONTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
type Font = opentype.Font;
let fonts: { regular: Font; semi: Font; bold: Font; brand: Font } | null = null;
function loadFonts() {
  fonts ??= {
    regular: opentype.loadSync(join(FONTS, 'Inter-Regular.otf')),
    semi: opentype.loadSync(join(FONTS, 'Inter-SemiBold.otf')),
    bold: opentype.loadSync(join(FONTS, 'Inter-Bold.otf')),
    brand: opentype.loadSync(join(FONTS, 'Poppins-Bold.ttf')),
  };
  return fonts;
}

const C = { teal: '#0E5C63', tealDark: '#083E43', gold: '#C9992E', goldBg: '#FBF5E6', green: '#2E8B57', greenBg: '#EAF5EE', ink: '#17292B', muted: '#5D6B6C', line: '#E6E8E3', bg: '#FAFAF7', white: '#FFFFFF' };

export type ReceiptTone = 'green' | 'teal' | 'gold';
export interface ReceiptData {
  title: string;                      // "Payment received"
  amount: string;                     // "₦15,300"
  status: string;                     // "Held safely by Hoolam until you're happy"
  tone?: ReceiptTone;                 // the status chip colour (green = money moved, teal = held)
  intro?: string;                     // a line above the rows, e.g. "Ada paid for your order"
  rows: { label: string; value: string; strong?: boolean }[];
  details: { label: string; value: string }[]; // order, item, people, date, reference
  note?: string;                      // the gold box (the seller's trust line)
}

const W = 1080, PAD = 72, IN = W - PAD * 2;

function width(f: Font, text: string, size: number) { return f.getAdvanceWidth(text, size); }
function path(f: Font, text: string, x: number, y: number, size: number, fill: string, align: 'left' | 'right' | 'center' = 'left') {
  const w = width(f, text, size);
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  return `<path d="${f.getPath(text, left, y, size).toPathData(2)}" fill="${fill}"/>`;
}
/** Breaks text into lines no wider than `max`. */
function wrap(f: Font, text: string, size: number, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (width(f, next, size) <= max || !line) line = next;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}
/** Shortens a value to fit (with …). */
function fit(f: Font, text: string, size: number, max: number): string {
  if (width(f, text, size) <= max) return text;
  let t = text;
  while (t.length > 1 && width(f, t + '…', size) > max) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

/** The receipt as a JPEG (about 1080 wide). `scale` < 1 makes a lighter copy (for the My orders form). */
export async function renderReceipt(d: ReceiptData, scale = 1): Promise<Buffer> {
  const f = loadFonts();
  const parts: string[] = [];
  let y = 0;

  // header band: the mark and the wordmark, "Receipt" on the right
  const headH = 150;
  parts.push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.teal}"/>`);
  await refreshMark(); // the uploaded logo icon, else the drawn mark
  parts.push(markImage(PAD, 39, 72) ?? `<g transform="translate(${PAD} 39) scale(1.125)"><rect width="64" height="64" rx="18" fill="${C.tealDark}"/><g transform="translate(12 12) scale(1.6667)"><circle cx="12" cy="8.5" r="3.7" fill="${C.gold}"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g></g>`);
  parts.push(path(f.brand, 'Hoolam', PAD + 90, 100, 50, C.white));
  parts.push(path(f.semi, 'Receipt', W - PAD, 92, 28, '#CFE3E4', 'right'));
  y = headH + 70;

  // title and the amount
  parts.push(path(f.semi, d.title, PAD, y, 40, C.ink));
  y += 108;
  parts.push(path(f.bold, d.amount, PAD, y, 104, C.teal));
  y += 40;

  // status chip (a tick, then the words)
  const tone = d.tone ?? 'green';
  const chipFg = tone === 'green' ? C.green : tone === 'gold' ? '#7A5A10' : C.teal;
  const chipBg = tone === 'green' ? C.greenBg : tone === 'gold' ? C.goldBg : '#E3F0F0';
  const statusLines = wrap(f.semi, d.status, 28, IN - 110);
  const chipH = 30 + statusLines.length * 38;
  parts.push(`<rect x="${PAD}" y="${y}" width="${IN}" height="${chipH}" rx="22" fill="${chipBg}"/>`);
  parts.push(`<circle cx="${PAD + 44}" cy="${y + chipH / 2}" r="20" fill="${chipFg}"/><path d="M${PAD + 34} ${y + chipH / 2}l7 7 13-14" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`);
  statusLines.forEach((l, i) => parts.push(path(f.semi, l, PAD + 84, y + chipH / 2 + 10 - ((statusLines.length - 1) * 38) / 2 + i * 38, 28, chipFg)));
  y += chipH + 56;

  if (d.intro) {
    for (const l of wrap(f.regular, d.intro, 30, IN)) { parts.push(path(f.regular, l, PAD, y, 30, C.ink)); y += 42; }
    y += 14;
  }

  // the money, line by line
  parts.push(`<rect x="${PAD}" y="${y - 30}" width="${IN}" height="2" fill="${C.line}"/>`);
  y += 26;
  for (const r of d.rows) {
    const lf = r.strong ? f.bold : f.regular, vf = r.strong ? f.bold : f.semi;
    const size = r.strong ? 34 : 30;
    parts.push(path(lf, fit(lf, r.label, size, IN * 0.58), PAD, y, size, r.strong ? C.ink : C.muted));
    parts.push(path(vf, fit(vf, r.value, size, IN * 0.4), W - PAD, y, size, r.strong ? C.teal : C.ink, 'right'));
    y += r.strong ? 62 : 54;
  }
  parts.push(`<rect x="${PAD}" y="${y - 22}" width="${IN}" height="2" fill="${C.line}"/>`);
  y += 40;

  // the details (who, what, when, reference)
  for (const dt of d.details) {
    parts.push(path(f.regular, dt.label, PAD, y, 26, C.muted));
    const all = wrap(f.semi, dt.value, 28, IN - 250);
    const lines = all.slice(0, 2);
    if (all.length > 2) lines[1] = fit(f.semi, `${lines[1]} ${all[2]}`, 28, IN - 250);
    lines.forEach((l, i) => parts.push(path(f.semi, l, PAD + 250, y + i * 38, 28, C.ink)));
    y += 24 + lines.length * 38;
  }

  // the gold box: the seller's trust line
  if (d.note) {
    y += 10;
    const lines = wrap(f.semi, d.note, 28, IN - 64);
    const h = 40 + lines.length * 40;
    parts.push(`<rect x="${PAD}" y="${y}" width="${IN}" height="${h}" rx="20" fill="${C.goldBg}" stroke="#EBD9A8" stroke-width="2"/>`);
    lines.forEach((l, i) => parts.push(path(f.semi, l, PAD + 32, y + 50 + i * 40, 28, '#6B4F0E')));
    y += h + 30;
  }

  // footer
  y += 30;
  parts.push(`<rect x="0" y="${y}" width="${W}" height="2" fill="${C.line}"/>`);
  y += 62;
  parts.push(path(f.semi, `${COMPANY.legalName} · RC ${COMPANY.rc}`, W / 2, y, 24, C.muted, 'center'));
  y += 40;
  parts.push(path(f.regular, `${COMPANY.site} · Pay safe. Ship safe.`, W / 2, y, 24, C.muted, 'center'));
  y += 56;

  const H = Math.ceil(y);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.white}"/>${parts.join('')}</svg>`;
  let img = sharp(Buffer.from(svg), { density: 72 });
  if (scale !== 1) img = img.resize(Math.round(W * scale));
  return img.jpeg({ quality: scale < 1 ? 72 : 88, mozjpeg: true }).toBuffer();
}


let brandCard: { key: string; bytes: Buffer } | null = null;
/**
 * The picture at the top of an order alert when the item has no photo (WhatsApp needs one there): the Hoolam
 * logo icon and name on teal. Also the sample sent to Meta when the alert is submitted.
 */
export async function renderBrandCard(): Promise<Buffer> {
  await refreshMark();
  if (brandCard && brandCard.key === markKey()) return brandCard.bytes;
  const f = loadFonts();
  const W2 = 1200, H2 = 628;
  const name = 'Hoolam', size = 120;
  const nameW = width(f.brand, name, size);
  const markS = 132, gap = 34;
  const total = markS + gap + nameW;
  const x0 = (W2 - total) / 2, cy = H2 / 2 - 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}"><rect width="${W2}" height="${H2}" fill="${C.teal}"/>` +
    `<circle cx="${W2 - 120}" cy="80" r="260" fill="${C.tealDark}" opacity=".35"/>` +
    (markImage(x0, cy - markS / 2, markS) ?? `<g transform="translate(${x0} ${cy - markS / 2}) scale(${markS / 64})"><rect width="64" height="64" rx="18" fill="${C.tealDark}"/><g transform="translate(12 12) scale(1.6667)"><circle cx="12" cy="8.5" r="3.7" fill="${C.gold}"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g></g>`) +
    path(f.brand, name, x0 + markS + gap, cy + 42, size, C.white) +
    path(f.semi, 'Pay safe. Ship safe.', W2 / 2, cy + 170, 40, '#CFE3E4', 'center') +
    '</svg>';
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  brandCard = { key: markKey(), bytes };
  return bytes;
}
