import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { findPlace } from '../src/market/areas.js';
import { readSearch } from '../src/market/market.js';
import { buyerMenu, sellerMenu } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
const phone = () => `+2348050000${String(++seq).padStart(3, '0')}`;
const state = async (p: string) => (await h.db.query('SELECT state, data FROM chat_sessions WHERE phone=$1', [p])).rows[0];
const lastBody = async (p: string) => h.last(p);
const bodies = async (p: string, n = 4) => h.transcript.filter((t) => t.phone === p).slice(-n).reverse().map((t) => t.text);

beforeAll(async () => {
  h = await startHarness({ quiet: true });
  // pretend WhatsApp media: every photo someone sends is a different picture (random noise)
  (h.app.chat as any).o.media = { download: async () => ({ bytes: await sharp(Buffer.from(Array.from({ length: 32 * 32 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 32, height: 32, channels: 3 } }).jpeg().toBuffer(), mimeType: 'image/jpeg' }) };
}, 120_000);
afterAll(async () => { await h?.stop(); });

const photo = (p: string) => (h.app.chat as any).handle({ id: `img${Date.now()}${Math.random()}`, phone: p, name: null, type: 'image', text: '', buttonId: null, mediaId: `media-${Math.random()}` });

/** A seller set up with a payout account (KYC is off in the harness). */
async function seller(name = 'Bayo Kicks') {
  const p = phone();
  await h.say(p, 'hi', name);
  await h.sell(p);
  await h.tap(p, 'menu:me');
  const u = (await h.db.query('SELECT id FROM users WHERE phone=$1', [p])).rows[0];
  await h.db.query(`INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_number, account_name) VALUES ($1,'058','GTBank','0123456789','BAYO KICKS')`, [u.id]);
  return { phone: p, id: u.id as string };
}

async function list(s: string, o: { title?: string; price?: string; stock?: string | null; where?: string } = {}) {
  await h.tap(s, 'menu:items');
  await h.tap(s, 'mk:new');
  await photo(s);
  await h.tap(s, 'mk:photosdone');
  await h.say(s, o.title ?? 'Nike Air Force 1, size 43');
  await h.tap(s, 'mk:lcat:shoes');
  await h.say(s, o.price ?? '45k');
  if (o.stock === null) await h.tap(s, 'mk:stock1'); else await h.say(s, o.stock ?? '2');
  await h.tap(s, 'mk:ldel:all');
  await h.say(s, o.where ?? 'Woji, Port Harcourt');
  return (await h.db.query('SELECT * FROM market_listings ORDER BY id DESC LIMIT 1')).rows[0];
}

describe('the market', () => {
  it('is off by default: no menu rows, and the buttons lead back to the menu', async () => {
    expect(JSON.stringify(buyerMenu())).not.toContain('menu:market');
    expect(JSON.stringify(sellerMenu())).not.toContain('menu:items');
    const p = phone();
    await h.say(p, 'hi', 'Ada');
    await h.tap(p, 'menu:market');
    expect(await lastBody(p)).not.toContain('Hoolam market');
  });

  it('reads typed areas, misspellings included, and searches', () => {
    const a = findPlace('lekki ph1');
    expect(a.kind).toBe('sure');
    expect(findPlace('Woji, Port Harcourt').kind).toBe('sure');
    expect(findPlace('zzzzqqq').kind).toBe('none');
    const q = readSearch('black bag under 20k');
    expect(q.maxMinor).toBe(2_000_000);
    expect(q.words).toContain('bag');
  });

  it('a seller lists an item in the chat; a buyer browses, sees more, saves and buys it', async () => {
    await h.app.settings.save(h.db, { feature_market: true }, null);
    expect(JSON.stringify(buyerMenu())).toContain('menu:market');
    expect(JSON.stringify(sellerMenu())).toContain('menu:items');

    const s = await seller();
    const l = await list(s.phone, { price: '20k' });
    expect(l).toBeTruthy();
    expect(l.status).toBe('LIVE');
    expect(l.city).toBe('Port Harcourt');
    expect(Number(l.price_minor)).toBe(2_000_000);
    expect(l.delivery).toEqual(['pickup', 'rider', 'waybill']);
    expect(await lastBody(s.phone)).toMatch(/is live/);
    expect((await state(s.phone)).state).toBe('IDLE');

    const b = phone();
    await h.say(b, 'hi', 'Tolu');
    await h.tap(b, 'menu:market');
    expect(await lastBody(b)).toMatch(/Where should we look/);
    await h.tap(b, 'mk:typearea');
    await h.say(b, 'woji portharcourt');
    expect(await lastBody(b)).toMatch(/Hoolam market/);
    await h.tap(b, 'mk:cat:shoes');
    const page = await bodies(b, 2);
    expect(page.join('\n')).toMatch(/Nike Air Force 1/);
    expect(page[0]).toMatch(/1–1 of 1/);

    await h.tap(b, `mk:see:${l.id}`);
    expect(await lastBody(b)).toMatch(/You pay Hoolam, not the seller/);
    await h.tap(b, `mk:save:${l.id}`);
    expect((await h.db.query('SELECT count(*)::int AS n FROM market_saves WHERE listing_id=$1', [l.id])).rows[0].n).toBe(1);

    await h.tap(b, `mk:buy:${l.id}`);
    expect(await lastBody(b)).toMatch(/How many/);
    await h.tap(b, `mk:qty:${l.id}:2`);
    expect(await lastBody(b)).toMatch(/×2/);
    await h.tap(b, `mk:go:${l.id}:2`);
    // the order is filled in from the listing: only the delivery address and date are asked
    expect((await state(b)).state).toBe('BUY_ADDRESS');
    await h.say(b, '5 Woji Road, Port Harcourt');
    await h.tap(b, 'bdate:2');
    expect((await state(b)).state).toBe('BUY_CONFIRM');
    await h.tap(b, 'buy:send');
    const deal = (await h.db.query('SELECT * FROM deals WHERE buyer_id=(SELECT id FROM users WHERE phone=$1) ORDER BY created_at DESC LIMIT 1', [b])).rows[0];
    expect(deal.from_market).toBe(true);
    expect(Number(deal.price_minor)).toBe(4_000_000);
    expect((await h.db.query('SELECT count(*)::int AS n FROM deal_photos WHERE deal_id=$1', [deal.id])).rows[0].n).toBeGreaterThan(0);

    // the seller accepts; the buyer pays; stock goes to 0 and the seller hears it sold out
    await h.tap(s.phone, `saccept:${deal.code}`);
    await h.tap(b, `pay:${deal.code}`);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=$1', [deal.id]);
    h.provider.pay(r.rows[0].provider_reference);
    await h.app.deals.handleCollection(r.rows[0].provider_reference);
    await new Promise((x) => setTimeout(x, 300));
    const after = (await h.db.query('SELECT stock, status FROM market_listings WHERE id=$1', [l.id])).rows[0];
    expect(after).toEqual({ stock: 0, status: 'SOLD_OUT' });
    expect((await bodies(s.phone, 6)).join('\n')).toMatch(/sold out and hidden/);
  });

  it('a basket is one seller; another seller says so plainly', async () => {
    const s1 = await seller('Ada Bags'), s2 = await seller('Chi Wears');
    const a = await list(s1.phone, { title: 'Black leather bag', price: '20000', where: 'Ikeja, Lagos' });
    const a2 = await list(s1.phone, { title: 'Brown leather belt', price: '8000', where: 'Ikeja, Lagos' });
    const c = await list(s2.phone, { title: 'Red ankara gown', price: '15000', where: 'Wuse 2, Abuja' });
    const b = phone();
    await h.say(b, 'hi', 'Kemi');
    await h.tap(b, 'menu:market');
    await h.tap(b, 'mk:all');
    await h.tap(b, `mk:bask:${a.id}:1`);
    await h.tap(b, `mk:bask:${a2.id}:1`);
    expect(await lastBody(b)).toMatch(/2 items from \*Ada Bags\*/);
    await h.tap(b, `mk:bask:${c.id}:1`);
    expect(await lastBody(b)).toMatch(/One basket is for one seller/);
    await h.tap(b, 'mk:basket');
    expect(await lastBody(b)).toMatch(/One order, one payment/);
    await h.tap(b, 'mk:buyall');
    const st = await state(b);
    expect(st.data.market).toHaveLength(2);
    expect(st.data.priceMinor).toBe(2_800_000);
  });

  it('typed search finds items; nothing near widens to all Nigeria', async () => {
    const b = phone();
    await h.say(b, 'hi', 'Femi');
    await h.tap(b, 'menu:market');
    await h.tap(b, 'mk:typearea');
    await h.say(b, 'Ikeja, Lagos');
    await h.say(b, 'ankara gown');
    expect((await bodies(b, 2)).join('\n')).toMatch(/Red ankara gown/);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM market_searches WHERE query='ankara gown'`)).rows[0].n).toBe(1);
  });

  it('reports hide an item after the set number, and the seller is told', async () => {
    await h.app.settings.save(h.db, { mk_reports_hide: 2 }, null);
    const s = await seller('Quick Phones');
    const l = await list(s.phone, { title: 'iPhone 13 Pro', price: '300000', where: 'Ikeja, Lagos' });
    for (let i = 0; i < 2; i++) { const b = phone(); await h.say(b, 'hi', `R${i}`); await h.tap(b, `mk:rr:${l.id}:0`); }
    expect((await h.db.query('SELECT status FROM market_listings WHERE id=$1', [l.id])).rows[0].status).toBe('HIDDEN');
    expect(await lastBody(s.phone)).toMatch(/paused/);
  });

  it('a seller manages an item: promo, stock, pause', async () => {
    const s = await seller('Promo Shop');
    const l = await list(s.phone, { title: 'Blue denim jacket', price: '20000', where: 'Ikeja, Lagos' });
    await h.tap(s.phone, `mk:e:${l.id}:promo`);
    await h.say(s.phone, '18000');
    await h.tap(s.phone, 'mk:pend:7');
    const x = (await h.db.query('SELECT promo_minor, promo_ends FROM market_listings WHERE id=$1', [l.id])).rows[0];
    expect(Number(x.promo_minor)).toBe(1_800_000);
    expect(x.promo_ends).toBeTruthy();
    expect(await lastBody(s.phone)).toMatch(/~₦20,000~ \*₦18,000\*/);
    await h.tap(s.phone, `mk:act:${l.id}:pause`);
    expect((await h.db.query('SELECT status FROM market_listings WHERE id=$1', [l.id])).rows[0].status).toBe('PAUSED');
  });

  it('each item has a public page for search, a share card, and a Buy button that opens the chat on it', async () => {
    const s = await seller('Page Shop');
    const l = await list(s.phone, { title: 'Green silk scarf', price: '9000', where: 'Ikeja, Lagos' });
    const page = await h.app.app.inject({ url: `/i/${l.code}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('"@type":"Product"');
    expect(page.body).toContain('Green silk scarf');
    expect(page.body).toContain('index,follow');
    expect(page.body).toContain('Only pay through Hoolam');
    expect((await h.app.app.inject({ url: `/i/${l.code}/1.jpg` })).headers['content-type']).toBe('image/jpeg');
    expect((await h.app.app.inject({ url: `/i/${l.code}/card.jpg` })).statusCode).toBe(200);
    const buy = await h.app.app.inject({ url: `/i/${l.code}/buy?ad=ig-nov` });
    expect(buy.statusCode).toBe(302);
    expect(decodeURIComponent(buy.headers.location as string)).toContain(`I want to buy this: ${l.code} (ad ig-nov)`);
    expect((await h.app.app.inject({ url: '/sitemap.xml' })).body).toContain(`/i/${l.code}</loc>`);
    expect((await h.app.app.inject({ url: '/i/nothing-here' })).statusCode).toBe(404);

    await h.app.market.adLink(l.id, 'ig-nov');
    const b = phone();
    await h.say(b, `Hi Hoolam, I want to buy this: ${l.code} (ad ig-nov)`, 'Bisi');
    expect(h.last(b)).toMatch(/Green silk scarf/);
    await h.tap(b, `mk:go:${l.id}:1`);
    const ad = (await h.db.query(`SELECT taps, orders FROM market_ad_links WHERE listing_id=$1`, [l.id])).rows[0];
    expect(ad).toEqual({ taps: 1, orders: 1 });
  });
});
