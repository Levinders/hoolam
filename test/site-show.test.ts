import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness({ quiet: true, twoStep: false }); }, 120_000);
afterAll(async () => { await h?.stop(); });

const get = (url: string) => h.app.app.inject({ method: 'GET', url });
async function owner() {
  const r = await h.app.app.inject({ method: 'POST', url: '/console/api/auth/setup', headers: { 'x-hoolam-console': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ setupToken: 'test-admin-token-123456', name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' }) });
  return String(r.headers['set-cookie']).split(';')[0]!;
}
/** Real (not test) orders in a given state, for the counts. */
async function deals(status: string, n: number) {
  const u = (await h.db.query(`INSERT INTO users (phone, display_name) VALUES ('+2348099' || lpad((floor(random()*1000000))::text, 6, '0'), 'X') RETURNING id`)).rows[0].id;
  for (let i = 0; i < n; i++) {
    await h.db.query(`INSERT INTO deals (code, seller_id, item, price_minor, currency, fee_minor, buyer_pays_minor, seller_gets_minor, status, is_test)
      VALUES ('HL-' || substr(md5(random()::text), 1, 5), $1, 'Shoes', 1000000, 'NGN', 30000, 1030000, 950000, $2, false)`, [u, status]);
  }
}

describe('live numbers on the website', () => {
  it('count real orders only, and show each one only once it reaches its minimum', async () => {
    await deals('COMPLETED', 3);
    await deals('REFUNDED', 1);
    await h.db.query(`UPDATE deals SET is_test=true WHERE status='REFUNDED'`); // test orders never count
    await deals('AWAITING_PAYMENT', 2);
    let p = (await get('/site/proof.json')).json();
    expect(p).toEqual({ completed: null, started: null, refunded: null, ambPaid: null }); // below the minimums (50, 100, 5)

    const cookie = await owner();
    const set = await h.app.app.inject({ method: 'PUT', url: '/console/api/settings', headers: { 'x-hoolam-console': '1', 'content-type': 'application/json', cookie },
      payload: JSON.stringify({ changes: { site_min_completed: 3, site_min_started: 5, site_min_refunded: 1 }, reason: 'Show the numbers' }) });
    expect(set.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const n = (await h.app.app.inject({ method: 'GET', url: '/console/api/site-numbers', headers: { 'x-hoolam-console': '1', cookie } })).json();
    expect(n.counts).toMatchObject({ completed: 3, started: 5, refunded: 0 });
    p = (await get('/site/proof.json')).json();
    expect(p).toEqual({ completed: 3, started: 5, refunded: null, ambPaid: null }); // no real refunds: hidden even with minimum 1

    await h.app.app.inject({ method: 'PUT', url: '/console/api/settings', headers: { 'x-hoolam-console': '1', 'content-type': 'application/json', cookie },
      payload: JSON.stringify({ changes: { feature_site_numbers: false }, reason: 'Not yet' }) });
    expect((await get('/site/proof.json')).json()).toEqual({ completed: null, started: null, refunded: null, ambPaid: null });
  }, 60_000);
});

describe('the website shows the chat', () => {
  it('site.json lists the chat pictures (drawn with the website story at today\'s fees) and a QR code for the chat', async () => {
    const j = (await get('/site.json')).json();
    expect(Object.keys(j.show.art)).toEqual(expect.arrayContaining(['held', 'seller-held', 'frozen', 'paid', 'refund', 'status-3', 'real-hoolam', 'amb-share']));
    expect(j.show.art.held).toMatchObject({ url: expect.stringMatching(/\/site\/art\/held\?v=[0-9a-f]{10}$/), alt: expect.any(String) });
    expect(j.show.voices).toEqual({});
    expect(j.show.qr).toMatch(/^<svg|^<\?xml/);
    const pic = await get(`/site/art/held?v=${j.show.art.held.v}`);
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/webp');
    expect(pic.headers['cache-control']).toMatch(/immutable/);
    expect((await sharp(pic.rawPayload).metadata()).width).toBe(900);
    expect((await get('/site/art/nope')).statusCode).toBe(404);
  }, 60_000);

  it('a voice note uploaded in the console plays on the website; chat-only ones never do', async () => {
    const c = String((await h.app.app.inject({ method: 'POST', url: '/console/api/auth/login', headers: { 'x-hoolam-console': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' }) })).headers['set-cookie']).split(';')[0]!;
    const put = (slot: string) => h.app.app.inject({ method: 'PUT', url: `/console/api/chat-media/${slot}`, headers: { 'x-hoolam-console': '1', 'content-type': 'audio/mpeg', 'x-file-name': 'v.mp3', cookie: c }, payload: Buffer.from('ID3 voice') });
    expect((await put('voice-founder')).statusCode).toBe(200);
    expect((await put('voice-seller-held')).statusCode).toBe(200);
    const j = (await get('/site.json')).json();
    expect(Object.keys(j.show.voices)).toEqual(['voice-founder']);
    const v = await get('/site/voice/voice-founder');
    expect(v.statusCode).toBe(200);
    expect(v.headers['content-type']).toMatch(/audio\/mpeg/);
    expect((await get('/site/voice/voice-seller-held')).statusCode).toBe(404);
  }, 60_000);
});
