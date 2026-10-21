import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Queryable } from './db.js';
import type { Art, ChatArt } from './chat-art/index.js';
import { markKey } from './brand-mark.js';
import { slot as slotOf } from './chat-art/slots.js';
import type { Settings } from './settings.js';
import { quote } from './pricing.js';
import QRCode from 'qrcode';

/**
 * What the website shows from the chat: the same pictures and voice notes people get in WhatsApp (so the first card
 * in the chat looks familiar), and live numbers from real orders. The pictures are drawn with the website's story
 * (Ivana buys sneakers from Mama Bella) and follow every replacement made in Console → Settings → WhatsApp.
 * The website copies all of it when it's built (site.json `show`), so it loads even while this server sleeps.
 */
const CODE = 'HL-7K2QF';
type Story = { pay: string; gets: string };
export const SITE_ART: Record<string, { art: Art | ((s: Story) => Art); alt: string }> = {
  'held':        { art: (x) => ({ card: 'moneyHeld', data: { side: 'buyer', amount: x.pay, code: CODE, other: 'Mama Bella' } }), alt: 'Hoolam chat card: your money is held safely until you’re happy' },
  'seller-held': { art: (x) => ({ card: 'moneyHeld', data: { side: 'seller', amount: x.gets, code: CODE, other: 'Ivana' } }), alt: 'Hoolam chat card for the seller: the money is ready, send the item' },
  'handover':    { art: { card: 'handover', data: { digits: '4821', code: CODE, to: 'seller' } }, alt: 'Hoolam chat card: the 4-digit handover code' },
  'frozen':      { art: (x) => ({ card: 'frozen', data: { side: 'buyer', amount: x.pay, code: CODE, hours: 24 } }), alt: 'Hoolam chat card: the money is frozen while a rep sorts out the problem' },
  'paid':        { art: (x) => ({ card: 'paid', data: { state: 'paid', amount: x.gets, bank: 'GTBank ••••1234', code: CODE } }), alt: 'Hoolam chat card: the seller’s money sent to their bank' },
  'refund':      { art: (x) => ({ card: 'refund', data: { amount: x.pay, bank: 'GTBank ••••1234', code: CODE } }), alt: 'Hoolam chat card: all the buyer’s money refunded' },
  'status-1':    { art: { picture: 'status-1' }, alt: 'Order status, step 1: sent' },
  'status-2':    { art: { picture: 'status-2' }, alt: 'Order status, step 2: payment' },
  'status-3':    { art: { picture: 'status-3' }, alt: 'Order status, step 3: money held' },
  'status-4':    { art: { picture: 'status-4' }, alt: 'Order status, step 4: on the way' },
  'status-5':    { art: { picture: 'status-5' }, alt: 'Order status, step 5: check it' },
  'status-6':    { art: { picture: 'status-6' }, alt: 'Order status, step 6: paid out' },
  'real-hoolam': { art: { picture: 'real-hoolam' }, alt: 'How to know it’s the real Hoolam' },
  'amb-share':   { art: { card: 'ambShare', data: { firstName: 'Tobi', link: 'hoolam.com/a/tobi', area: 'UNILAG' } }, alt: 'The card an ambassador shares: Tobi invited you to Hoolam' },
};
/** The voice notes the website can play (the same uploads as the chat's). */
export const SITE_VOICES = ['voice-how', 'voice-founder', 'voice-amb-founder', 'voice-problem'] as const;

export interface Proof {
  completed: number | null; // orders where the seller was paid
  started: number | null;   // orders started
  refunded: number | null;  // buyers refunded in full
  ambPaid: number | null;   // naira paid to ambassadors
}
export interface ProofCounts { completed: number; started: number; refunded: number; ambPaidMinor: number }

const WIDTH = 900;

export class SiteShow {
  private readonly cache = new Map<string, { bytes: Buffer; v: string }>();
  private countCache: { at: number; c: ProofCounts } | null = null;

  constructor(private readonly db: Queryable, private readonly art: ChatArt, private readonly settings: Settings, private readonly unit: number) {}

  /** The picture as the website shows it (WebP, 900 wide) and a short version that changes when it changes. */
  async picture(id: string): Promise<{ bytes: Buffer; v: string; mime: string } | null> {
    const d = SITE_ART[id];
    if (!d) return null;
    const story = this.story();
    const def = { art: typeof d.art === 'function' ? d.art(story) : d.art };
    const slotId = 'card' in def.art ? ({ moneyHeld: 'card-money-held', handover: 'card-handover', frozen: 'card-frozen', paid: 'card-paid', refund: 'card-refund' } as Record<string, string>)[def.art.card] ?? null : def.art.picture;
    const own = slotId ? (await this.db.query('SELECT sha256 FROM wa_media WHERE slot=$1', [slotId])).rows[0]?.sha256 ?? '' : '';
    const key = `${id}:${markKey()}:${own}:${id === 'real-hoolam' ? this.settings.waNumber() : ''}:${story.pay}:${story.gets}`;
    const hit = this.cache.get(key);
    if (hit) return { ...hit, mime: 'image/webp' };
    const r = await this.art.render(def.art);
    const bytes = await sharp(r.bytes).resize(WIDTH, null, { withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    const v = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    for (const k of this.cache.keys()) if (k.startsWith(`${id}:`)) this.cache.delete(k);
    this.cache.set(key, { bytes, v });
    return { bytes, v, mime: 'image/webp' };
  }

  /** The website's story order: ₦10,000 of sneakers, Ivana (the buyer) started it, at today's fees. */
  private story(): Story {
    const naira = (minor: number) => `₦${Math.round(minor / 100).toLocaleString('en-NG')}`;
    try {
      const q = quote(1_000_000, 'NGN', this.settings.pricing(), 'buyer', this.settings.txnFees());
      return { pay: naira(q.buyerPaysMinor), gets: naira(q.sellerGetsMinor) };
    } catch { return { pay: '₦10,300', gets: '₦9,500' }; }
  }

  /** An uploaded voice note the website plays, or null. */
  async voice(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    if (!(SITE_VOICES as readonly string[]).includes(id) || slotOf(id)?.kind !== 'voice') return null;
    const r = await this.db.query('SELECT mime, bytes FROM wa_media WHERE slot=$1', [id]);
    return r.rows[0] ? { mime: r.rows[0].mime, bytes: r.rows[0].bytes } : null;
  }

  async voices(): Promise<Record<string, { v: string; mime: string }>> {
    const r = await this.db.query('SELECT slot, mime, sha256 FROM wa_media WHERE slot = ANY($1)', [[...SITE_VOICES]]);
    return Object.fromEntries(r.rows.map((x) => [x.slot, { v: String(x.sha256).slice(0, 10), mime: x.mime }]));
  }

  /** Counts from real orders (test orders never count). Kept for a minute. */
  async counts(): Promise<ProofCounts> {
    if (this.countCache && Date.now() - this.countCache.at < 60_000) return this.countCache.c;
    const d = (await this.db.query(`SELECT
        count(*) FILTER (WHERE status IN ('RELEASING','PAYOUT_PENDING','COMPLETED')) AS completed,
        count(*) AS started,
        count(*) FILTER (WHERE status = 'REFUNDED') AS refunded
      FROM deals WHERE NOT is_test`)).rows[0];
    const a = (await this.db.query(`SELECT coalesce(sum(amount_minor),0) AS paid FROM ambassador_payouts WHERE status='PAID'`)).rows[0];
    const c = { completed: Number(d.completed), started: Number(d.started), refunded: Number(d.refunded), ambPaidMinor: Number(a.paid) };
    this.countCache = { at: Date.now(), c };
    return c;
  }

  /** What the website may show: each number only once it reaches its minimum (Console → Settings → Features). */
  async proof(): Promise<Proof> {
    const s = this.settings.siteNumbers();
    if (!s.on) return { completed: null, started: null, refunded: null, ambPaid: null };
    const c = await this.counts();
    const show = (n: number, min: number) => (n > 0 && n >= min ? n : null);
    return {
      completed: show(c.completed, s.minCompleted),
      started: show(c.started, s.minStarted),
      refunded: show(c.refunded, s.minRefunded),
      ambPaid: show(Math.floor(c.ambPaidMinor / this.unit), s.minAmbPaid),
    };
  }

  /** For site.json: every picture's address and version, the voice notes uploaded, and the numbers. */
  async forSite(base: string): Promise<{ art: Record<string, { url: string; v: string; alt: string }>; voices: Record<string, { url: string; v: string; mime: string }>; proof: Proof; qr: string | null }> {
    const b = base.replace(/\/+$/, '');
    const art: Record<string, { url: string; v: string; alt: string }> = {};
    for (const id of Object.keys(SITE_ART)) {
      const p = await this.picture(id).catch(() => null);
      if (p) art[id] = { url: `${b}/site/art/${id}?v=${p.v}`, v: p.v, alt: SITE_ART[id]!.alt };
    }
    const voices = Object.fromEntries(Object.entries(await this.voices()).map(([k, x]) => [k, { url: `${b}/site/voice/${k}?v=${x.v}`, v: x.v, mime: x.mime }]));
    // a QR code that opens the chat, for visitors on a computer
    const wa = this.settings.waNumber();
    const qr = wa ? await QRCode.toString(`https://wa.me/${wa}?text=${encodeURIComponent('Hi Hoolam')}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0E5C63', light: '#0000' } }).catch(() => null) : null;
    return { art, voices, proof: await this.proof(), qr };
  }
}
