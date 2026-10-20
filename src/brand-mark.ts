import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * The logo icon in every picture Hoolam draws (chat cards, receipts, the ambassador share card): the one uploaded in
 * Console → Settings → Brand → Logo icon, or the drawn mark when there is none.
 * Pictures are drawn as SVG, so the uploaded icon goes in as an embedded PNG. It's read again at most once a minute,
 * so a new upload shows within a minute everywhere.
 */
type Source = () => Promise<{ mime: string; bytes: Buffer } | null>;
let source: Source | null = null;
let uri: string | null = null;
let key = 'drawn';
let checkedAt = 0;
let lastSha = '';

/** Where the uploaded icon comes from (app.ts points it at the site media store). */
export function setMarkSource(s: Source | null): void { source = s; checkedAt = 0; }

/** Reads the uploaded icon if it may have changed. Never throws: a problem just keeps the last one (or the drawing). */
export async function refreshMark(force = false): Promise<void> {
  if (!source) { uri = null; key = 'drawn'; return; }
  if (!force && Date.now() - checkedAt < 60_000) return;
  checkedAt = Date.now();
  try {
    const m = await source();
    if (!m) { uri = null; key = 'drawn'; lastSha = ''; return; }
    const sha = createHash('sha256').update(m.bytes).digest('hex');
    if (sha === lastSha && uri) return;
    const png = await sharp(m.bytes, { density: 300 }).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    uri = `data:image/png;base64,${png.toString('base64')}`;
    key = sha.slice(0, 12);
    lastSha = sha;
  } catch { /* keep what we had */ }
}

/** The uploaded icon as an SVG <image> at (x, y), `size` square, or null when there is none (draw the mark). */
export function markImage(x: number, y: number, size: number): string | null {
  return uri ? `<image href="${uri}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>` : null;
}

/** Changes when the icon changes: part of every cached picture's key. */
export const markKey = () => key;
