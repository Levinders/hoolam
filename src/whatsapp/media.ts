import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Moves photos in and out of WhatsApp.
 *  - download: an id WhatsApp gave us (chat photo or form photo) → the bytes. Inbound ids last about 7 days.
 *  - upload: bytes → an id we can send in an image message. Our uploads last 30 days.
 * In dry-run mode nothing leaves the machine: downloads return null and uploads return a fake id.
 */
export interface MediaOptions {
  dryRun: boolean;
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

export interface Downloaded { bytes: Buffer; mimeType: string; sha256: string }

const MAX_BYTES = 25 * 1024 * 1024; // the most a WhatsApp form lets someone pick (gallery photos are often 5–12 MB)
const SEND_LIMIT = 5 * 1024 * 1024; // the most WhatsApp lets us send back as an image
const LONG_SIDE = 1600;            // plenty to see an item clearly, and a few hundred KB

/** Phone photos straight from the gallery are big: turn them upright and shrink them to a clear, light JPEG. */
export async function shrinkPhoto(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!mimeType.startsWith('image/')) return { bytes, mimeType };
  try {
    const out = await sharp(bytes, { failOn: 'none' }).rotate()
      .resize(LONG_SIDE, LONG_SIDE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return out.length < bytes.length || bytes.length > SEND_LIMIT ? { bytes: out, mimeType: 'image/jpeg' } : { bytes, mimeType };
  } catch {
    if (bytes.length > SEND_LIMIT) throw new Error('photo too big and could not be shrunk');
    return { bytes, mimeType }; // a format we can't read: keep it as it came
  }
}

export class Media {
  private readonly fetch: typeof fetch;
  constructor(private readonly o: MediaOptions) { this.fetch = o.fetchImpl ?? fetch; }

  private get base() { return `https://graph.facebook.com/${this.o.graphVersion}`; }
  private get auth() { return { Authorization: `Bearer ${this.o.token}` }; }

  async download(mediaId: string): Promise<Downloaded | null> {
    if (this.o.dryRun) return null;
    const meta = await this.fetch(`${this.base}/${encodeURIComponent(mediaId)}`, { headers: this.auth });
    if (!meta.ok) throw new Error(`media ${mediaId}: HTTP ${meta.status}: ${(await meta.text()).slice(0, 200)}`);
    const info = (await meta.json()) as { url: string; mime_type?: string; file_size?: number };
    if (info.file_size && info.file_size > MAX_BYTES) throw new Error(`media ${mediaId} is too big (${info.file_size} bytes)`);
    const file = await this.fetch(info.url, { headers: this.auth }); // the URL only works for ~5 minutes, with the token
    if (!file.ok) throw new Error(`media ${mediaId} download: HTTP ${file.status}`);
    const photo = await shrinkPhoto(Buffer.from(await file.arrayBuffer()), info.mime_type ?? 'image/jpeg');
    return { bytes: photo.bytes, mimeType: photo.mimeType, sha256: createHash('sha256').update(photo.bytes).digest('hex') };
  }

  async upload(bytes: Buffer | null, mimeType: string): Promise<string> {
    if (this.o.dryRun || !bytes) return 'dry-run-media';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType === 'image/png' ? 'photo.png' : 'photo.jpg');
    const res = await this.fetch(`${this.base}/${this.o.phoneNumberId}/media`, { method: 'POST', headers: this.auth, body: form });
    if (!res.ok) throw new Error(`media upload: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { id: string }).id;
  }
}
