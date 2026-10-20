import opentype from 'opentype.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { markImage } from '../brand-mark.js';

/**
 * The drawing kit for every picture Hoolam sends in the chat: brand colours, the fonts (drawn as shapes, so a card
 * looks the same on every server), icons (Lucide, ISC licence), the mark, and a few building blocks.
 * One look everywhere: people should recognise "the Hoolam card" before they read it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FONTS = join(ROOT, 'assets', 'fonts');
let f: { regular: opentype.Font; semi: opentype.Font; bold: opentype.Font; brand: opentype.Font } | null = null;
export const fonts = () => (f ??= {
  regular: opentype.loadSync(join(FONTS, 'Inter-Regular.otf')),
  semi: opentype.loadSync(join(FONTS, 'Inter-SemiBold.otf')),
  bold: opentype.loadSync(join(FONTS, 'Inter-Bold.otf')),
  brand: opentype.loadSync(join(FONTS, 'Poppins-Bold.ttf')),
});
export type FontName = 'regular' | 'semi' | 'bold' | 'brand';

export const C = {
  teal: '#0E5C63', tealDark: '#083E43', tealDeep: '#06343A', tealSoft: '#CFE3E1', mint: '#E2EFEA',
  gold: '#C9992E', goldSoft: '#F4E7C6', goldBg: '#FBF4E2', goldInk: '#7A5A12',
  green: '#2E8B57', greenDark: '#1F6B42', greenSoft: '#DCEFE3',
  red: '#C0392B', ink: '#17292B', soft: '#5B6B6A', line: '#E4E1D8', paper: '#FAFAF7', white: '#FFFFFF',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Text as a shape. `align`: where x sits (start, middle, end of the line). */
export function text(s: string, x: number, y: number, size: number, fill: string, o: { font?: FontName; align?: 'left' | 'center' | 'right'; opacity?: number; spacing?: number } = {}): string {
  const font = fonts()[o.font ?? 'regular'];
  const w = width(s, size, o.font, o.spacing);
  const sx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  const op = o.opacity != null ? ` opacity="${o.opacity}"` : '';
  if (!o.spacing && covered(font, s)) return `<path d="${font.getPath(s, sx, y, size).toPathData(2)}" fill="${fill}"${op}/>`;
  // letter by letter: letter spacing, or a character the font doesn't have (the naira sign in Poppins)
  let cx = sx; const parts: string[] = [];
  for (const ch of s) {
    parts.push(glyph(font, ch, cx, y, size));
    cx += advance(font, ch, size) + (o.spacing ?? 0);
  }
  return `<path d="${parts.join(' ')}" fill="${fill}"${op}/>`;
}
const covered = (font: opentype.Font, s: string) => { for (const ch of s) if (font.charToGlyphIndex(ch) === 0 && ch.trim()) return false; return true; };
/** One character as a path. ₦ missing from the font: an N with two bars across it, in the font's own weight. */
function glyph(font: opentype.Font, ch: string, x: number, y: number, size: number): string {
  if (font.charToGlyphIndex(ch) !== 0 || !ch.trim()) return font.getPath(ch, x, y, size).toPathData(2);
  if (ch === '₦') {
    const n = font.getPath('N', x, y, size).toPathData(2);
    const nw = font.getAdvanceWidth('N', size), cap = size * 0.72, t = Math.max(2, size * 0.055);
    const bar = (yy: number) => `M${(x - nw * 0.05).toFixed(2)} ${(yy - t / 2).toFixed(2)}h${(nw * 1.1).toFixed(2)}v${t.toFixed(2)}h${(-nw * 1.1).toFixed(2)}Z`;
    return `${n} ${bar(y - cap * 0.62)} ${bar(y - cap * 0.38)}`;
  }
  return fonts().regular.getPath(ch, x, y, size).toPathData(2);
}
function advance(font: opentype.Font, ch: string, size: number): number {
  if (font.charToGlyphIndex(ch) !== 0 || !ch.trim()) return font.getAdvanceWidth(ch, size);
  return ch === '₦' ? font.getAdvanceWidth('N', size) : fonts().regular.getAdvanceWidth(ch, size);
}
export function width(s: string, size: number, font: FontName = 'regular', spacing = 0): number {
  const fo = fonts()[font];
  const base = covered(fo, s) ? fo.getAdvanceWidth(s, size) : Array.from(s).reduce((a, ch) => a + advance(fo, ch, size), 0);
  return base + (spacing ? spacing * (Array.from(s).length - 1) : 0);
}
/** The biggest size (down to `min`) at which the text fits in `max`. */
export function fit(s: string, size: number, max: number, font: FontName = 'regular', min = 20): number {
  let n = size;
  while (n > min && width(s, n, font) > max) n -= 2;
  return n;
}
/** Words wrapped into lines no wider than `max`, at most `lines` (the last one shortened with …). */
export function wrap(s: string, size: number, max: number, font: FontName = 'regular', lines = 3): string[] {
  const out: string[] = []; let line = '';
  for (const w of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (width(next, size, font) <= max || !line) line = next; else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    let last = kept[lines - 1]!;
    while (last.length > 1 && width(last + '…', size, font) > max) last = last.slice(0, -1);
    kept[lines - 1] = last.trimEnd() + '…';
    return kept;
  }
  return out;
}
/** A short version of a long name for one line. */
export function clip(s: string, size: number, max: number, font: FontName = 'regular'): string {
  if (width(s, size, font) <= max) return s;
  let t = s;
  while (t.length > 1 && width(t + '…', size, font) > max) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

/** Lucide icons (24×24 strokes). */
export const ICONS: Record<string, string> = {
  shieldCheck: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/>',
  banknote: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  idCard: '<path d="M16 10h2"/><path d="M16 14h2"/><path d="M6.17 15a3 3 0 0 1 5.66 0"/><circle cx="9" cy="11" r="2"/><rect x="2" y="5" width="20" height="14" rx="2"/>',
  badgeCheck: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  landmark: '<path d="M10 18v-7"/><path d="M11.12 2.2a2 2 0 0 1 1.76 0l7.86 3.93A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.24-.94z"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M3 22h18"/><path d="M6 18v-7"/>',
  mapPin: '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  thumbsUp: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  messageCircle: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  store: '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  trendingUp: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  phoneOff: '<path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
};
/** An icon at (x, y), `size` px square. */
export function icon(name: keyof typeof ICONS | string, x: number, y: number, size: number, color: string, strokeWidth = 2): string {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</g>`;
}
/** An icon centred in a filled circle. */
export function iconDisc(name: string, cx: number, cy: number, r: number, bg: string, fg: string, ratio = 0.5, strokeWidth = 2): string {
  const s = r * 2 * ratio;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}"/>` + icon(name, cx - s / 2, cy - s / 2, s, fg, strokeWidth);
}

/**
 * The Hoolam logo icon: the one uploaded in Console → Settings → Brand (see brand-mark.ts), else the drawn mark
 * (a gold dot over a smile, on a rounded teal tile, or bare on a coloured background).
 */
export function mark(x: number, y: number, size: number, o: { tile?: string | null; dot?: string; smile?: string } = {}): string {
  const uploaded = markImage(x, y, size);
  if (uploaded) return uploaded;
  const tile = o.tile === undefined ? C.teal : o.tile;
  const s = size / 64;
  return `<g transform="translate(${x} ${y}) scale(${s})">` + (tile ? `<rect width="64" height="64" rx="18" fill="${tile}"/>` : '') +
    `<g transform="translate(12 12) scale(1.6667)"><circle cx="12" cy="8.5" r="3.7" fill="${o.dot ?? C.gold}"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="${o.smile ?? '#fff'}" stroke-width="2.4" stroke-linecap="round"/></g></g>`;
}
/** Mark + "Hoolam" wordmark. */
export function brand(x: number, y: number, size: number, color: string, tile: string | null = C.teal): string {
  return mark(x, y - size * 0.78, size, { tile, smile: tile ? '#fff' : color }) + text('Hoolam', x + size * 1.22, y, size * 0.62, color, { font: 'brand' });
}

/** A rounded pill with text, centred on cx. Returns the svg; width is sized to the text. */
export function pill(s: string, cx: number, y: number, size: number, bg: string, fg: string, o: { font?: FontName; padX?: number; h?: number; iconName?: string; align?: 'center' | 'left' } = {}): { svg: string; w: number } {
  const padX = o.padX ?? size * 0.9;
  const h = o.h ?? size * 2.1;
  const ic = o.iconName ? size * 1.15 : 0;
  const gap = o.iconName ? size * 0.45 : 0;
  const w = width(s, size, o.font ?? 'semi') + padX * 2 + ic + gap;
  const x = o.align === 'left' ? cx : cx - w / 2;
  const svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/>` +
    (o.iconName ? icon(o.iconName, x + padX, y + (h - ic) / 2, ic, fg, 2.2) : '') +
    text(s, x + padX + ic + gap, y + h / 2 + size * 0.36, size, fg, { font: o.font ?? 'semi' });
  return { svg, w };
}

/** Soft background circles: depth without noise. */
export function blobs(w: number, h: number, color: string, opacity = 0.5): string {
  return `<circle cx="${w * 0.92}" cy="${h * 0.06}" r="${w * 0.36}" fill="${color}" opacity="${opacity}"/>` +
    `<circle cx="${w * 0.04}" cy="${h * 0.98}" r="${w * 0.28}" fill="${color}" opacity="${opacity * 0.8}"/>`;
}

/** Deterministic confetti for the "paid" moments (same picture for the same seed). */
export function confetti(w: number, h: number, seed: string, colors: string[], count = 46, area?: { top: number; bottom: number }, avoid?: { x1: number; x2: number; y1: number; y2: number }): string {
  let x = 2166136261;
  for (const ch of seed) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); }
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; };
  const out: string[] = [];
  const top = area?.top ?? 0, bottom = area?.bottom ?? h;
  for (let i = 0; i < count; i++) {
    const cx = rnd() * w, cy = top + rnd() * (bottom - top), rot = rnd() * 180, c = colors[i % colors.length];
    if (avoid && cx > avoid.x1 && cx < avoid.x2 && cy > avoid.y1 && cy < avoid.y2) continue;
    const kind = rnd();
    if (kind < 0.55) out.push(`<rect x="${cx}" y="${cy}" width="${10 + rnd() * 10}" height="${22 + rnd() * 14}" rx="3" fill="${c}" transform="rotate(${rot} ${cx} ${cy})" opacity="${0.55 + rnd() * 0.4}"/>`);
    else if (kind < 0.85) out.push(`<circle cx="${cx}" cy="${cy}" r="${5 + rnd() * 6}" fill="${c}" opacity="${0.5 + rnd() * 0.4}"/>`);
    else out.push(`<path d="M${cx} ${cy} q 14 -18 28 0 t 28 0" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" transform="rotate(${rot} ${cx} ${cy})" opacity=".7"/>`);
  }
  return out.join('');
}

/** A photo cut to a rounded rectangle or circle, as an overlay. */
export async function photoLayer(bytes: Buffer, w: number, h: number, radius: number): Promise<Buffer> {
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}"/></svg>`);
  return sharp(bytes, { failOn: 'none' }).rotate().resize(w, h, { fit: 'cover', position: 'attention' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

export interface Canvas { w: number; h: number; bg?: Buffer | null }
/**
 * Puts it together: the owner's background (if they uploaded one for this card) or the drawn one, the shapes,
 * then photos on top. JPEG for cards (light on data), PNG or WebP when asked.
 */
export async function compose(c: Canvas, drawnBg: string, body: string, layers: OverlayOptions[] = [], format: 'jpeg' | 'png' | 'webp' = 'jpeg', top = ''): Promise<Buffer> {
  const svgBody = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${c.w}" height="${c.h}">${c.bg ? '' : drawnBg}${body}</svg>`);
  let base = c.bg
    ? sharp(await sharp(c.bg, { failOn: 'none' }).rotate().resize(c.w, c.h, { fit: 'cover' }).png().toBuffer()).composite([{ input: svgBody }, ...layers])
    : sharp(svgBody).composite(layers);
  if (top) base = sharp(await base.png().toBuffer()).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${c.w}" height="${c.h}">${top}</svg>`) }]);
  if (format === 'png') return base.png({ compressionLevel: 9 }).toBuffer();
  if (format === 'webp') return base.webp({ quality: 90 }).toBuffer();
  return base.jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

export const svgEsc = esc;
export const assetPath = (...p: string[]) => join(ROOT, ...p);
export const readAsset = (...p: string[]) => readFileSync(join(ROOT, ...p));
