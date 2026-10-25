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
  h = await startHarness({ quiet: true, env: { TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: 'https://go.hoolam.test', SITE_URL: 'https://hoolam.test' } });
  await h.say(seller, 'hi', 'Bayo Adeyemi');
  await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
  sellerId = (await h.db.query('SELECT id FROM users WHERE phone=$1', [seller])).rows[0].id;
  await h.app.trust.setProfile(sellerId, { businessName: 'Bayo <Kicks>', city: 'Lagos' });
  await h.tap(seller, 'menu:card'); await h.tap(seller, 'setup:wname'); await h.tap(seller, 'setup:nocity'); // one-time seller setup
  await h.tap(seller, 'card:share');
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
    expect(await sharp(share.rawPayload).metadata()).toMatchObject({ width: 1600, height: 900 }); // their trust card, with today's numbers

    const page = (await get(`/s/${t.slug}`)).body;
    expect(page).toContain(`/s/${t.slug}/photo.webp?v=${v}`);
    expect(page).toContain(`content="https://go.hoolam.test/s/${t.slug}/share.jpg?v=${v}-`);
    // their links pass through us (counted for the seller), then on to Instagram
    expect(page).toContain(`href="https://go.hoolam.test/s/${t.slug}/go/instagram" data-social="instagram" target="_blank" rel="noopener nofollow ugc"`);
    const ig = await get(`/s/${t.slug}/go/instagram`);
    expect([ig.statusCode, ig.headers.location]).toEqual([302, 'https://instagram.com/bayokicks']);
    expect((await get(`/s/${t.slug}/go/tiktok`)).statusCode).toBe(404); // not one of theirs
    expect(page).toContain('Bayo &lt;Kicks&gt;');
    expect(page).not.toContain('Bayo <Kicks>');
    expect(page).not.toMatch(/[✅👥👍📦⚖️🏦🛒💳🛡️]/u);
    // Google Analytics with consent: everything starts denied; the banner and events come from hoolam.com's analytics.js
    expect(page).toContain(`window.HOOLAM_PAGE={seller:"${t.slug}"}`);
    expect(page).toContain("gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:/(?:^|;\\s*)hoolam_consent=yes/.test(document.cookie)?'granted':'denied'});");
    expect(page).toContain('<script async src="https://www.googletagmanager.com/gtag/js?id=G-J2YB5ZF1NE"></script>');
    expect(page).toContain('<script src="https://hoolam.test/assets/analytics.js" data-cookies="https://hoolam.test/legal/cookies/" defer></script>');
    // the photo is listed with the page in the sellers' sitemap, for Google Images
    expect((await get('/sitemap.xml')).body).toContain(`<loc>https://go.hoolam.test/s/${t.slug}</loc>`);
    expect((await get('/sitemap.xml')).body).toContain(`<image:image><image:loc>https://go.hoolam.test/s/${t.slug}/photo.webp?v=${v}</image:loc></image:image>`);
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

describe('the page builds trust before the buyer taps Buy', () => {
  it('shows what Hoolam checked, what happens next in pictures, the pay-only-through-Hoolam note and what Buy does', async () => {
    const t = (await h.app.trust.seller(sellerId))!;
    const page = (await get(`/s/${t.slug}`)).body;
    expect(page).toContain('<h2>What Hoolam checked</h2>');
    expect(page).toContain('<b>Their own WhatsApp number</b>');
    expect(page).toContain('What happens when you buy');
    for (const id of ['status-3', 'status-4', 'status-5', 'status-6']) expect(page).toContain(`https://go.hoolam.test/site/art/${id}`);
    expect(page).toContain('<b>Only pay through Hoolam.</b>');
    expect(page).toMatch(/Opens WhatsApp · No app or account · You pay only after Bayo &lt;Kicks&gt; accepts · Fee from ₦300/);
    expect(page).not.toContain('<video'); // Seller videos is off
  });

  it('an approved video plays in pieces (Range), so phones start it straight away', async () => {
    await h.db.query(`INSERT INTO settings (key, value) VALUES ('feature_seller_video', 'true') ON CONFLICT (key) DO UPDATE SET value='true'`);
    await h.app.settings.load();
    const bytes = Buffer.from('0123456789abcdef');
    await h.app.trust.setVideo(sellerId, bytes, 'video/mp4');
    const t0 = (await h.app.trust.seller(sellerId))!;
    expect((await get(`/s/${t0.slug}/video.mp4`)).statusCode).toBe(404); // not checked yet
    const [v] = await h.app.trust.videos();
    await h.app.trust.reviewVideo(v!.id, true, null, null);
    const t = (await h.app.trust.seller(sellerId))!;
    const page = (await get(`/s/${t.slug}`)).body;
    expect(page).toContain(`<video controls playsinline preload="none"`);
    expect(page).toContain('A message from Bayo &lt;Kicks&gt;, checked by Hoolam');
    const part = await h.app.app.inject({ method: 'GET', url: `/s/${t.slug}/video.mp4?v=${t.video!.version}`, headers: { range: 'bytes=0-3' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${bytes.length}`);
    expect(part.body).toBe('0123');
    const whole = await get(`/s/${t.slug}/video.mp4`);
    expect([whole.statusCode, whole.headers['accept-ranges'], whole.headers['content-type']]).toEqual([200, 'bytes', 'video/mp4']);
    await h.db.query(`UPDATE settings SET value='false' WHERE key='feature_seller_video'`); await h.app.settings.load();
    expect((await get(`/s/${t.slug}/video.mp4`)).statusCode).toBe(404);
  });
});
