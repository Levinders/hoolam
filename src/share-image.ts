import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * The picture WhatsApp, Instagram and others show when a seller's link is shared:
 * the Hoolam card with the seller's photo in the gold circle (or the Hoolam symbol if they have none).
 * The card's words are drawn once, in assets/share-seller.png; only the photo is added here, so no fonts are needed.
 */
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const BASE = readFileSync(join(ASSETS, 'share-seller.png'));
const DEFAULT_MARK = readFileSync(join(ASSETS, '..', 'site', 'assets', 'favicon.svg'));
const SLOT = { left: 450, top: 76, size: 300 };

const cache = new Map<string, Buffer>();

export async function sellerShareImage(key: string, photo: Buffer | null, mark: Buffer | null): Promise<Buffer> {
  const hit = cache.get(key);
  if (hit) return hit;
  const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SLOT.size}" height="${SLOT.size}"><circle cx="${SLOT.size / 2}" cy="${SLOT.size / 2}" r="${SLOT.size / 2}"/></svg>`);
  let layer: Buffer;
  if (photo) {
    layer = await sharp(photo).resize(SLOT.size, SLOT.size, { fit: 'cover' }).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
  } else {
    const icon = await sharp(mark ?? DEFAULT_MARK, { density: 300 }).resize(150, 150, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    layer = await sharp({ create: { width: SLOT.size, height: SLOT.size, channels: 4, background: { r: 10, g: 65, b: 70, alpha: 1 } } })
      .composite([{ input: icon, gravity: 'centre' }, { input: circle, blend: 'dest-in' }]).png().toBuffer();
  }
  const out = await sharp(BASE).composite([{ input: layer, left: SLOT.left, top: SLOT.top }]).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}
