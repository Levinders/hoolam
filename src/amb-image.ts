import opentype from 'opentype.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';

/**
 * An ambassador's share picture (1080×1080), for statuses and flyers: their photo (or their initial), "Tobi invited
 * you to Hoolam", one line on what Hoolam is, and their link. Text is drawn from the fonts in assets/fonts, so it
 * looks the same on every server.
 */
const FONTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
let f: { inter: opentype.Font; semi: opentype.Font; brand: opentype.Font } | null = null;
const fonts = () => (f ??= {
  inter: opentype.loadSync(join(FONTS, 'Inter-Regular.otf')),
  semi: opentype.loadSync(join(FONTS, 'Inter-SemiBold.otf')),
  brand: opentype.loadSync(join(FONTS, 'Poppins-Bold.ttf')),
});
const C = { teal: '#0E5C63', tealDark: '#083E43', gold: '#C9992E', ink: '#17292B', cream: '#F7F3EC', white: '#FFFFFF', soft: '#CFE3E1' };
const W = 1080;

function text(font: opentype.Font, s: string, x: number, y: number, size: number, fill: string, align: 'left' | 'center' = 'center') {
  const w = font.getAdvanceWidth(s, size);
  return `<path d="${font.getPath(s, align === 'center' ? x - w / 2 : x, y, size).toPathData(2)}" fill="${fill}"/>`;
}
function fit(font: opentype.Font, s: string, size: number, max: number): number {
  let n = size;
  while (n > 24 && font.getAdvanceWidth(s, n) > max) n -= 2;
  return n;
}
function wrap(font: opentype.Font, s: string, size: number, max: number): string[] {
  const out: string[] = []; let line = '';
  for (const w of s.split(/\s+/)) { const next = line ? `${line} ${w}` : w; if (font.getAdvanceWidth(next, size) <= max || !line) line = next; else { out.push(line); line = w; } }
  if (line) out.push(line);
  return out;
}

const cache = new Map<string, Buffer>();

export async function ambassadorCard(key: string, o: { firstName: string; link: string; area?: string | null; photo: Buffer | null }): Promise<Buffer> {
  const hit = cache.get(key);
  if (hit) return hit;
  const { inter, semi, brand } = fonts();
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${W}" fill="${C.teal}"/>`);
  parts.push(`<circle cx="${W - 90}" cy="90" r="260" fill="${C.tealDark}" opacity=".55"/><circle cx="60" cy="${W - 40}" r="200" fill="${C.tealDark}" opacity=".45"/>`);
  // the photo ring
  const R = 170, cx = W / 2, cy = 300;
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${R + 14}" fill="${C.gold}"/>`);
  if (!o.photo) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${C.cream}"/>`);
    parts.push(text(brand, (o.firstName[0] ?? 'H').toUpperCase(), cx, cy + 62, 170, C.teal));
  }
  const name = o.firstName || 'Your friend';
  const head = `${name} invited you to Hoolam`;
  const hs = fit(brand, head, 66, W - 140);
  parts.push(text(brand, head, cx, 580, hs, C.white));
  if (o.area) parts.push(text(semi, `Verified Hoolam ambassador · ${o.area}`.slice(0, 60), cx, 640, 30, C.gold));
  else parts.push(text(semi, 'Verified Hoolam ambassador', cx, 640, 30, C.gold));
  const lines = wrap(inter, 'Buy and sell on WhatsApp safely. Your money is held until you get what you ordered.', 36, W - 220);
  lines.forEach((l, i) => parts.push(text(inter, l, cx, 730 + i * 50, 36, C.soft)));
  // the link pill
  const ls = fit(semi, o.link, 40, W - 260);
  const lw = semi.getAdvanceWidth(o.link, ls) + 90;
  parts.push(`<rect x="${cx - lw / 2}" y="${880}" width="${lw}" height="84" rx="42" fill="${C.gold}"/>`);
  parts.push(text(semi, o.link, cx, 936, ls, C.ink));
  // the mark
  parts.push(`<g transform="translate(${cx - 120} 1000) scale(1.4)"><circle cx="12" cy="8.5" r="3.7" fill="${C.gold}"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g>`);
  parts.push(text(brand, 'Hoolam', cx - 80, 1035, 38, C.white, 'left'));
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">${parts.join('')}</svg>`);
  const layers: OverlayOptions[] = [];
  if (o.photo) {
    const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${R * 2}" height="${R * 2}"><circle cx="${R}" cy="${R}" r="${R}"/></svg>`);
    const p = await sharp(o.photo).resize(R * 2, R * 2, { fit: 'cover' }).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
    layers.push({ input: p, left: cx - R, top: cy - R });
  }
  const out = await sharp(svg).composite(layers).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}
