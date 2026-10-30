import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHarness, type Harness } from '../scripts/harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness({ quiet: true, env: { ALLOW_SELF_DEAL: 'true' } }); }, 120_000);
afterAll(async () => { await h?.stop(); });

describe('test mode: one phone plays both sides', () => {
  it('runs a whole deal from a single phone, with "paid" standing in for the transfer', async () => {
    const me = '+2290190000001';
    await h.say(me, 'hi', 'Raphael');
    const code = await h.sellOrder(me, me, { item: 'Test sneakers', price: '10000' }); // your own number is fine in test mode

    await h.say(me, `Pay ${code}`);
    expect(h.last(me)).toMatch(/\*You pay  ₦10,500\*/); // price + the buyer's ₦500 transaction fee (the seller started it)
    await h.acceptOrder(me, code);
    expect(h.last(me)).toMatch(/TEST MODE: no real money/);

    await h.say(me, 'paid');
    const status = async () => (await h.db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0].status;
    expect(await status()).toBe('FUNDED');
    await h.handOver(me, code);
    await h.tap(me, `happy:${code}`);
    expect(await status()).toBe('COMPLETED');
    expect(h.last(me)).toMatch(/You've been paid/);
  }, 30_000);

  it('"paid" with nothing to pay says so', async () => {
    await h.say('+2290190000002', 'paid');
    expect(h.last('+2290190000002')).toMatch(/no payment waiting/);
  });

  it('test mode is refused with real payments, allowed with the Monnify sandbox', () => {
    const env = { DATABASE_URL: 'x', ADMIN_TOKEN: 'aaaaaaaaaaaaaaaaaaaa', ALLOW_SELF_DEAL: 'true', PAYMENT_PROVIDER: 'monnify', MONNIFY_API_KEY: 'k', MONNIFY_SECRET_KEY: 's', MONNIFY_CONTRACT_CODE: 'c' };
    expect(() => loadConfig({ ...env, MONNIFY_BASE_URL: 'https://api.monnify.com' } as NodeJS.ProcessEnv)).toThrow(/Remove it before using live keys/);
    expect(() => loadConfig({ ...env, MONNIFY_BASE_URL: 'https://sandbox.monnify.com' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('the market works from one phone too: list an item, buy it yourself, "paid", hand over, happy', async () => {
    await h.app.settings.save(h.db, { feature_market: true }, null);
    (h.app.chat as any).o.media = { download: async () => ({ bytes: await sharp(Buffer.from(Array.from({ length: 32 * 32 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 32, height: 32, channels: 3 } }).jpeg().toBuffer(), mimeType: 'image/jpeg' }) };
    const me = '+2290190000009';
    await h.say(me, 'hi', 'Raphael');
    await h.sell(me);
    await h.tap(me, 'menu:account'); await h.say(me, '0123456789 GTBank'); await h.tap(me, 'bank:yes');
    await h.tap(me, 'menu:items');
    await h.tap(me, 'mk:new');
    await (h.app.chat as any).handle({ id: 'img-t1', phone: me, name: null, type: 'image', text: '', buttonId: null, mediaId: 'm-t1' });
    await h.tap(me, 'mk:photosdone');
    await h.say(me, 'Test market sneakers');
    await h.tap(me, 'mk:lcat:shoes');
    await h.say(me, '10000');
    await h.tap(me, 'mk:stock1');
    await h.tap(me, 'mk:ldel:all');
    await h.say(me, 'Ikeja, Lagos');
    expect(h.last(me)).toMatch(/is live/);
    const l = (await h.db.query('SELECT * FROM market_listings WHERE title=$1', ['Test market sneakers'])).rows[0];
    expect(l.is_test).toBe(true);

    await h.tap(me, 'menu:market');
    await h.tap(me, 'mk:all');
    await h.tap(me, `mk:buy:${l.id}`);
    expect(h.last(me)).not.toMatch(/your own item/);
    await h.tap(me, `mk:go:${l.id}:1`);
    await h.say(me, '5 Allen Avenue, Ikeja');
    await h.tap(me, 'bdate:2');
    await h.tap(me, 'buy:send');
    const deal = (await h.db.query('SELECT code FROM deals WHERE from_market ORDER BY created_at DESC LIMIT 1')).rows[0];
    await h.tap(me, `saccept:${deal.code}`);
    await h.tap(me, `pay:${deal.code}`);
    await h.say(me, 'paid');
    const status = async () => (await h.db.query('SELECT status FROM deals WHERE code=$1', [deal.code])).rows[0].status;
    expect(await status()).toBe('FUNDED');
    await new Promise((r) => setTimeout(r, 200));
    expect((await h.db.query('SELECT stock, status FROM market_listings WHERE id=$1', [l.id])).rows[0]).toEqual({ stock: 0, status: 'SOLD_OUT' });
    await h.handOver(me, deal.code);
    await h.tap(me, `happy:${deal.code}`);
    expect(await status()).toBe('COMPLETED');
    // test items stay out of search engines
    expect((await h.app.app.inject({ url: '/sitemap.xml' })).body).not.toContain(l.code);
  }, 30_000);
});
