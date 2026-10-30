import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { findPlace } from '../src/market/areas.js';
import { readSearch } from '../src/market/market.js';
import { editItemFormJson, listFormJson, marketOrderFormJson } from '../src/market/market-forms.js';
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

  it('the market forms are sound: every ${data.x} is declared, every ${form.x} is a field, navigate carries what the next screen needs', () => {
    const flat = (cs: any[]): any[] => cs.flatMap((c) => (c.type === 'Form' ? flat(c.children) : [c]));
    for (const json of [listFormJson('aGVsbG8='), editItemFormJson(), marketOrderFormJson()]) {
      const byId = Object.fromEntries(json.screens.map((sc: any) => [sc.id, sc]));
      for (const sc of json.screens as any[]) {
        const parts = flat(sc.layout.children);
        const fields = new Set(parts.map((c) => c.name).filter(Boolean));
        const text = JSON.stringify(sc.layout);
        for (const [, k] of text.matchAll(/\$\{data\.(\w+)\}/g)) expect(Object.keys(sc.data ?? {}), `${sc.id} uses data.${k}`).toContain(k);
        for (const [, k] of text.matchAll(/\$\{form\.(\w+)\}/g)) expect([...fields], `${sc.id} uses form.${k}`).toContain(k);
        expect(parts.filter((c) => c.type === 'PhotoPicker').length).toBeLessThanOrEqual(1);
        const foot = parts.find((c) => c.type === 'Footer')['on-click-action'];
        if (foot.name === 'navigate') {
          const next = byId[foot.next.name];
          expect(Object.keys(foot.payload).sort()).toEqual(Object.keys(next.data).sort());
          expect(JSON.stringify(foot.payload)).not.toMatch(/photos/); // photos only go with the last button
          // a number field carried to the next screen must be declared a number there (WhatsApp checks the types)
          for (const [k, v] of Object.entries(foot.payload)) {
            const field = parts.find((c) => `\${form.${c.name}}` === v);
            if (field?.['input-type'] === 'number') expect(next.data[k].type, `${sc.id} → ${k}`).toBe('number');
          }
        } else expect(sc.terminal).toBe(true);
      }
    }
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
    expect(buyerMenu()[0]!.rows.slice(0, 2).map((r) => r.id)).toEqual(['menu:buy', 'menu:market']); // Buy something stays first
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

  describe('forms first, the chat as the backup', () => {
    let fn = 0;
    const submit = (p: string, token: string, form: Record<string, unknown>) =>
      h.app.chat.handle({ id: `mkform${++fn}`, phone: p, name: null, type: 'form', text: '', buttonId: null, mediaId: null, form: { flow_token: token, ...form } });
    const lastOut = async (p: string) => (await h.db.query('SELECT kind, body FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [p])).rows[0];
    beforeAll(() => { for (const k of ['mkList', 'mkEdit', 'mkOrder'] as const) h.app.forms.set(k, { flowId: `f-${k}`, mode: 'published' }); });
    afterAll(() => { for (const k of ['mkList', 'mkEdit', 'mkOrder'] as const) h.app.forms.set(k, null); });

    it('List an item: the form, then the check with the real photo, then List it', async () => {
      const s = await seller('Form Shop');
      await h.tap(s.phone, 'menu:items');
      await h.tap(s.phone, 'mk:new');
      const out = await lastOut(s.phone);
      expect(out.kind).toBe('form');
      expect(out.body.flowToken).toBe('mklist:v1');
      expect(out.body.data.categories.map((c: { id: string }) => c.id)).toContain('shoes');
      // a typo in the area: the chat asks "did you mean", then the check
      await submit(s.phone, 'mklist:v1', { title: 'Brown suede loafers', category: 'shoes', price: '32k', stock: '2', details: 'Size 44', delivery: ['pickup', 'waybill'], area: 'ikaja', photos: [{ id: 'mf1' }, { id: 'mf2' }] });
      expect(h.last(s.phone)).toMatch(/did you mean/);
      await h.tap(s.phone, 'mk:lpl:0');
      expect(h.last(s.phone)).toMatch(/Check your item/);
      expect(h.last(s.phone)).toMatch(/₦32,000 · 2 in stock/);
      expect(h.last(s.phone)).toMatch(/2 photos/);
      expect(h.last(s.phone)).toMatch(/\[✅ List it\] \[✏️ Change\] \[🔄 Start again\]/);
      // Change reopens the form filled in, and a second submit without photos keeps the first ones
      await h.tap(s.phone, 'mk:lchg');
      const again = await lastOut(s.phone);
      expect(again.body.data.title).toBe('Brown suede loafers');
      expect(again.body.data.price).toBe('32000');
      await submit(s.phone, 'mklist:v1', { title: 'Brown suede loafers, size 44', category: 'shoes', price: '30000', stock: '2', details: '', delivery: ['pickup'], area: 'Ikeja, Lagos', photos: [] });
      expect(h.last(s.phone)).toMatch(/₦30,000/);
      expect(h.last(s.phone)).toMatch(/2 photos/);
      await h.tap(s.phone, 'mk:lgo');
      expect(h.last(s.phone)).toMatch(/is live/);
      const l = (await h.db.query(`SELECT * FROM market_listings WHERE title='Brown suede loafers, size 44'`)).rows[0];
      expect(Number(l.price_minor)).toBe(3_000_000);
      expect(l.delivery).toEqual(['pickup']);
      expect((await h.db.query('SELECT count(*)::int AS n FROM market_photos WHERE listing_id=$1', [l.id])).rows[0].n).toBe(2);
    });

    it('a wrong answer in the list form says what to fix', async () => {
      const s = await seller('Typo Shop');
      await h.tap(s.phone, 'mk:new');
      await submit(s.phone, 'mklist:v1', { title: 'Red cap', category: 'shoes', price: 'cheap', stock: '1', delivery: ['pickup'], area: 'Ikeja, Lagos', photos: [{ id: 'x1' }] });
      expect(h.last(s.phone)).toMatch(/isn't a price we can read/);
      expect(h.last(s.phone)).toMatch(/Fix it/);
    });

    it('Edit item: the form filled in, every change saved at once', async () => {
      const s = await seller('Edit Shop');
      h.app.forms.set('mkList', null);
      const l = await list(s.phone, { title: 'Gold hoop earrings', price: '15000', where: 'Ikeja, Lagos' });
      h.app.forms.set('mkList', { flowId: 'f-mkList', mode: 'published' });
      await h.tap(s.phone, `mk:chg:${l.id}`);
      const out = await lastOut(s.phone);
      expect(out.kind).toBe('form');
      expect(out.body.data).toMatchObject({ price: '15000', promo: '', promo_for: '0', stock: '2', delivery: ['pickup', 'rider', 'waybill'] });
      await submit(s.phone, `mkedit:${l.id}`, { price: '15000', promo: '12000', promo_for: '7', stock: '5', delivery: ['rider'], details: 'Real gold plated' });
      const x = (await h.db.query('SELECT * FROM market_listings WHERE id=$1', [l.id])).rows[0];
      expect(Number(x.promo_minor)).toBe(1_200_000);
      expect(x.promo_ends).toBeTruthy();
      expect(x.stock).toBe(5);
      expect(x.delivery).toEqual(['rider']);
      expect(x.details).toBe('Real gold plated');
      expect(h.last(s.phone)).toMatch(/~₦15,000~ \*₦12,000\*/);
      // the chat list is still there
      await h.tap(s.phone, `mk:chgchat:${l.id}`);
      expect(h.last(s.phone)).toMatch(/what would you like to change/);
    });

    it('Edit item shows the photos there now, and new ones replace them (form or chat)', async () => {
      const s = await seller('Photo Shop');
      h.app.forms.set('mkList', null);
      const l = await list(s.phone, { title: 'Silver bracelet', price: '9000', where: 'Ikeja, Lagos' });
      const photos = async () => (await h.db.query('SELECT sha256 FROM market_photos WHERE listing_id=$1 ORDER BY position', [l.id])).rows.map((r) => r.sha256);
      const before = await photos();
      await h.tap(s.phone, `mk:chg:${l.id}`);
      const cards = (await h.db.query(`SELECT body FROM outbound_messages WHERE phone=$1 AND kind='cards' ORDER BY id DESC LIMIT 1`, [s.phone])).rows[0];
      expect(cards.body.text).toMatch(/Your photos now · 1/);
      expect((await lastOut(s.phone)).body.data.photo_note).toMatch(/You have 1 photo/);
      await submit(s.phone, `mkedit:${l.id}`, { price: '9000', promo: '', promo_for: '0', stock: '2', delivery: ['pickup', 'rider', 'waybill'], details: '', photos: [{ id: 'n1' }, { id: 'n2' }] });
      const after = await photos();
      expect(after).toHaveLength(2);
      expect(after[0]).not.toBe(before[0]);
      // the chat way: Replace photos, send one, Done
      await h.tap(s.phone, `mk:e:${l.id}:photos`);
      await photo(s.phone);
      await h.tap(s.phone, 'mk:ephdone');
      expect(await photos()).toHaveLength(1);
    });

    it('a market order: the delivery form, then the order to check; typing the address still works', async () => {
      const s = await seller('Order Form Shop');
      h.app.forms.set('mkList', null);
      const l = await list(s.phone, { title: 'Blue jeans, size 32', price: '12000', stock: null, where: 'Ikeja, Lagos' });
      const b = phone();
      await h.say(b, 'hi', 'Yemi');
      await h.tap(b, `mk:go:${l.id}:1`);
      const out = await lastOut(b);
      expect(out.kind).toBe('form');
      expect(out.body.flowToken).toBe('mkorder:v1');
      await submit(b, 'mkorder:v1', { address: '3 Opebi Road, Ikeja', arrive_by: '2026-11-05' });
      const st = (await h.db.query('SELECT state, data FROM chat_sessions WHERE phone=$1', [b])).rows[0];
      expect(st.state).toBe('BUY_CONFIRM');
      expect(st.data).toMatchObject({ address: '3 Opebi Road, Ikeja', arriveBy: '2026-11-05' });
      const b2 = phone();
      await h.say(b2, 'hi', 'Ola');
      await h.tap(b2, `mk:go:${l.id}:1`);
      await h.say(b2, '9 Allen Avenue, Ikeja');
      expect((await h.db.query('SELECT state FROM chat_sessions WHERE phone=$1', [b2])).rows[0].state).toBe('BUY_DATE');
    });
  });
});
