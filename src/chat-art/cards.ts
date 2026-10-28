import type { OverlayOptions } from 'sharp';
import { blobs, brand, C, clip, compose, confetti, fit, icon, iconDisc, mark, photoLayer, pill, text, width, wrap } from './kit.js';

/**
 * Every picture Hoolam sends in the chat. Two kinds:
 *  - live cards, drawn fresh for each order with its real amounts and names (money held, paid, the handover code…);
 *  - fixed pictures, drawn once (how it works, the ID check, the status strip…).
 * Each one has one job and one big thing to read (the amount, the code, the step). The owner can replace any of them
 * in Console → Settings → WhatsApp; for a live card they upload a background and the words are drawn on top.
 */

const SQ = 1080; // square cards
const WIDE = { w: 1600, h: 900 }; // pictures on top of a message with buttons

type Bg = Buffer | null | undefined;

// ---------------------------------------------------------------------------------------------
// shared pieces

/** Brand at the top left, an order code chip at the top right. */
function head(w: number, color: string, tile: string | null, chip?: string, chipBg = 'rgba(255,255,255,.14)', chipFg = '#fff'): string {
  let s = brand(72, 128, 70, color, tile);
  if (chip) {
    const size = 30, pw = width(chip, size, 'semi') + 56;
    s += `<rect x="${w - 72 - pw}" y="76" width="${pw}" height="66" rx="33" fill="${chipBg}"/>` + text(chip, w - 72 - pw / 2, 120, size, chipFg, { font: 'semi', align: 'center' });
  }
  return s;
}
function foot(w: number, h: number, s: string, color: string, opacity = 0.75): string {
  return text(s, w / 2, h - 58, 28, color, { align: 'center', opacity });
}

/** The 6 steps of an order, as one strip. `step`: the one happening now (1–6). */
export const STEPS = ['Sent', 'Waiting for payment', 'Money held', 'On the way', 'Check it', 'Paid out'] as const;
const STEP_SHORT = ['Sent', 'Payment', 'Held', 'On the way', 'Check it', 'Paid out'];
function strip(x: number, y: number, w: number, step: number, o: { on: string; done: string; idle: string; label: string; labelOn: string; size?: number }): string {
  const n = STEPS.length, gap = w / (n - 1), r = o.size ?? 26;
  let s = `<rect x="${x}" y="${y - 4}" width="${w}" height="8" rx="4" fill="${o.idle}"/>`;
  if (step > 1) s += `<rect x="${x}" y="${y - 4}" width="${gap * (Math.min(step, n) - 1)}" height="8" rx="4" fill="${o.done}"/>`;
  for (let i = 0; i < n; i++) {
    const cx = x + gap * i, k = i + 1;
    if (k < step) s += `<circle cx="${cx}" cy="${y}" r="${r}" fill="${o.done}"/>` + icon('check', cx - r * 0.6, y - r * 0.6, r * 1.2, '#fff', 3);
    else if (k === step) s += `<circle cx="${cx}" cy="${y}" r="${r + 10}" fill="${o.on}" opacity=".25"/><circle cx="${cx}" cy="${y}" r="${r}" fill="${o.on}"/>` + text(String(k), cx, y + r * 0.42, r * 1.1, '#fff', { font: 'bold', align: 'center' });
    else s += `<circle cx="${cx}" cy="${y}" r="${r}" fill="${o.idle}"/>` + text(String(k), cx, y + r * 0.42, r * 1.0, o.label, { font: 'semi', align: 'center', opacity: 0.8 });
    s += text(STEP_SHORT[i]!, cx, y + r + 52, 26, k === step ? o.labelOn : o.label, { font: k === step ? 'bold' : 'semi', align: 'center', opacity: k > step ? 0.75 : 1 });
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// live cards

export interface MoneyHeld { side: 'buyer' | 'seller'; amount: string; code: string; other?: string | null; item?: string | null; bank?: string | null; step?: number }
/** The first peak: the money is with Hoolam. Teal, a gold shield, the amount huge. */
export async function moneyHeld(d: MoneyHeld, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55);
  let s = head(w, '#fff', null, `Order ${d.code}`);
  // the shield badge
  s += `<circle cx="${w / 2}" cy="305" r="112" fill="${C.gold}" opacity=".18"/><circle cx="${w / 2}" cy="305" r="84" fill="${C.gold}"/>` + icon('shieldCheck', w / 2 - 46, 259, 92, C.tealDeep, 2.2);
  const title = d.side === 'buyer' ? 'Your money is safe' : 'Paid and held';
  s += text(title, w / 2, 488, 46, C.goldSoft, { font: 'semi', align: 'center' });
  const as = fit(d.amount, 150, w - 160, 'brand');
  s += text(d.amount, w / 2, 640, as, '#fff', { font: 'brand', align: 'center' });
  const lines = d.side === 'buyer'
    ? ['Held by Hoolam until you\'re happy', d.other ? `${d.other} is sending your item` : 'The seller is sending your item']
    : [d.other ? `Yours once ${d.other} is happy` : 'Yours once your buyer is happy', 'Confirmed by Hoolam, not a bank alert'];
  lines.forEach((l, i) => { s += text(clip(l, 38, w - 200), w / 2, 720 + i * 52, 38, i ? C.tealSoft : '#fff', { align: 'center', opacity: i ? 0.85 : 0.95 }); });
  const p = pill(d.side === 'buyer' ? 'Released only when you say so' : 'Send the item now', w / 2, 846, 32, C.gold, C.tealDeep, { font: 'bold', iconName: d.side === 'buyer' ? 'check' : 'package' });
  s += p.svg;
  s += foot(w, h, d.bank ? `Held with ${d.bank}` : 'Held with a CBN-licensed bank', C.tealSoft);
  return compose({ w, h, bg }, drawn, s);
}

export interface Paid { state: 'paid' | 'ready' | 'ambassador'; amount: string; bank?: string | null; code?: string | null; other?: string | null; month?: string | null }
/** The second peak: the seller (or an ambassador) is paid. Green with confetti; "ready" is calm teal. */
export async function paid(d: Paid, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const ready = d.state === 'ready';
  const base = ready ? C.teal : C.green, deep = ready ? C.tealDark : C.greenDark;
  const drawn = `<rect width="${w}" height="${h}" fill="${base}"/>` + blobs(w, h, deep, 0.5) + (ready ? '' : confetti(w, h, d.amount + (d.code ?? d.month ?? ''), [C.gold, '#fff', C.goldSoft, C.greenSoft], 60, { top: 170, bottom: 600 }, { x1: 280, x2: 800, y1: 200, y2: 600 }));
  let s = head(w, '#fff', null, d.code ? `Order ${d.code}` : d.month ?? undefined);
  s += `<circle cx="${w / 2}" cy="330" r="104" fill="#fff"/>` + icon(ready ? 'clock' : 'check', w / 2 - 54, 276, 108, base, ready ? 2.2 : 3);
  const title = ready ? 'Ready for you' : d.state === 'ambassador' ? `Your ${d.month ?? 'monthly'} earnings` : 'Paid!';
  s += text(title, w / 2, 520, 56, '#fff', { font: 'brand', align: 'center' });
  const as = fit(d.amount, 140, w - 160, 'brand');
  s += text(d.amount, w / 2, 668, as, '#fff', { font: 'brand', align: 'center' });
  const line = ready ? 'Check your ID once, and it goes straight to your account'
    : d.bank ? `Sent to ${d.bank}` : 'Sent to your bank account';
  wrap(line, 38, w - 220, 'regular', 2).forEach((l, i) => { s += text(l, w / 2, 748 + i * 52, 38, '#fff', { align: 'center', opacity: 0.9 }); });
  if (!ready) s += pill(d.state === 'ambassador' ? 'Thank you for growing Hoolam' : 'Thank you for selling safely', w / 2, 852, 30, '#fff', deep, { font: 'bold' }).svg;
  s += foot(w, h, 'hoolam.com', '#fff', 0.7);
  return compose({ w, h, bg }, drawn, s);
}

export interface Refund { amount: string; bank?: string | null; code: string }
/** Money back to the buyer: calm, no confetti. */
export async function refund(d: Refund, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.mint}"/>` + blobs(w, h, '#fff', 0.6);
  let s = head(w, C.teal, C.teal, `Order ${d.code}`, C.teal, '#fff');
  s += iconDisc('undo', w / 2, 330, 104, C.teal, '#fff', 0.5, 2.2);
  s += text('Your money is back', w / 2, 520, 56, C.teal, { font: 'brand', align: 'center' });
  s += text(d.amount, w / 2, 668, fit(d.amount, 140, w - 160, 'brand'), C.ink, { font: 'brand', align: 'center' });
  s += text(d.bank ? `Sent to ${d.bank}` : 'Sent to your bank account', w / 2, 748, 38, C.soft, { align: 'center' });
  s += text('Sorry this one didn\'t work out.', w / 2, 860, 34, C.teal, { font: 'semi', align: 'center' });
  s += foot(w, h, 'hoolam.com', C.soft);
  return compose({ w, h, bg }, drawn, s);
}

export interface Payment { amount: string; accountNumber: string; bankName: string; accountName: string; validUntil?: string | null; code: string }
/** How to pay: the amount, the account in big, clear digits, and why it says Hoolam (not the seller). */
export async function payment(d: Payment, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = head(w, C.teal, C.teal, `Order ${d.code}`, C.mint, C.teal);
  s += text('Transfer exactly', 72, 262, 38, C.soft);
  s += text(d.amount, 72, 380, fit(d.amount, 120, w - 144, 'brand'), C.teal, { font: 'brand' });
  // the account box
  s += `<rect x="60" y="430" width="${w - 120}" height="330" rx="36" fill="#fff" stroke="${C.line}" stroke-width="3"/>`;
  s += text('Account number', 108, 500, 30, C.soft);
  const digits = d.accountNumber.replace(/\s+/g, '');
  const grouped = digits.length === 10 ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : digits;
  s += text(grouped, 108, 600, fit(grouped, 92, w - 260, 'bold'), C.ink, { font: 'bold', spacing: 4 });
  s += `<line x1="108" y1="640" x2="${w - 108}" y2="640" stroke="${C.line}" stroke-width="3"/>`;
  s += icon('landmark', 108, 668, 40, C.teal) + text(clip(d.bankName, 34, w - 300, 'semi'), 164, 700, 34, C.ink, { font: 'semi' });
  s += text(clip(d.accountName, 30, w - 300), 164, 742, 30, C.soft);
  // the reassurance
  s += `<rect x="60" y="790" width="${w - 120}" height="${d.validUntil ? 150 : 120}" rx="28" fill="${C.goldBg}"/>`;
  s += icon('shieldCheck', 96, 818, 52, C.gold, 2.2);
  wrap('This account is for this order only. Your money goes to Hoolam, not the seller.', 30, w - 300, 'semi', 2)
    .forEach((l, i) => { s += text(l, 170, 846 + i * 40, 30, C.goldInk, { font: 'semi' }); });
  if (d.validUntil) s += icon('clock', 170, 902, 30, C.goldInk) + text(`Works until ${d.validUntil}`, 212, 926, 28, C.goldInk);
  s += foot(w, h, 'Pay from any bank app, Opay, Moniepoint or PalmPay', C.soft, 0.9);
  return compose({ w, h, bg }, drawn, s);
}

export interface Handover { digits: string; code: string; to: 'rider' | 'driver' | 'seller' }
/** The handover code: the 4 digits huge, and the rule as a picture: item in hand first, code second. */
export async function handover(d: Handover, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = head(w, C.teal, C.teal, `Order ${d.code}`, C.mint, C.teal);
  s += text('Your handover code', w / 2, 270, 44, C.soft, { font: 'semi', align: 'center' });
  const ds = d.digits.split('').slice(0, 6);
  const bw = 170, gap = 28, total = ds.length * bw + (ds.length - 1) * gap;
  ds.forEach((ch, i) => {
    const x = w / 2 - total / 2 + i * (bw + gap);
    s += `<rect x="${x}" y="310" width="${bw}" height="210" rx="32" fill="${C.teal}"/>` + text(ch, x + bw / 2, 465, 140, '#fff', { font: 'brand', align: 'center' });
  });
  // the rule
  const y = 690;
  s += iconDisc('package', 250, y, 78, C.mint, C.teal, 0.52, 2) + text('Item in', 250, y + 132, 32, C.ink, { font: 'semi', align: 'center' }) + text('your hands', 250, y + 172, 32, C.ink, { font: 'semi', align: 'center' });
  s += icon('arrowRight', w / 2 - 44, y - 44, 88, C.gold, 2.6);
  s += iconDisc('key', w - 250, y, 78, C.gold, '#fff', 0.52, 2) + text('Then give', w - 250, y + 132, 32, C.ink, { font: 'semi', align: 'center' }) + text('the code', w - 250, y + 172, 32, C.ink, { font: 'semi', align: 'center' });
  s += foot(w, h, `Never before. The code tells Hoolam you have it.`, C.red, 0.9);
  return compose({ w, h, bg }, drawn, s);
}

export interface Frozen { side: 'buyer' | 'seller'; amount: string; code: string; hours?: number }
/** A problem was reported: the money is paused. Calm gold, a pause sign, no alarm. */
export async function frozen(d: Frozen, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.goldBg}"/>` + blobs(w, h, C.goldSoft, 0.7);
  let s = head(w, C.teal, C.teal, `Order ${d.code}`, '#fff', C.goldInk);
  s += iconDisc('pause', w / 2, 330, 104, C.gold, '#fff', 0.46, 2.2);
  s += text(d.side === 'buyer' ? 'Money frozen' : 'Paused, not lost', w / 2, 520, 56, C.goldInk, { font: 'brand', align: 'center' });
  s += text(d.amount, w / 2, 668, fit(d.amount, 140, w - 160, 'brand'), C.ink, { font: 'brand', align: 'center' });
  const line = d.side === 'buyer' ? 'Nobody can touch it until this is sorted' : 'Nobody takes it. A rep hears your side first';
  wrap(line, 38, w - 220, 'regular', 2).forEach((l, i) => { s += text(l, w / 2, 748 + i * 52, 38, C.soft, { align: 'center' }); });
  s += pill(`A real person replies within ${d.hours ?? 24} hours`, w / 2, 852, 30, '#fff', C.goldInk, { font: 'bold', iconName: 'user' }).svg;
  s += foot(w, h, 'hoolam.com', C.soft);
  return compose({ w, h, bg }, drawn, s);
}

export interface Summary {
  side: 'buyer' | 'seller'; code?: string | null; item: string; title?: string;
  lines: { icon: string; text: string }[]; big: { label: string; value: string }; photo?: Buffer | null; note?: string | null;
}
/** One order at a glance: the item photo on the left; what to check on the right; the one number that matters, big. */
export async function summary(d: Summary, bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  const px = 60, py = 60, pw = 640, ph = h - 120;
  let s = '';
  if (!d.photo) s += `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="40" fill="${C.mint}"/>` + icon('package', px + pw / 2 - 110, py + ph / 2 - 130, 220, C.teal, 1.6) + text('No photo', px + pw / 2, py + ph / 2 + 150, 34, C.teal, { align: 'center', font: 'semi', opacity: 0.7 });
  const x = px + pw + 70, maxW = w - x - 70;
  s += brand(x, 138, 56, C.teal, C.teal);
  if (d.code) { const cw = width(d.code, 28, 'semi') + 44; s += `<rect x="${w - 70 - cw}" y="94" width="${cw}" height="58" rx="29" fill="${C.mint}"/>` + text(d.code, w - 70 - cw / 2, 133, 28, C.teal, { font: 'semi', align: 'center' }); }
  if (d.title) s += text(d.title, x, 236, 32, C.soft, { font: 'semi' });
  const lines = wrap(d.item, 56, maxW, 'brand', 2);
  lines.forEach((l, i) => { s += text(l, x, 306 + i * 66, 56, C.ink, { font: 'brand' }); });
  let y = 306 + lines.length * 66 + 30;
  for (const l of d.lines.slice(0, 3)) {
    s += icon(l.icon, x, y - 30, 38, C.teal) + text(clip(l.text, 32, maxW - 56), x + 56, y, 32, C.ink);
    y += 58;
  }
  // the big number
  s += `<rect x="${x - 4}" y="${h - 250}" width="${w - x - 66}" height="160" rx="32" fill="${d.side === 'seller' ? C.greenSoft : C.mint}"/>`;
  s += text(d.big.label, x + 36, h - 192, 30, d.side === 'seller' ? C.greenDark : C.teal, { font: 'semi' });
  s += text(d.big.value, x + 36, h - 118, fit(d.big.value, 68, w - x - 140, 'brand'), d.side === 'seller' ? C.greenDark : C.teal, { font: 'brand' });
  if (d.note) s += text(clip(d.note, 26, maxW), x, h - 48, 26, C.soft);
  const layers: OverlayOptions[] = d.photo ? [{ input: await photoLayer(d.photo, pw, ph, 40), left: px, top: py }] : [];
  return compose({ w, h, bg }, drawn, s, layers);
}

export interface OrderRequest {
  to: 'seller' | 'buyer'; who: string; item: string; amount: string; code: string; check: string; photo?: Buffer | null;
}
/**
 * The picture on top of a new order alert, for someone who may never have heard of Hoolam: the item photo in the
 * Hoolam frame, who it's from, the one number that matters, how it works in four steps, and how to check it's a
 * real Hoolam order.
 */
export async function orderRequest(d: OrderRequest, bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const seller = d.to === 'seller';
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  const ps = 500, px = 70, py = 70;
  let s = '';
  if (!d.photo) s += `<rect x="${px}" y="${py}" width="${ps}" height="${ps}" rx="40" fill="${C.mint}"/>` + icon('package', px + ps / 2 - 100, py + ps / 2 - 100, 200, C.teal, 1.6);
  const x = px + ps + 64, maxW = w - x - 70;
  s += brand(x, py + 56, 52, C.teal, C.teal);
  const cw = width(d.code, 28, 'semi') + 44;
  s += `<rect x="${w - 70 - cw}" y="${py + 6}" width="${cw}" height="58" rx="29" fill="${C.mint}"/>` + text(d.code, w - 70 - cw / 2, py + 45, 28, C.teal, { font: 'semi', align: 'center' });
  const head = seller ? `${d.who} wants to buy from you` : `${d.who} sent you an order`;
  const hl = wrap(head, 54, maxW, 'brand', 2);
  hl.forEach((l, i) => { s += text(l, x, py + 160 + i * 64, 54, C.ink, { font: 'brand' }); });
  let y = py + 160 + (hl.length - 1) * 64 + 56;
  s += text(clip(d.item, 36, maxW), x, y, 36, C.soft);
  // the one number
  const by = py + ps - 150;
  s += `<rect x="${x}" y="${by}" width="${maxW}" height="150" rx="32" fill="${seller ? C.greenSoft : C.mint}"/>`;
  s += text(seller ? 'You receive' : 'You pay', x + 36, by + 54, 30, seller ? C.greenDark : C.teal, { font: 'semi' });
  s += text(d.amount, x + 36, by + 122, fit(d.amount, 64, maxW - 72, 'brand'), seller ? C.greenDark : C.teal, { font: 'brand' });
  // how it works, in four steps (every time)
  const band = 680;
  const steps: [string, string][] = seller
    ? [['check', 'You accept'], ['wallet', 'Buyer pays Hoolam'], ['truck', 'You send it'], ['banknote', 'You\'re paid']]
    : [['check', 'You accept'], ['wallet', 'You pay Hoolam'], ['package', 'You get it'], ['banknote', 'Seller is paid']];
  const gap = (w - 400) / 3;
  steps.forEach(([ic, label], i) => {
    const cx = 200 + gap * i;
    if (i < 3) s += `<line x1="${cx + 60}" y1="${band}" x2="${cx + gap - 60}" y2="${band}" stroke="${C.line}" stroke-width="5" stroke-dasharray="2 14" stroke-linecap="round"/>`;
    s += iconDisc(ic, cx, band, 44, i === 1 ? C.gold : C.mint, i === 1 ? '#fff' : C.teal, 0.52, 2.2) + text(label, cx, band + 86, 30, C.ink, { font: 'semi', align: 'center' });
  });
  s += `<line x1="70" y1="${h - 96}" x2="${w - 70}" y2="${h - 96}" stroke="${C.line}" stroke-width="2"/>`;
  s += icon('shieldCheck', w / 2 + 22 - width(`Check it's real: ${d.check}`, 28, 'semi') / 2 - 46, h - 74, 32, C.teal, 2.2) + text(`Check it's real: ${d.check}`, w / 2 + 22, h - 48, 28, C.teal, { font: 'semi', align: 'center' });
  const layers: OverlayOptions[] = d.photo ? [{ input: await photoLayer(d.photo, ps, ps, 40), left: px, top: py }] : [];
  return compose({ w, h, bg }, drawn, s, layers);
}

export interface Trust {
  name: string; city?: string | null; since?: string | null; verified: boolean; isNew: boolean; completed: number;
  happyPct?: number | null; rated?: number; ships?: string | null; buyers?: number; photo?: Buffer | null; sample?: boolean;
}
/** A seller's trust card: who they are, verified or not, and their real record. */
export async function trustCard(d: Trust, bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55);
  let s = '';
  // the card
  s += `<rect x="60" y="60" width="${w - 120}" height="${h - 120}" rx="48" fill="#fff"/>`;
  const cx = 290, cy = 330, R = 150;
  s += `<circle cx="${cx}" cy="${cy}" r="${R + 14}" fill="${C.gold}"/>`;
  if (!d.photo) s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${C.mint}"/>` + text((d.name.trim()[0] ?? 'H').toUpperCase(), cx, cy + 58, 160, C.teal, { font: 'brand', align: 'center' });
  if (d.verified) s += `<circle cx="${cx + 108}" cy="${cy + 108}" r="42" fill="#fff"/>` + iconDisc('badgeCheck', cx + 108, cy + 108, 34, C.teal, '#fff', 0.7, 2.4);
  s += text(clip(d.name, 44, 360, 'brand'), cx, 580, fit(d.name, 44, 360, 'brand', 30), C.ink, { font: 'brand', align: 'center' });
  if (d.city) s += icon('mapPin', cx - width(d.city, 30) / 2 - 26, 610, 28, C.soft) + text(d.city, cx + 18, 634, 30, C.soft, { align: 'center' });
  if (d.since) s += text(`On Hoolam since ${d.since}`, cx, 690, 26, C.soft, { align: 'center' });
  // the record
  const x = 560;
  s += brand(x, 160, 50, C.teal, C.teal);
  const badge = d.verified ? pill('Verified seller', x, 210, 30, C.mint, C.teal, { font: 'bold', iconName: 'badgeCheck', align: 'left' }) : pill('Not verified yet', x, 210, 30, C.paper, C.soft, { font: 'semi', align: 'left' });
  s += badge.svg;
  if (d.isNew) s += pill('New on Hoolam', x + badge.w + 18, 210, 30, C.goldBg, C.goldInk, { font: 'semi', align: 'left' }).svg;
  const stats: [string, string, string][] = [
    ['checkCircle', d.completed ? String(d.completed) : '0', d.completed === 1 ? 'order completed' : 'orders completed'],
    ['thumbsUp', d.happyPct != null && (d.rated ?? 0) >= 5 ? `${d.happyPct}%` : '—', (d.rated ?? 0) >= 5 ? 'of buyers happy' : 'ratings soon'],
    ['package', d.ships ?? '—', 'usually ships'],
  ];
  stats.forEach(([ic, big, label], i) => {
    const sx = x + i * 300, sy = 320;
    s += `<rect x="${sx}" y="${sy}" width="270" height="250" rx="30" fill="${C.paper}"/>` + icon(ic, sx + 34, sy + 34, 46, C.teal);
    s += text(big, sx + 34, sy + 160, fit(big, 72, 210, 'brand', 34), C.ink, { font: 'brand' });
    s += text(label, sx + 34, sy + 212, 26, C.soft);
  });
  s += text(d.sample ? 'This is what buyers see before they pay you' : 'Counted from real orders paid through Hoolam', x, 680, 30, d.sample ? C.gold : C.soft, { font: d.sample ? 'bold' : 'regular' });
  s += text('Buy safely: your money is held until you\'re happy.', x, 730, 30, C.teal, { font: 'semi' });
  const layers: OverlayOptions[] = d.photo ? [{ input: await photoLayer(d.photo, R * 2, R * 2, R), left: cx - R, top: cy - R }] : [];
  // the badge sits on top of the photo
  const top = d.photo && d.verified ? `<circle cx="${cx + 108}" cy="${cy + 108}" r="42" fill="#fff"/>` + iconDisc('badgeCheck', cx + 108, cy + 108, 34, C.teal, '#fff', 0.7, 2.4) : '';
  return compose({ w, h, bg }, drawn, s, layers, 'jpeg', top);
}

/** The trust card as a 9:16 picture for WhatsApp status, with the seller's link. */
export async function trustStatus(d: Trust & { link: string }, bg?: Bg): Promise<Buffer> {
  const w = 1080, h = 1920;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55);
  let s = brand(w / 2 - 150, 210, 96, '#fff', null);
  s += text('Buy from me safely', w / 2, 400, 78, '#fff', { font: 'brand', align: 'center' });
  s += text('Your money is held by Hoolam until you\'re happy', w / 2, 470, 38, C.tealSoft, { align: 'center' });
  s += `<rect x="80" y="560" width="${w - 160}" height="900" rx="56" fill="#fff"/>`;
  const cx = w / 2, cy = 800, R = 170;
  s += `<circle cx="${cx}" cy="${cy}" r="${R + 16}" fill="${C.gold}"/>`;
  if (!d.photo) s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${C.mint}"/>` + text((d.name.trim()[0] ?? 'H').toUpperCase(), cx, cy + 64, 180, C.teal, { font: 'brand', align: 'center' });
  s += text(clip(d.name, 60, w - 260, 'brand'), cx, 1070, fit(d.name, 60, w - 260, 'brand', 36), C.ink, { font: 'brand', align: 'center' });
  if (d.verified) s += pill('Verified seller', cx, 1110, 34, C.mint, C.teal, { font: 'bold', iconName: 'badgeCheck' }).svg;
  const stat = d.completed ? `${d.completed} safe order${d.completed === 1 ? '' : 's'}` + (d.happyPct != null && (d.rated ?? 0) >= 5 ? ` · ${d.happyPct}% happy` : '') : 'New on Hoolam';
  s += text(stat, cx, 1290, 44, C.ink, { font: 'semi', align: 'center' });
  s += text(d.city ?? '', cx, 1350, 34, C.soft, { align: 'center' });
  const p = pill(d.link.replace(/^https?:\/\//, ''), w / 2, 1560, 40, C.gold, C.tealDeep, { font: 'bold' });
  s += p.svg + text('Tap the link to buy safely', w / 2, 1720, 36, C.tealSoft, { align: 'center' });
  const layers: OverlayOptions[] = d.photo ? [{ input: await photoLayer(d.photo, R * 2, R * 2, R), left: cx - R, top: cy - R }] : [];
  return compose({ w, h, bg }, drawn, s, layers);
}

export interface Complete { item: string; n: number; other?: string | null; photo?: Buffer | null }
/** The end of a good order: the item with a green tick. */
export async function complete(d: Complete, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>` + confetti(w, h, d.item + d.n, [C.gold, C.teal, C.green, C.goldSoft], 44, { top: 150, bottom: 720 }, { x1: 290, x2: 790, y1: 170, y2: 700 });
  let s = head(w, C.teal, C.teal);
  const ps = 440, px = w / 2 - ps / 2, py = 190;
  if (!d.photo) s += `<rect x="${px}" y="${py}" width="${ps}" height="${ps}" rx="56" fill="${C.mint}"/>` + icon('package', w / 2 - 110, py + 110, 220, C.teal, 1.6);
  const top = `<circle cx="${px + ps - 20}" cy="${py + ps - 20}" r="76" fill="#fff"/><circle cx="${px + ps - 20}" cy="${py + ps - 20}" r="62" fill="${C.green}"/>` + icon('check', px + ps - 58, py + ps - 58, 76, '#fff', 3.2);
  s += text(d.n > 1 ? `Safe order #${d.n} done` : 'Your first safe order, done', w / 2, 760, 54, C.ink, { font: 'brand', align: 'center' });
  s += text(clip(d.item, 36, w - 200), w / 2, 822, 36, C.soft, { align: 'center' });
  s += text(d.other ? `Thanks for buying safely from ${d.other}` : 'Thanks for buying safely', w / 2, 900, 34, C.teal, { font: 'semi', align: 'center' });
  s += foot(w, h, 'hoolam.com', C.soft);
  const layers: OverlayOptions[] = d.photo ? [{ input: await photoLayer(d.photo, ps, ps, 56), left: px, top: py }] : [];
  return compose({ w, h, bg }, drawn, s, layers, 'jpeg', top);
}

export interface AmbMonth { name: string; month: string; amount: string; bars: { label: string; value: number }[]; people: number; activeSellers: number }
/** An ambassador's month, like a payslip they're proud of: the amount, six months of bars, who they brought. */
export async function ambMonth(d: AmbMonth, bg?: Bg): Promise<Buffer> {
  const w = 1080, h = 1350;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55);
  let s = head(w, '#fff', null, 'Ambassador');
  s += text(`${d.name ? d.name + ', your' : 'Your'} ${d.month}`, 72, 290, 44, C.goldSoft, { font: 'semi' });
  s += text(d.amount, 72, 430, fit(d.amount, 150, w - 144, 'brand'), '#fff', { font: 'brand' });
  s += text('earned from the people you brought', 72, 496, 36, C.tealSoft);
  // bars
  const bx = 72, by = 1000, bh = 380, bw = 110, gap = (w - 144 - bw * 6) / 5;
  const max = Math.max(1, ...d.bars.map((b) => b.value));
  d.bars.slice(-6).forEach((b, i) => {
    const hh = Math.max(10, (b.value / max) * bh), x = bx + i * (bw + gap), last = i === Math.min(6, d.bars.length) - 1;
    s += `<rect x="${x}" y="${by - hh}" width="${bw}" height="${hh}" rx="18" fill="${last ? C.gold : '#fff'}" opacity="${last ? 1 : 0.28}"/>`;
    s += text(b.label, x + bw / 2, by + 50, 28, last ? C.goldSoft : C.tealSoft, { font: last ? 'bold' : 'regular', align: 'center' });
  });
  const st = (x: number, big: string, label: string) => text(big, x, 1190, 64, '#fff', { font: 'brand' }) + text(label, x, 1240, 30, C.tealSoft);
  s += st(72, String(d.people), d.people === 1 ? 'person brought' : 'people brought') + st(560, String(d.activeSellers), d.activeSellers === 1 ? 'active seller' : 'active sellers');
  s += foot(w, h, 'Your share grows when you bring more active sellers and buyers', C.tealSoft, 0.85);
  return compose({ w, h, bg }, drawn, s);
}

export interface Fees { rows: { price: string; hoolam: string; txn: string }[] }
/** Fees for three example orders, from the console's numbers. */
export async function fees(d: Fees, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = head(w, C.teal, C.teal);
  s += text('What it costs', 72, 270, 70, C.ink, { font: 'brand' });
  s += text('Whoever starts the order pays the Hoolam fee.', 72, 330, 32, C.soft);
  s += text('The other side pays a small transaction fee.', 72, 374, 32, C.soft);
  const cols = [72, 430, 760];
  s += `<rect x="60" y="420" width="${w - 120}" height="${110 + d.rows.length * 120}" rx="32" fill="#fff" stroke="${C.line}" stroke-width="3"/>`;
  ['Order', 'Hoolam fee', 'Transaction fee'].forEach((t, i) => { s += text(t, cols[i]! + 28, 492, 28, C.soft, { font: 'semi' }); });
  d.rows.slice(0, 3).forEach((r, i) => {
    const y = 600 + i * 120;
    if (i) s += `<line x1="96" y1="${y - 76}" x2="${w - 96}" y2="${y - 76}" stroke="${C.line}" stroke-width="2"/>`;
    s += text(r.price, cols[0]! + 28, y, 46, C.ink, { font: 'brand' }) + text(r.hoolam, cols[1]! + 28, y, 44, C.teal, { font: 'bold' }) + text(r.txn, cols[2]! + 28, y, 44, C.teal, { font: 'bold' });
  });
  s += pill('No hidden charges · Cancel before paying: no fee', w / 2, 940, 28, C.mint, C.teal, { font: 'semi' }).svg;
  return compose({ w, h, bg }, drawn, s);
}

export interface AmbWelcome { name: string; link?: string | null }
export async function ambWelcome(d: AmbWelcome, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55) + confetti(w, h, d.name, [C.gold, '#fff', C.goldSoft], 40, { top: 160, bottom: 520 }, { x1: 330, x2: 750, y1: 200, y2: 480 });
  let s = head(w, '#fff', null, 'Ambassador');
  s += `<circle cx="${w / 2}" cy="340" r="110" fill="${C.gold}"/>` + icon('badgeCheck', w / 2 - 60, 280, 120, C.tealDeep, 2.2);
  s += text('Welcome to the team', w / 2, 560, 60, '#fff', { font: 'brand', align: 'center' });
  s += text(d.name || 'Ambassador', w / 2, 660, fit(d.name || 'Ambassador', 92, w - 160, 'brand'), C.goldSoft, { font: 'brand', align: 'center' });
  s += text('Verified Hoolam ambassador', w / 2, 740, 36, C.tealSoft, { font: 'semi', align: 'center' });
  if (d.link) s += pill(d.link.replace(/^https?:\/\//, ''), w / 2, 820, 34, C.gold, C.tealDeep, { font: 'bold' }).svg;
  s += foot(w, h, 'Earn from every safe order you bring', C.tealSoft);
  return compose({ w, h, bg }, drawn, s);
}

// ---------------------------------------------------------------------------------------------
// fixed pictures (drawn once; the owner can replace any of them)

/** The whole idea in four pictures: you pay Hoolam → we hold it → seller delivers → seller paid. */
export async function howItWorks(bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = brand(80, 128, 64, C.teal, C.teal);
  s += text('Your money waits with Hoolam', w / 2, 270, 70, C.ink, { font: 'brand', align: 'center' });
  s += text('until you get what you ordered', w / 2, 340, 46, C.soft, { align: 'center' });
  const steps: [string, string, string, string, string][] = [
    ['wallet', 'You pay', 'Hoolam', C.mint, C.teal], ['shieldCheck', 'Hoolam', 'holds it', C.gold, '#fff'],
    ['truck', 'Seller', 'delivers', C.mint, C.teal], ['banknote', 'You\'re happy,', 'seller is paid', C.greenSoft, C.greenDark],
  ];
  const gap = (w - 480) / 3;
  steps.forEach(([ic, a, b, bgc, fg], i) => {
    const cx = 240 + gap * i, cy = 560;
    if (i < 3) s += `<line x1="${cx + 116}" y1="${cy}" x2="${cx + gap - 116}" y2="${cy}" stroke="${C.line}" stroke-width="6" stroke-dasharray="2 16" stroke-linecap="round"/>` + icon('arrowRight', cx + gap / 2 - 24, cy - 24, 48, C.gold, 2.6);
    s += iconDisc(ic, cx, cy, 100, bgc, fg, 0.5, 2) + text(a, cx, cy + 170, 38, C.ink, { font: 'semi', align: 'center' }) + text(b, cx, cy + 218, 38, C.ink, { font: 'semi', align: 'center' });
  });
  s += text('A problem? The money stays frozen until it\'s sorted.', w / 2, h - 50, 32, C.teal, { font: 'semi', align: 'center' });
  return compose({ w, h, bg }, drawn, s);
}

/** The status strip on its own, one picture per step (1–6), with what is true at that step. */
const STEP_LINE = [
  'Order sent. Waiting for the other side to accept.', 'Accepted. Waiting for the buyer to pay Hoolam.', 'Money held by Hoolam. The seller sends the item.',
  'On the way. The buyer gives the code only when it\'s in their hands.', 'Delivered. The buyer checks it.', 'Done. The seller is paid.',
];
export async function status(step: number, bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const k = Math.min(6, Math.max(1, step));
  const done = k === 6;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = brand(80, 128, 64, C.teal, C.teal);
  s += text(`Step ${k} of 6`, w - 80, 120, 34, C.soft, { font: 'semi', align: 'right' });
  const title = STEPS[k - 1]!;
  s += text(title, w / 2, 330, 96, done ? C.green : C.teal, { font: 'brand', align: 'center' });
  s += text(STEP_LINE[k - 1]!, w / 2, 410, 38, C.soft, { align: 'center' });
  s += strip(170, 580, w - 340, done ? 7 : k, { on: k === 3 ? C.gold : C.teal, done: done ? C.green : C.teal, idle: C.line, label: C.soft, labelOn: C.ink, size: 34 });
  const money = k <= 2 ? 'No money has moved yet' : k <= 5 ? 'The money is held safely by Hoolam' : 'Money released to the seller';
  s += pill(money, w / 2, 760, 32, k <= 2 ? C.paper : k <= 5 ? C.goldBg : C.greenSoft, k <= 2 ? C.soft : k <= 5 ? C.goldInk : C.greenDark, { font: 'bold', iconName: k <= 2 ? 'clock' : k <= 5 ? 'shieldCheck' : 'check' }).svg;
  return compose({ w, h, bg }, drawn, s);
}

/** Why we check an ID, and what we never do: beats the "BVN scam" fear. */
export async function idCheck(bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = brand(80, 128, 64, C.teal, C.teal);
  s += iconDisc('idCard', 330, 470, 190, C.mint, C.teal, 0.5, 1.8);
  s += text('A quick ID check, once', 600, 270, 66, C.ink, { font: 'brand' });
  const rows: [string, string, string][] = [
    ['badgeCheck', 'Checked by Prembly, a licensed ID checker', C.teal],
    ['shieldCheck', 'We keep only the result, never your BVN or NIN', C.teal],
    ['phoneOff', 'We never ask for your PIN, OTP or password', C.red],
  ];
  rows.forEach(([ic, t, col], i) => {
    const y = 400 + i * 130;
    s += iconDisc(ic, 640, y, 44, col === C.red ? '#FBE9E7' : C.mint, col, 0.6, 2.2) + text(t, 710, y + 14, 38, C.ink, { font: 'semi' });
  });
  s += text('Your details are protected under Nigeria\'s data protection law.', w / 2, h - 60, 30, C.soft, { align: 'center' });
  return compose({ w, h, bg }, drawn, s);
}

// ---------------------------------------------------------------------------------------------
// pictures inside the WhatsApp forms: small and light (they're sent inside the form), one per screen

const FORM = { w: 1600, h: 600 };
/** The Buy / Sell form's first screen (first time only): you pay Hoolam → Hoolam holds it → the seller is paid when you're happy. */
export async function formStart(bg?: Bg): Promise<Buffer> {
  const { w, h } = FORM;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = text('Hoolam holds your money', w / 2, 116, 64, C.ink, { font: 'brand', align: 'center' });
  const steps: [string, string, string, string][] = [
    ['wallet', 'You pay Hoolam', C.mint, C.teal], ['shieldCheck', 'Hoolam holds it', C.gold, '#fff'], ['banknote', 'Seller paid when you\'re happy', C.greenSoft, C.greenDark],
  ];
  const gap = (w - 520) / 2;
  steps.forEach(([ic, label, bgc, fg], i) => {
    const cx = 260 + gap * i, cy = 330;
    if (i < 2) s += `<line x1="${cx + 110}" y1="${cy}" x2="${cx + gap - 110}" y2="${cy}" stroke="${C.line}" stroke-width="6" stroke-dasharray="2 16" stroke-linecap="round"/>` + icon('arrowRight', cx + gap / 2 - 24, cy - 24, 48, C.gold, 2.6);
    s += iconDisc(ic, cx, cy, 92, bgc, fg, 0.5, 2);
    wrap(label, 38, 420, 'semi', 2).forEach((l, j) => { s += text(l, cx, cy + 160 + j * 46, 38, C.ink, { font: 'semi', align: 'center' }); });
  });
  return compose({ w, h, bg }, drawn, s);
}

export interface OrderStatus {
  step: number; title: string; item: string; code?: string | null; amountLabel: string; amount: string; money: string; tone?: 'teal' | 'gold' | 'green' | 'red'; photo?: Buffer | null;
}
/** One order's status inside My orders: the item photo, where the money is, the step strip, the real amount. */
export async function orderStatus(d: OrderStatus, bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const tone = d.tone === 'green' ? C.green : d.tone === 'red' ? C.red : C.teal;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  const ps = 260, px = 70, py = 70;
  let s = '';
  if (!d.photo) s += `<rect x="${px}" y="${py}" width="${ps}" height="${ps}" rx="36" fill="${C.mint}"/>` + icon('package', px + ps / 2 - 70, py + ps / 2 - 70, 140, C.teal, 1.6);
  const x = px + ps + 50, maxW = w - x - 70;
  if (d.code) { const cw = width(d.code, 28, 'semi') + 44; s += `<rect x="${w - 70 - cw}" y="${py}" width="${cw}" height="58" rx="29" fill="${C.mint}"/>` + text(d.code, w - 70 - cw / 2, py + 39, 28, C.teal, { font: 'semi', align: 'center' }); }
  s += text(clip(d.title, 66, maxW - 260, 'brand'), x, py + 120, 66, tone, { font: 'brand' });
  s += text(clip(d.item, 38, maxW), x, py + 190, 38, C.soft);
  s += pill(d.money, x, py + 240, 30, d.tone === 'red' ? '#FBE9E7' : d.step >= 3 && d.step <= 5 ? C.goldBg : d.step === 6 ? C.greenSoft : C.mint,
    d.tone === 'red' ? C.red : d.step >= 3 && d.step <= 5 ? C.goldInk : d.step === 6 ? C.greenDark : C.teal, { font: 'bold', iconName: d.tone === 'red' ? 'pause' : d.step >= 3 ? 'shieldCheck' : 'clock', align: 'left' }).svg;
  if (d.step >= 1) s += strip(170, 520, w - 340, d.step === 6 ? 7 : d.step, { on: d.step === 3 ? C.gold : tone, done: d.step === 6 ? C.green : C.teal, idle: C.line, label: C.soft, labelOn: C.ink, size: 30 });
  s += `<rect x="70" y="${h - 200}" width="${w - 140}" height="140" rx="32" fill="${C.white}" stroke="${C.line}" stroke-width="3"/>`;
  s += text(d.amountLabel, 120, h - 115, 36, C.soft, { font: 'semi' });
  s += text(d.amount, w - 120, h - 100, fit(d.amount, 64, 700, 'brand'), C.ink, { font: 'brand', align: 'right' });
  const layers: OverlayOptions[] = d.photo ? [{ input: await photoLayer(d.photo, ps, ps, 36), left: px, top: py }] : [];
  return compose({ w, h, bg }, drawn, s, layers);
}

/** Where the order code is: a seller's message with the code circled. */
export async function codeWhere(bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="#ECE5DD"/>`;
  let s = brand(80, 128, 64, C.teal, C.teal);
  s += text('The code your seller sent you', w / 2, 250, 60, C.ink, { font: 'brand', align: 'center' });
  // a chat bubble
  const bx = 300, by = 320, bw = w - 600, bh = 380;
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="34" fill="#fff"/><path d="M${bx} ${by + 30} l-30 -26 h60z" fill="#fff"/>`;
  s += iconDisc('store', bx + 80, by + 80, 40, C.mint, C.teal, 0.55) + text('Kemi\'s Wigs', bx + 140, by + 94, 34, C.teal, { font: 'bold' });
  s += text('Here\'s your order on Hoolam.', bx + 60, by + 180, 38, C.ink);
  s += text('Order code:', bx + 60, by + 270, 44, C.ink);
  const cx = bx + 60 + width('Order code:', 44) + 40;
  s += text('HL-7K2QF', cx, by + 270, 48, C.ink, { font: 'bold' });
  const cw = width('HL-7K2QF', 48, 'bold');
  s += `<ellipse cx="${cx + cw / 2}" cy="${by + 254}" rx="${cw / 2 + 26}" ry="50" fill="none" stroke="${C.gold}" stroke-width="8"/>`;
  s += text('9:41 AM', bx + bw - 40, by + bh - 30, 26, C.soft, { align: 'right' });
  s += text('Send that code here, starting with HL-', w / 2, h - 70, 36, C.teal, { font: 'semi', align: 'center' });
  return compose({ w, h, bg }, drawn, s);
}

/** A good profile photo vs a poor one. */
export async function photoTips(bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = brand(80, 128, 64, C.teal, C.teal);
  s += text('A clear photo builds trust', w / 2, 240, 62, C.ink, { font: 'brand', align: 'center' });
  const person = (cx: number, cy: number, r: number, scale: number, skin: string, bgc: string) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bgc}"/>` +
    `<clipPath id="c${cx}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><g clip-path="url(#c${cx})">` +
    `<circle cx="${cx}" cy="${cy - 26 * scale}" r="${70 * scale}" fill="${skin}"/><ellipse cx="${cx}" cy="${cy + 150 * scale}" rx="${140 * scale}" ry="${110 * scale}" fill="${skin}"/></g>`;
  s += person(470, 520, 190, 1.35, '#7A4E2D', C.mint) + iconDisc('check', 600, 660, 48, C.green, '#fff', 0.6, 3);
  s += text('Face in the middle, good light', 470, 790, 36, C.ink, { font: 'semi', align: 'center' });
  s += person(1130, 520, 190, 0.45, '#3B2A20', '#4A5559') + iconDisc('x', 1260, 660, 48, C.red, '#fff', 0.6, 3);
  s += text('Too far, too dark', 1130, 790, 36, C.ink, { font: 'semi', align: 'center' });
  return compose({ w, h, bg }, drawn, s);
}

/** "This is really Hoolam": the profile, the verified tick, and the rule we never break. */
export async function realHoolam(d: { number?: string | null }, bg?: Bg): Promise<Buffer> {
  const w = SQ, h = SQ;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.paper}"/>`;
  let s = '';
  s += mark(w / 2 - 120, 120, 240);
  s += text('Hoolam', w / 2 - 22, 480, 76, C.ink, { font: 'brand', align: 'center' });
  const tw = width('Hoolam', 76, 'brand');
  s += iconDisc('badgeCheck', w / 2 - 22 + tw / 2 + 50, 454, 30, '#25D366', '#fff', 0.75, 2.4);
  if (d.number) s += text(d.number, w / 2, 560, 46, C.soft, { font: 'semi', align: 'center' });
  s += `<rect x="90" y="640" width="${w - 180}" height="200" rx="36" fill="#FBE9E7"/>` + icon('phoneOff', 140, 690, 72, C.red, 2.2);
  s += text('We never ask for your', 250, 724, 40, C.ink, { font: 'semi' }) + text('PIN, OTP or password', 250, 784, 44, C.red, { font: 'bold' });
  s += text('Save this number. Our messages only come from here.', w / 2, h - 110, 32, C.teal, { font: 'semi', align: 'center' });
  return compose({ w, h, bg }, drawn, s);
}

/** On top of a rider's or driver's delivery message. */
export async function rider(bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55);
  let s = brand(80, 128, 64, '#fff', null);
  s += iconDisc('bike', 380, 500, 210, C.gold, C.tealDeep, 0.56, 1.8);
  s += text('Hoolam delivery', 680, 420, 84, '#fff', { font: 'brand' });
  s += text('Hand over the item, enter', 680, 500, 44, C.tealSoft);
  s += text('the buyer\'s 4-digit code,', 680, 556, 44, C.tealSoft);
  s += text('and get your fee straight away.', 680, 612, 44, C.tealSoft);
  return compose({ w, h, bg }, drawn, s);
}

/** On top of "Become an ambassador": the live shares from the console. */
export async function ambIntro(d: { seller: string; buyer: string; bonus: string }, bg?: Bg): Promise<Buffer> {
  const { w, h } = WIDE;
  const drawn = `<rect width="${w}" height="${h}" fill="${C.teal}"/>` + blobs(w, h, C.tealDark, 0.55);
  let s = brand(80, 128, 64, '#fff', null);
  s += text('Earn from every safe order', 80, 300, 76, '#fff', { font: 'brand' });
  s += text('you bring to Hoolam', 80, 384, 76, C.goldSoft, { font: 'brand' });
  const tiles: [string, string, string][] = [['store', d.seller, 'on sellers you bring'], ['users', d.buyer, 'on buyers you bring'], ['star', d.bonus, 'bonus per new seller']];
  tiles.forEach(([ic, big, label], i) => {
    const x = 80 + i * 490, y = 470;
    s += `<rect x="${x}" y="${y}" width="450" height="300" rx="36" fill="#fff" opacity=".1"/>` + icon(ic, x + 40, y + 40, 52, C.gold);
    s += text(big, x + 40, y + 190, 84, '#fff', { font: 'brand' }) + text(label, x + 40, y + 248, 32, C.tealSoft);
  });
  s += text('Paid to your bank every month', 80, h - 50, 32, C.tealSoft, { font: 'semi' });
  return compose({ w, h, bg }, drawn, s);
}

// ---------------------------------------------------------------------------------------------
// stickers (512 × 512, transparent, with the white sticker edge)

export type StickerName = 'held' | 'paid' | 'welldone' | 'thanks' | 'verified';
export async function sticker(name: StickerName, bg?: Bg): Promise<Buffer> {
  const w = 512, h = 512;
  const def: Record<StickerName, { ic: string; bg: string; fg: string; label: string }> = {
    held: { ic: 'shieldCheck', bg: C.teal, fg: C.gold, label: 'Held' },
    paid: { ic: 'check', bg: C.green, fg: '#fff', label: 'Paid!' },
    welldone: { ic: 'thumbsUp', bg: C.gold, fg: '#fff', label: 'Well done' },
    thanks: { ic: 'heart', bg: C.teal, fg: '#fff', label: 'Thank you' },
    verified: { ic: 'badgeCheck', bg: C.teal, fg: '#fff', label: 'Verified' },
  };
  const d = def[name];
  let s = `<circle cx="256" cy="226" r="196" fill="#fff"/><circle cx="256" cy="226" r="176" fill="${d.bg}"/>` + icon(d.ic, 256 - 92, 226 - 104, 184, d.fg, name === 'paid' ? 3 : 2.2);
  const lw = width(d.label, 64, 'brand') + 70;
  s += `<rect x="${256 - lw / 2 - 10}" y="${372}" width="${lw + 20}" height="${118}" rx="59" fill="#fff"/><rect x="${256 - lw / 2}" y="382" width="${lw}" height="98" rx="49" fill="${C.ink}"/>`;
  s += text(d.label, 256, 452, 64, '#fff', { font: 'brand', align: 'center' });
  return compose({ w, h, bg }, '', s, [], 'webp');
}
