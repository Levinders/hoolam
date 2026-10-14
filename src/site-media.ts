import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Db } from './db.js';
import { homeVersions, isHomeVersion } from './site-versions.js';

/**
 * Images staff set from Console → Settings: the logo, the logo icon, and the website's pictures.
 * Slots are named by position (section 1, image 1…) rather than by what a section says today, so the
 * website's words can change without renaming anything. An empty slot shows the website's own drawing.
 * Brand slots (logo, mark) are shared. Website slots belong to one home page version: stored as "<slot>@<version>".
 */
export interface SlotDef {
  key: string;
  group: 'brand' | 'website';
  section?: number;      // website sections, top to bottom
  label: string;
  hint: string;          // where it shows, in plain words
  aspect: string;        // how the website crops it (CSS aspect-ratio)
  round?: boolean;       // shown as a circle
  maxWidth: number;      // stored size (bigger uploads are scaled down)
  svg?: boolean;         // SVG allowed (logos)
}

export const SLOTS: SlotDef[] = [
  { key: 'mark', group: 'brand', label: 'Logo icon', hint: 'The square symbol on its own, without the name (the name "Hoolam" is written next to it as text). Shows in the website\'s top bar and footer, the browser tab, the live chat, the money step, and the console.', aspect: '1 / 1', maxWidth: 512, svg: true },

  { key: 's1-1', group: 'website', section: 1, label: 'Image 1', hint: 'Round photo on the left of the deal card.', aspect: '1 / 1', round: true, maxWidth: 480 },
  { key: 's1-2', group: 'website', section: 1, label: 'Image 2', hint: 'Round photo on the right of the deal card.', aspect: '1 / 1', round: true, maxWidth: 480 },

  { key: 's2-1', group: 'website', section: 2, label: 'Image 1', hint: 'First of the two pictures side by side.', aspect: '9 / 7', maxWidth: 1400 },
  { key: 's2-2', group: 'website', section: 2, label: 'Image 2', hint: 'Second of the two pictures side by side.', aspect: '9 / 7', maxWidth: 1400 },

  { key: 's3-1', group: 'website', section: 3, label: 'Step 1', hint: 'Picture for step 1.', aspect: '5 / 4', maxWidth: 1400 },
  { key: 's3-3', group: 'website', section: 3, label: 'Step 3', hint: 'Picture for step 3.', aspect: '5 / 4', maxWidth: 1400 },
  { key: 's3-4', group: 'website', section: 3, label: 'Step 4', hint: 'Picture for step 4.', aspect: '5 / 4', maxWidth: 1400 },
  { key: 's3-5', group: 'website', section: 3, label: 'Step 5', hint: 'Picture for step 5.', aspect: '5 / 4', maxWidth: 1400 },

  { key: 's4-1', group: 'website', section: 4, label: 'Image 1', hint: 'Picture at the top of the seller card.', aspect: '5 / 3', maxWidth: 1000 },

  { key: 's5-1', group: 'website', section: 5, label: 'Person 1', hint: 'Small round photo beside the first quote.', aspect: '1 / 1', round: true, maxWidth: 320 },
  { key: 's5-2', group: 'website', section: 5, label: 'Person 2', hint: 'Small round photo beside the second quote.', aspect: '1 / 1', round: true, maxWidth: 320 },
  { key: 's5-3', group: 'website', section: 5, label: 'Person 3', hint: 'Small round photo beside the third quote.', aspect: '1 / 1', round: true, maxWidth: 320 },
];

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export class MediaError extends Error {}

export interface MediaInfo { slot: string; mime: string; sha256: string; width: number | null; height: number | null; sizeBytes: number; originalName: string | null; updatedAt: string; updatedBy: string | null }

export class SiteMedia {
  private versions = new Map<string, string>();     // slot → short hash, for cache-busting URLs
  private cache = new Map<string, { mime: string; bytes: Buffer }>();

  constructor(private readonly db: Db) {}

  async load(): Promise<void> {
    // a new home page version starts with a copy of the pictures of the version it came from
    for (const v of homeVersions()) {
      if (!v.from) continue;
      const has = await this.db.query(`SELECT 1 FROM media WHERE slot LIKE $1 LIMIT 1`, [`%@${v.version}`]);
      if (has.rowCount) continue;
      await this.db.query(
        `INSERT INTO media (slot, mime, bytes, sha256, width, height, size_bytes, original_name, updated_by, updated_at)
         SELECT split_part(slot, '@', 1) || '@' || $2, mime, bytes, sha256, width, height, size_bytes, original_name, updated_by, updated_at
         FROM media WHERE slot LIKE $1 ON CONFLICT (slot) DO NOTHING`, [`%@${v.from}`, v.version]);
    }
    const r = await this.db.query('SELECT slot, sha256 FROM media');
    this.versions = new Map(r.rows.map((x) => [x.slot, String(x.sha256).slice(0, 12)]));
    this.cache.clear();
  }

  /** The spot for a stored key: "mark", or "<website spot>@<version>". */
  slot(key: string): SlotDef {
    const [base, version] = key.split('@');
    const s = SLOTS.find((x) => x.key === base);
    if (!s) throw new MediaError('That image spot doesn\'t exist.');
    if (s.group === 'website' ? !isHomeVersion(version) : version !== undefined) throw new MediaError('That image spot doesn\'t exist.');
    return s;
  }

  /** The stored key for a spot on one home page version (brand spots are shared). */
  static key(slot: string, version: string): string {
    return SLOTS.find((x) => x.key === slot)?.group === 'brand' ? slot : `${slot}@${version}`;
  }

  /** Every image one home page version shows, by spot (brand included): spot → { url, v }. */
  forVersion(base: string, version: string): Record<string, { url: string; v: string }> {
    const out: Record<string, { url: string; v: string }> = {};
    for (const s of SLOTS) {
      const key = SiteMedia.key(s.key, version);
      const url = this.url(base, key);
      if (url) out[s.key] = { url, v: this.versions.get(key)! };
    }
    return out;
  }

  /** slot → short version, for every slot that has an image */
  current(): Record<string, string> { return Object.fromEntries(this.versions); }
  url(base: string, key: string): string | null {
    const v = this.versions.get(key);
    return v ? `${base.replace(/\/+$/, '')}/media/${key}?v=${v}` : null;
  }

  async list(version?: string): Promise<MediaInfo[]> {
    const keys = version ? SLOTS.map((s) => SiteMedia.key(s.key, version)) : null;
    const r = await this.db.query(`SELECT m.slot, m.mime, m.sha256, m.width, m.height, m.size_bytes, m.original_name, m.updated_at, s.name AS updated_by
      FROM media m LEFT JOIN staff s ON s.id=m.updated_by${keys ? ' WHERE m.slot = ANY($1)' : ''}`, keys ? [keys] : []);
    return r.rows.map((x) => ({ slot: String(x.slot).split('@')[0]!, mime: x.mime, sha256: x.sha256, width: x.width, height: x.height, sizeBytes: x.size_bytes, originalName: x.original_name, updatedAt: x.updated_at, updatedBy: x.updated_by }));
  }

  async get(key: string): Promise<{ mime: string; bytes: Buffer } | null> {
    if (!this.versions.has(key)) return null;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = await this.db.query('SELECT mime, bytes FROM media WHERE slot=$1', [key]);
    if (!r.rows[0]) return null;
    const v = { mime: r.rows[0].mime as string, bytes: r.rows[0].bytes as Buffer };
    this.cache.set(key, v);
    return v;
  }

  /** Checks and stores an upload. Photos are turned upright, scaled down and saved as WebP (much smaller on phones). */
  async put(key: string, input: Buffer, staffId: string | null, originalName: string | null): Promise<MediaInfo> {
    const def = this.slot(key);
    if (!input.length) throw new MediaError('The file is empty.');
    if (input.length > MAX_UPLOAD_BYTES) throw new MediaError('That file is over 12 MB. Please use a smaller image.');

    let out: { mime: string; bytes: Buffer; width: number | null; height: number | null };
    const head = input.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
      if (!def.svg) throw new MediaError('Use a photo (JPG, PNG or WebP) here. SVG is for logos.');
      out = { mime: 'image/svg+xml', bytes: checkSvg(input), width: null, height: null };
    } else {
      let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
      try { meta = await sharp(input).metadata(); } catch { throw new MediaError('That file isn\'t an image we can read. Use JPG, PNG or WebP.'); }
      if (meta.format === 'heif') throw new MediaError('iPhone HEIC photos can\'t be used. Send it as a JPG instead (or share it to yourself on WhatsApp first).');
      if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff'].includes(String(meta.format))) throw new MediaError('Use a JPG, PNG or WebP image.');
      const { data, info } = await sharp(input, { animated: false }).rotate()
        .resize({ width: def.maxWidth, height: def.maxWidth * 2, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, alphaQuality: 90, effort: 4 }).toBuffer({ resolveWithObject: true });
      out = { mime: 'image/webp', bytes: data, width: info.width, height: info.height };
    }
    const sha = createHash('sha256').update(out.bytes).digest('hex');
    await this.db.query(
      `INSERT INTO media (slot, mime, bytes, sha256, width, height, size_bytes, original_name, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (slot) DO UPDATE SET mime=EXCLUDED.mime, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, width=EXCLUDED.width, height=EXCLUDED.height,
         size_bytes=EXCLUDED.size_bytes, original_name=EXCLUDED.original_name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [key, out.mime, out.bytes, sha, out.width, out.height, out.bytes.length, originalName?.slice(0, 200) ?? null, staffId]);
    this.versions.set(key, sha.slice(0, 12));
    this.cache.set(key, { mime: out.mime, bytes: out.bytes });
    return { slot: key, mime: out.mime, sha256: sha, width: out.width, height: out.height, sizeBytes: out.bytes.length, originalName, updatedAt: new Date().toISOString(), updatedBy: null };
  }

  async remove(key: string): Promise<boolean> {
    this.slot(key);
    const r = await this.db.query('DELETE FROM media WHERE slot=$1', [key]);
    this.versions.delete(key);
    this.cache.delete(key);
    return (r.rowCount ?? 0) > 0;
  }
}

/** SVG logos are shown as images (which never run scripts), but we still refuse anything that could act like a web page. */
function checkSvg(buf: Buffer): Buffer {
  if (buf.length > 1024 * 1024) throw new MediaError('SVG logos must be under 1 MB.');
  const s = buf.toString('utf8');
  if (/<script|<foreignobject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object|xlink:href\s*=\s*["']\s*(?!#|data:image)/i.test(s)) {
    throw new MediaError('This SVG has scripts or links in it. Export a plain SVG, or use a PNG.');
  }
  return buf;
}
