import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Queryable } from '../db.js';
import type { Media } from '../whatsapp/media.js';
import * as K from './cards.js';
import { ambassadorCard } from '../amb-image.js';
import { markKey, refreshMark } from '../brand-mark.js';
import { ACCEPT, MAX_BYTES, slot as slotOf, SLOTS, type Slot } from './slots.js';

/**
 * The chat's pictures, voice notes, videos and stickers: draws them, keeps the owner's replacements, uploads them to
 * WhatsApp once (ids are reused for 25 days), and remembers "first time only" moments.
 * Messages ask for art by name (`{ card: 'moneyHeld', data }`, `{ picture: 'how-it-works' }`); the Messenger turns
 * that into a picture on top of the message just before it goes. In dry run (tests, no WhatsApp) nothing is drawn.
 */
export type CardName = 'moneyHeld' | 'payment' | 'handover' | 'paid' | 'refund' | 'frozen' | 'summary' | 'trust' | 'trustStatus' | 'complete' | 'fees' | 'ambMonth' | 'ambWelcome' | 'ambShare' | 'formCheck' | 'formStatus' | 'orderRequest' | 'marketItem' | 'myItems' | 'marketPhoto';
export type PhotoRef = { photoDeal?: string | null; photoUser?: string | null; photoAmb?: string | null; photoBytes?: Buffer | null; photoListing?: number | null; photoPosition?: number | null; sellerUser?: string | null };
export type Art = { card: CardName; data: Record<string, unknown> & PhotoRef } | { picture: string };
export interface Clip { slot: string; once?: boolean }

const CARD_SLOT: Partial<Record<CardName, string>> = { // the ambassador share card has its own design (their link page's picture)
  moneyHeld: 'card-money-held', payment: 'card-payment', handover: 'card-handover', paid: 'card-paid', refund: 'card-refund',
  frozen: 'card-frozen', summary: 'card-summary', trust: 'card-trust', trustStatus: 'card-trust-status', complete: 'card-complete',
  fees: 'card-fees', ambMonth: 'card-amb-month', ambWelcome: 'card-amb-welcome', formCheck: 'card-form-check', formStatus: 'card-form-status', orderRequest: 'card-new-order', marketItem: 'card-market-item', myItems: 'card-market-myitems',
};
const STICKER_SLOT = { held: 'sticker-held', paid: 'sticker-paid', welldone: 'sticker-welldone', thanks: 'sticker-thanks', verified: 'sticker-verified' } as const;
export type StickerName = keyof typeof STICKER_SLOT;
const AUDIO_MIME: Record<string, string> = { 'audio/opus': 'audio/ogg', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4' };

/** What each live card looks like with made-up data, for the console preview. */
const SAMPLE: Record<CardName, Record<string, unknown>> = {
  moneyHeld: { side: 'buyer', amount: '₦15,300', code: 'HL-7K2QF', other: 'Kemi' },
  payment: { amount: '₦15,300', accountNumber: '5000123456', bankName: 'Moniepoint Microfinance Bank', accountName: 'Hoolam / HL-7K2QF', validUntil: '3:45 PM today', code: 'HL-7K2QF' },
  handover: { digits: '4821', code: 'HL-7K2QF', to: 'rider' },
  paid: { state: 'paid', amount: '₦14,500', bank: 'GTBank ••••1234', code: 'HL-7K2QF' },
  refund: { amount: '₦15,300', bank: 'GTBank ••••1234', code: 'HL-7K2QF' },
  frozen: { side: 'buyer', amount: '₦15,300', code: 'HL-7K2QF', hours: 24 },
  summary: { side: 'buyer', code: 'HL-7K2QF', title: 'Check your order', item: 'Brazilian wig, 18 inch', lines: [{ icon: 'store', text: 'Seller: Kemi\'s Wigs' }, { icon: 'mapPin', text: '12 Woji Road, Port Harcourt' }], big: { label: 'Total price', value: '₦15,000' }, note: 'Nothing to pay yet. You pay after the seller accepts.' },
  trust: { name: 'Kemi\'s Wigs', city: 'Port Harcourt', since: 'Oct 2026', verified: true, isNew: false, completed: 48, happyPct: 96, rated: 30, ships: 'Same day' },
  trustStatus: { name: 'Kemi\'s Wigs', city: 'Port Harcourt', verified: true, isNew: false, completed: 48, happyPct: 96, rated: 30, link: 'go.hoolam.com/s/kemiswigs' },
  complete: { item: 'Brazilian wig, 18 inch', n: 3, other: 'Kemi' },
  fees: { rows: [{ price: '₦5,000', hoolam: '₦300', txn: '₦500' }, { price: '₦15,000', hoolam: '₦400', txn: '₦500' }, { price: '₦50,000', hoolam: '₦1,300', txn: '₦500' }] },
  ambMonth: { name: 'Tobi', month: 'October', amount: '₦8,200', bars: [{ label: 'May', value: 1200 }, { label: 'Jun', value: 2400 }, { label: 'Jul', value: 1800 }, { label: 'Aug', value: 4100 }, { label: 'Sep', value: 6000 }, { label: 'Oct', value: 8200 }], people: 14, activeSellers: 5 },
  ambWelcome: { name: 'Tobi', link: 'hoolam.com/a/tobi' },
  ambShare: { firstName: 'Tobi', link: 'hoolam.com/a/tobi', area: 'UNILAG' },
  formCheck: { side: 'buyer', title: 'Check your order', item: 'Brazilian wig, 18 inch', lines: [{ icon: 'store', text: 'Seller: 0803 123 4567' }, { icon: 'mapPin', text: '12 Woji Road, Port Harcourt' }], big: { label: 'You pay after they accept', value: '₦15,400' }, note: 'Nothing is paid yet. You pay after the seller accepts.' },
  marketItem: { title: 'Nike Air Force 1, size 43', price: '₦45,000', was: '₦50,000', offPct: 10, verified: true, where: 'Woji · Pickup, rider, waybill', seller: 'Bayo Kicks', record: '120 orders · 98% happy' },
  marketPhoto: {},
  myItems: { name: 'Bayo Kicks', live: 5, soldOut: 1, views: 128 },
  orderRequest: { to: 'seller', who: 'Ada', item: 'Brazilian wig, 18 inch', amount: '₦14,500', code: 'HL-7K2QF', check: 'hoolam.com/check' },
  formStatus: { step: 3, title: 'Money held', item: 'Brazilian wig, 18 inch', code: 'HL-7K2QF', amountLabel: 'You paid', amount: '₦15,400', money: 'Held safely by Hoolam' },
};

export interface ChatArtOptions {
  media: Media;
  dryRun: boolean;
  log?: (line: string) => void;
  /** Live values some fixed pictures show: Hoolam's number, the ambassador shares. */
  live?: { number?: () => string | null; ambShares?: () => { seller: string; buyer: string; bonus: string } };
}

export class ChatArt {
  private readonly drawn = new Map<string, Buffer>();
  constructor(private readonly db: Queryable, private readonly o: ChatArtOptions) {}

  // ---------------------------------------------------------------------------------------------
  // drawing

  private async override(slot: string): Promise<{ mime: string; bytes: Buffer } | null> {
    const r = await this.db.query('SELECT mime, bytes FROM wa_media WHERE slot=$1', [slot]);
    return r.rows[0] ? { mime: r.rows[0].mime, bytes: r.rows[0].bytes } : null;
  }

  private async photo(ref: PhotoRef): Promise<Buffer | null> {
    if (ref.photoDeal) {
      const r = await this.db.query(`SELECT bytes FROM deal_photos WHERE deal_id=$1 AND kind='ITEM' AND bytes IS NOT NULL ORDER BY id LIMIT 1`, [ref.photoDeal]);
      if (r.rows[0]?.bytes) return r.rows[0].bytes;
    }
    if (ref.photoAmb) {
      const r = await this.db.query('SELECT bytes FROM ambassador_photos WHERE user_id=$1', [ref.photoAmb]);
      if (r.rows[0]?.bytes) return r.rows[0].bytes;
    }
    if (ref.photoUser) {
      const r = await this.db.query('SELECT bytes FROM user_photos WHERE user_id=$1', [ref.photoUser]);
      if (r.rows[0]?.bytes) return r.rows[0].bytes;
    }
    return null;
  }

  /** The picture for a fixed slot: the owner's, or Hoolam's own. */
  private async picture(id: string): Promise<Buffer> {
    const own = await this.override(id);
    if (own) return own.bytes;
    await refreshMark();
    const key = `p:${id}:${markKey()}:${id === 'real-hoolam' ? this.o.live?.number?.() ?? '' : ''}:${id === 'amb-intro' ? JSON.stringify(this.o.live?.ambShares?.() ?? {}) : ''}`;
    const hit = this.drawn.get(key);
    if (hit) return hit;
    const st = /^status-([1-6])$/.exec(id);
    const b = st ? await K.status(Number(st[1]))
      : id === 'how-it-works' ? await K.howItWorks()
      : id === 'id-check' || id === 'form-id' ? await K.idCheck()
      : id === 'form-start' ? await K.formStart()
      : id === 'market-where' ? await K.marketWhere()
      : id === 'code-where' ? await K.codeWhere()
      : id === 'sample-trust' ? await K.trustCard({ name: 'Bayo Kicks', city: 'Lagos', since: 'Jan 2026', verified: true, isNew: false, completed: 120, happyPct: 98, rated: 80, ships: 'In 1 day', sample: true })
      : id === 'photo-tips' ? await K.photoTips()
      : id === 'real-hoolam' ? await K.realHoolam({ number: this.o.live?.number?.() ?? null })
      : id === 'rider' ? await K.rider()
      : id === 'amb-intro' ? await K.ambIntro(this.o.live?.ambShares?.() ?? { seller: '20%', buyer: '10%', bonus: '₦1,000' })
      : null;
    if (!b) throw new Error(`no picture called ${id}`);
    this.drawn.set(key, b);
    return b;
  }

  /** A live card with this order's data (and the owner's background, if they uploaded one). */
  private async card(name: CardName, data: Record<string, unknown> & PhotoRef): Promise<Buffer> {
    await refreshMark(); // the uploaded logo icon (or the drawn mark)
    const bg = CARD_SLOT[name] ? (await this.override(CARD_SLOT[name]!))?.bytes ?? null : null;
    const photo = data.photoBytes ?? (data.photoListing ? (await this.db.query('SELECT bytes FROM market_photos WHERE listing_id=$1 ORDER BY position OFFSET $2 LIMIT 1', [data.photoListing, data.photoPosition ?? 0])).rows[0]?.bytes ?? null
      : data.photoDeal || data.photoUser || data.photoAmb ? await this.photo(data) : null);
    const sellerPhoto = data.sellerUser ? (await this.db.query('SELECT bytes FROM user_photos WHERE user_id=$1', [data.sellerUser])).rows[0]?.bytes ?? null : null;
    const d = { ...data, photoBytes: undefined, photo, sellerPhoto } as any;
    switch (name) {
      case 'moneyHeld': return K.moneyHeld(d, bg);
      case 'payment': return K.payment(d, bg);
      case 'handover': return K.handover(d, bg);
      case 'paid': return K.paid(d, bg);
      case 'refund': return K.refund(d, bg);
      case 'frozen': return K.frozen(d, bg);
      case 'summary': case 'formCheck': return K.summary(d, bg);
      case 'formStatus': return K.orderStatus(d, bg);
      case 'orderRequest': return K.orderRequest(d, bg);
      case 'marketItem': return K.marketItem(d, bg);
      case 'myItems': return K.myItems(d, bg);
      case 'marketPhoto': return photo ? sharp(photo).rotate().resize(1080, 1080, { fit: 'cover' }).jpeg({ quality: 86 }).toBuffer() : K.marketItem({ title: 'Photo', price: '', where: '', seller: '', record: '' } as any, null);
      case 'trust': return K.trustCard(d, bg);
      case 'trustStatus': return K.trustStatus(d, bg);
      case 'complete': return K.complete(d, bg);
      case 'fees': return K.fees(d, bg);
      case 'ambMonth': return K.ambMonth(d, bg);
      case 'ambWelcome': return K.ambWelcome(d, bg);
      case 'ambShare': return ambassadorCard(`chat:${d.link}:${photo ? createHash('sha256').update(photo).digest('hex').slice(0, 12) : ''}`, { firstName: d.firstName, link: d.link, area: d.area, photo });
    }
  }

  /**
   * A picture for inside a WhatsApp form: small and light (forms carry their pictures inline, ~300 KB at most),
   * as base64 JPEG. Null if it can't be drawn (the form then shows no picture).
   */
  async formImage(art: Art, width = 800): Promise<string | null> {
    try {
      const { bytes } = await this.render(art);
      const key = 'f:' + createHash('sha256').update(bytes).digest('hex') + ':' + width;
      const hit = this.drawn.get(key);
      if (hit) return hit.toString('base64');
      let out = await sharp(bytes).resize(width, null, { withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
      if (out.length > 200_000) out = await sharp(bytes).resize(Math.round(width * 0.75), null).jpeg({ quality: 60, mozjpeg: true }).toBuffer();
      if (this.drawn.size > 300) this.drawn.clear();
      this.drawn.set(key, out);
      return out.toString('base64');
    } catch (e) {
      this.o.log?.(`form picture ${'card' in art ? art.card : art.picture} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async render(art: Art): Promise<{ bytes: Buffer; mime: string }> {
    const bytes = 'card' in art ? await this.card(art.card, art.data) : await this.picture(art.picture);
    return { bytes, mime: 'image/jpeg' };
  }

  private async stickerBytes(name: StickerName): Promise<Buffer> {
    const own = await this.override(STICKER_SLOT[name]);
    if (own) return own.bytes;
    const key = `s:${name}`;
    const hit = this.drawn.get(key);
    if (hit) return hit;
    const b = await K.sticker(name);
    this.drawn.set(key, b);
    return b;
  }

  // ---------------------------------------------------------------------------------------------
  // sending (the Messenger calls these)

  /** Uploads to WhatsApp once per file; the id is reused for 25 days. */
  private async upload(bytes: Buffer, mime: string): Promise<string> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const hit = await this.db.query(`SELECT media_id FROM wa_media_ids WHERE sha256=$1 AND uploaded_at > now() - interval '25 days'`, [sha]);
    if (hit.rows[0]) return hit.rows[0].media_id;
    const id = await this.o.media.upload(bytes, mime);
    await this.db.query(`INSERT INTO wa_media_ids (sha256, media_id) VALUES ($1,$2) ON CONFLICT (sha256) DO UPDATE SET media_id=EXCLUDED.media_id, uploaded_at=now()`, [sha, id]);
    return id;
  }

  /** A WhatsApp media id for this picture, or null if it couldn't be made (the message then goes without it). */
  async image(art: Art): Promise<string | null> {
    if (this.o.dryRun) return 'dry-run-media';
    try {
      const r = await this.render(art);
      return await this.upload(r.bytes, r.mime);
    } catch (e) {
      this.o.log?.(`chat picture ${'card' in art ? art.card : art.picture} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async sticker(name: StickerName): Promise<string | null> {
    if (this.o.dryRun) return 'dry-run-media';
    try { return await this.upload(await this.stickerBytes(name), 'image/webp'); }
    catch (e) { this.o.log?.(`sticker ${name} failed: ${(e as Error).message}`); return null; }
  }

  /** A voice note or video, if the owner has uploaded it (and, for "first time only", if this is the first time). */
  async clip(phone: string, c: Clip): Promise<{ kind: 'audio' | 'video'; id: string } | null> {
    const def = slotOf(c.slot);
    if (!def || (def.kind !== 'voice' && def.kind !== 'video')) return null;
    const own = await this.override(c.slot);
    if (!own) return null;
    if (c.once) {
      const first = await this.db.query('INSERT INTO wa_firsts (phone, moment) VALUES ($1,$2) ON CONFLICT DO NOTHING', [phone, c.slot]);
      if (!first.rowCount) return null;
    }
    const kind = def.kind === 'voice' ? 'audio' : 'video';
    if (this.o.dryRun) return { kind, id: 'dry-run-media' };
    try { return { kind, id: await this.upload(own.bytes, own.mime) }; }
    catch (e) { this.o.log?.(`${def.kind} ${c.slot} failed: ${(e as Error).message}`); return null; }
  }

  /** Has this person reached this moment before? Marks it reached. For "first time only" extras that aren't clips. */
  async firstTime(phone: string, moment: string): Promise<boolean> {
    return ((await this.db.query('INSERT INTO wa_firsts (phone, moment) VALUES ($1,$2) ON CONFLICT DO NOTHING', [phone, moment])).rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------------------------
  // the console

  async list(): Promise<(Slot & { custom: boolean; updatedAt: string | null; fileName: string | null; bytes: number | null; mime: string | null })[]> {
    const r = await this.db.query('SELECT slot, mime, file_name, length(bytes) AS n, updated_at FROM wa_media');
    const by = new Map(r.rows.map((x) => [x.slot as string, x]));
    return SLOTS.map((s) => {
      const x = by.get(s.id);
      return { ...s, custom: !!x, updatedAt: x?.updated_at ?? null, fileName: x?.file_name ?? null, bytes: x ? Number(x.n) : null, mime: x?.mime ?? null };
    });
  }

  /** What the console shows: the picture as it goes out (a card with sample data), or the uploaded file. */
  async preview(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const s = slotOf(id);
    if (!s) return null;
    if (s.kind === 'voice' || s.kind === 'video') return this.override(id);
    if (s.kind === 'sticker') {
      const name = (Object.entries(STICKER_SLOT).find(([, v]) => v === id)?.[0] ?? 'held') as StickerName;
      return { bytes: await this.stickerBytes(name), mime: 'image/webp' };
    }
    if (s.kind === 'card') {
      const name = (Object.entries(CARD_SLOT).find(([, v]) => v === id)?.[0]) as CardName;
      return this.render({ card: name, data: SAMPLE[name] });
    }
    return { bytes: await this.picture(id), mime: (await this.override(id))?.mime ?? 'image/jpeg' };
  }

  /** The owner's replacement. Pictures are tidied (turned upright, sized, compressed); stickers become 512 × 512 WebP. */
  /** Is this file right for this item? Throws a plain-words ChatArtError if not. Returns the file type to store. */
  check(id: string, mimeIn: string, size: number): { slot: Slot; mime: string } {
    const s = slotOf(id);
    if (!s) throw new ChatArtError('Unknown item.');
    let mime = (mimeIn || '').toLowerCase().split(';')[0]!.trim();
    mime = AUDIO_MIME[mime] ?? mime;
    if (!ACCEPT[s.kind].test(mime)) throw new ChatArtError(s.kind === 'voice' ? 'Send an audio file: a WhatsApp voice note (.opus or .ogg), .mp3 or .m4a.'
      : s.kind === 'video' ? 'Send an MP4 video.' : s.kind === 'sticker' ? 'Send a WebP or PNG with a see-through background.' : 'Send a JPEG, PNG or WebP picture.');
    if (size > MAX_BYTES[s.kind]) throw new ChatArtError(`That file is too big. The most is ${Math.round(MAX_BYTES[s.kind] / 1_000_000)} MB.`);
    return { slot: s, mime };
  }

  async put(id: string, input: Buffer, mimeIn: string, fileName: string | null, staffId: string | null): Promise<void> {
    const c = this.check(id, mimeIn, input.length);
    const s = c.slot;
    let mime = c.mime;
    let bytes = input;
    try {
      if (s.kind === 'picture' || s.kind === 'card') {
        bytes = await sharp(input, { failOn: 'none' }).rotate().resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
        mime = 'image/jpeg';
      } else if (s.kind === 'sticker') {
        bytes = await sharp(input, { failOn: 'none' }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90 }).toBuffer();
        mime = 'image/webp';
        if (bytes.length > 100_000) bytes = await sharp(input, { failOn: 'none' }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 70 }).toBuffer();
      }
    } catch { throw new ChatArtError('We couldn\'t read that picture. Try another file.'); }
    const sha = createHash('sha256').update(bytes).digest('hex');
    await this.db.query(
      `INSERT INTO wa_media (slot, mime, bytes, sha256, file_name, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slot) DO UPDATE SET mime=EXCLUDED.mime, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, file_name=EXCLUDED.file_name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [id, mime, bytes, sha, fileName?.slice(0, 120) ?? null, staffId]);
  }

  /** Back to Hoolam's own (pictures, cards, stickers) or nothing (voice, video). */
  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wa_media WHERE slot=$1', [id]);
  }
}

export class ChatArtError extends Error {}
