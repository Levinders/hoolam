import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode } from '../src/console/crypto.js';
import { parseSocial } from '../src/socials.js';
import { checkLimits } from '../src/whatsapp/client.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
let seller = '+2348031119001';
let sellerId = '';
const ADMIN = 'test-admin-token-123456';

beforeAll(async () => {
  h = await startHarness({ quiet: true, env: { TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: 'https://go.hoolam.test' } });
  await h.say(seller, 'hi', 'Bayo Adeyemi');
  await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
  sellerId = (await h.db.query('SELECT id FROM users WHERE phone=$1', [seller])).rows[0].id;
  await h.app.trust.setProfile(sellerId, { businessName: 'Bayo <Kicks>', city: 'Lagos' });
  await h.tap(seller, 'menu:card'); await h.tap(seller, 'card:share');
}, 120_000);
afterAll(async () => { await h?.stop(); });

const get = (url: string) => h.app.app.inject({ method: 'GET', url });
const jpeg = (w: number, hh: number) => sharp({ create: { width: w, height: hh, channels: 3, background: '#7A4B2E' } }).jpeg().toBuffer();

describe('links typed any way', () => {
  it('cleans up Instagram, TikTok, Facebook and websites, and refuses odd input', () => {
    expect(parseSocial('instagram', '@Bayo.Kicks')).toEqual({ value: 'bayo.kicks' });
    expect(parseSocial('instagram', 'https://www.instagram.com/bayokicks/?hl=en')).toEqual({ value: 'bayokicks' });
    expect(parseSocial('tiktok', 'https://www.tiktok.com/@bayo_kicks')).toEqual({ value: 'bayo_kicks' });
    expect(parseSocial('facebook', 'fb.com/BayoKicksNG')).toEqual({ value: 'BayoKicksNG' });
    expect(parseSocial('facebook', 'https://facebook.com/profile.php?id=1000123456')).toEqual({ value: 'profile.php?id=1000123456' });
    expect(parseSocial('website', 'bayokicks.com/shop')).toEqual({ value: 'https://bayokicks.com/shop' });
    expect(parseSocial('website', 'wa.me/2348012345678')).toHaveProperty('error');
    expect(parseSocial('website', 'javascript:alert(1)')).toHaveProperty('error');
    expect(parseSocial('instagram', 'bayo kicks')).toHaveProperty('error');
    expect(parseSocial('tiktok', '"><script>')).toHaveProperty('error');
  });
});

describe('a seller edits their page on WhatsApp', () => {
  it('"Edit my page" lists photo, name and each link', async () => {
    await h.tap(seller, 'card:edit');
    expect(h.last(seller)).toMatch(/Edit my page/);
    const t = (await h.app.trust.seller(sellerId))!;
    expect(() => checkLimits(msg.editMyPage(t, false))).not.toThrow();
    for (const k of ['instagram', 'tiktok', 'facebook', 'website'] as const) expect(() => checkLimits(msg.askSocial(k, '@x'))).not.toThrow();
    expect(() => checkLimits(msg.pageUpdated('Saved.', 'https://go.hoolam.com/s/bayo-kicks'))).not.toThrow();
  });

  it('adds links, explains mistakes, and removes them', async () => {
    await h.tap(seller, 'card:s-instagram');
    expect(h.last(seller)).toMatch(/Instagram username or link/);
    await h.say(seller, 'https://www.instagram.com/BayoKicks/');
    expect(h.last(seller)).toMatch(/Instagram added to your page[\s\S]*go\.hoolam\.test\/s\//);
    await h.tap(seller, 'card:s-tiktok');
    await h.say(seller, 'bayo kicks');
    expect(h.last(seller)).toMatch(/no spaces/);
    await h.tap(seller, 'card:s-tiktok'); await h.say(seller, '@bayokicks');
    await h.tap(seller, 'card:s-website'); await h.say(seller, 'bayokicks.com');
    let t = (await h.app.trust.seller(sellerId))!;
    expect(t.socials.map((s) => s.label)).toEqual(['@bayokicks', '@bayokicks', 'bayokicks.com']);
    await h.tap(seller, 'card:rm-tiktok');
    t = (await h.app.trust.seller(sellerId))!;
    expect(t.socials.map((s) => s.kind)).toEqual(['instagram', 'website']);
    await h.tap(seller, 'menu:card');
    expect(h.last(seller)).toMatch(/🔗 Instagram @bayokicks · bayokicks\.com/);
  });

  it('asks for a photo, and says so if it can\'t be used', async () => {
    await h.tap(seller, 'card:photo');
    expect(h.last(seller)).toMatch(/Send a clear photo/);
    await h.say(seller, 'here');
    expect(h.last(seller)).toMatch(/Please send a photo/);
    await h.app.chat.handle({ id: 'img1', phone: seller, name: null, type: 'image', text: '', buttonId: null, mediaId: 'wa-media-1', mimeType: 'image/jpeg' } as any);
    expect(h.last(seller)).toMatch(/couldn't use that photo/); // no real WhatsApp in tests
    await h.tap(seller, 'card:cancel');
  });
});

describe('the public page', () => {
  it('shows the photo (square, small), the links and a share picture with the photo in it', async () => {
    const v = await h.app.trust.setPhoto(sellerId, await jpeg(3000, 2000));
    const t = (await h.app.trust.seller(sellerId))!;
    expect(t.photoVersion).toBe(v);
    const photo = await get(`/s/${t.slug}/photo.webp?v=${v}`);
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['cache-control']).toContain('immutable');
    expect((await sharp(photo.rawPayload).metadata())).toMatchObject({ width: 640, height: 640, format: 'webp' });

    const share = await get(`/s/${t.slug}/share.jpg?v=${v}`);
    expect(share.headers['content-type']).toBe('image/jpeg');
    expect(await sharp(share.rawPayload).metadata()).toMatchObject({ width: 1200, height: 630 });

    const page = (await get(`/s/${t.slug}`)).body;
    expect(page).toContain(`/s/${t.slug}/photo.webp?v=${v}`);
    expect(page).toContain(`content="https://go.hoolam.test/s/${t.slug}/share.jpg?v=${v}"`);
    expect(page).toContain('href="https://instagram.com/bayokicks" target="_blank" rel="noopener nofollow ugc"');
    expect(page).toContain('Bayo &lt;Kicks&gt;');
    expect(page).not.toContain('Bayo <Kicks>');
    expect(page).not.toMatch(/[✅👥👍📦⚖️🏦🛒💳🛡️]/u);
  });

  it('a hidden page hides the photo too', async () => {
    const t = (await h.app.trust.seller(sellerId))!;
    await h.app.trust.setPublic(sellerId, false);
    expect((await get(`/s/${t.slug}/photo.webp`)).statusCode).toBe(404);
    await h.app.trust.setPublic(sellerId, true);
  });
});

describe('the team can take things down', () => {
  it('removing a photo or a link needs a reason, the right role, and lands in the audit trail', async () => {
    const call = (method: string, url: string, body?: unknown, cookie?: string) => h.app.app.inject({ method: method as 'GET', url: `/console/api${url}`, headers: { 'x-hoolam-console': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const s = (await call('POST', '/auth/setup', { setupToken: ADMIN, name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' })).json();
    const e = await call('POST', '/auth/enroll', { ticket: s.ticket, code: totpCode(s.secret) });
    const owner = String(e.headers['set-cookie']).split(';')[0]!;
    expect((await call('GET', `/people/${sellerId}/photo`, undefined, owner)).statusCode).toBe(200);
    expect((await call('DELETE', `/people/${sellerId}/photo`, {}, owner)).statusCode).toBe(400);
    expect((await call('DELETE', `/people/${sellerId}/photo`, { reason: 'Not the seller' }, owner)).statusCode).toBe(200);
    expect((await call('PUT', `/people/${sellerId}/social`, { kind: 'website', value: null, reason: 'Links to another shop' }, owner)).statusCode).toBe(200);
    const t = (await h.app.trust.seller(sellerId))!;
    expect(t.photoVersion).toBeNull();
    expect(t.socials.map((x) => x.kind)).toEqual(['instagram']);
    const log = await h.db.query(`SELECT action, reason FROM audit_log WHERE target_id=$1 ORDER BY id`, [sellerId]);
    expect(log.rows.map((r) => r.action)).toEqual(['user.photo.remove', 'user.social']);
  });
});
