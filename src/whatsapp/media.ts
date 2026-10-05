import { createHash } from 'node:crypto';

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

const MAX_BYTES = 5 * 1024 * 1024; // WhatsApp's image limit

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
    const bytes = Buffer.from(await file.arrayBuffer());
    return { bytes, mimeType: info.mime_type ?? 'image/jpeg', sha256: createHash('sha256').update(bytes).digest('hex') };
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
