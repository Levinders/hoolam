import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { linkTarget } from '../src/links.js';
import { compact, PUBLIC_VIEWS_FROM } from '../src/trust.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
beforeAll(async () => { h = await startHarness({ quiet: true, env: { PUBLIC_BASE_URL: 'https://go.hoolam.test', SITE_URL: 'https://hoolam.test', TRUST_COUNT_TEST_DEALS: 'true' } }); }, 120_000);
afterAll(async () => { await h?.stop(); });

const PHONE = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' };
const get = (url: string, headers: Record<string, string> = PHONE, ip = '102.89.1.1') => h.app.app.inject({ method: 'GET', url, headers, remoteAddress: ip });

describe('campaign links (hoolam.com/<name>)', () => {
  it('turns a short name and where it\'s posted into the tags Analytics reads', () => {
    expect(linkTarget({ slug: 'ig', source: 'instagram', campaign: 'launch', page: '/' })).toBe('/?utm_source=instagram&utm_medium=social&utm_campaign=launch&utm_content=ig');
    expect(linkTarget({ slug: 'flyer-yaba', source: 'flyer', campaign: null, page: '/' })).toBe('/?utm_source=flyer&utm_medium=print&utm_campaign=flyer-yaba');
    expect(linkTarget({ slug: 'radio', source: 'other', campaign: null, page: '/about/' })).toBe('/about/?utm_source=radio&utm_medium=referral&utm_campaign=radio');
  });

  it('checks names, never takes a page the website uses, and counts taps', async () => {
    await expect(h.app.links.create(null, { slug: 'a', source: 'instagram' })).rejects.toThrow(/short name/);
    await expect(h.app.links.create(null, { slug: 'about', source: 'instagram' })).rejects.toThrow(/already used by the website/);
    await expect(h.app.links.create(null, { slug: 'ig', source: 'carrier-pigeon' })).rejects.toThrow(/where you'll post/);
    const l = await h.app.links.create(null, { slug: ' IG Bio ', source: 'instagram', campaign: 'Launch Week' });
    expect(l).toMatchObject({ slug: 'ig-bio', campaign: 'launch-week', page: '/' });
    await expect(h.app.links.create(null, { slug: 'ig-bio', source: 'tiktok' })).rejects.toThrow(/already exists/);
    // the website gets each link's address and target
    const site = (await h.app.app.inject({ method: 'GET', url: '/site.json' })).json();
    expect(site.links).toEqual([{ slug: 'ig-bio', target: '/?utm_source=instagram&utm_medium=social&utm_campaign=launch-week&utm_content=ig-bio' }]);
    // its page on the website counts the tap (bots don't count)
    const tap = await h.app.app.inject({ method: 'POST', url: '/l/ig-bio/tap', headers: { ...PHONE, 'content-type': 'text/plain' }, payload: '' });
    expect([tap.statusCode, tap.headers['access-control-allow-origin']]).toEqual([204, '*']);
    await h.app.app.inject({ method: 'POST', url: '/l/ig-bio/tap', headers: { 'user-agent': 'Googlebot/2.1', 'content-type': 'text/plain' }, payload: '' });
    await h.app.app.inject({ method: 'POST', url: '/l/nope/tap', headers: { ...PHONE, 'content-type': 'text/plain' }, payload: '' });
    expect((await h.app.links.list())[0]).toMatchObject({ slug: 'ig-bio', taps7: 1, tapsTotal: 1 });
    expect(await h.app.links.remove('ig-bio')).toBe(true);
    expect((await h.app.links.forSite())).toEqual([]);
  });
});

describe('seller page stats', () => {
  let id = '', slug = '';
  it('counts views once per visitor a day (bots and link previews don\'t count), and Buy taps', async () => {
    const p = '+2348031119999';
    await h.say(p, 'hi', 'Ada Obi'); await h.tap(p, 'menu:account'); await h.say(p, '0123456789 GTBank'); await h.tap(p, 'bank:yes');
    id = (await h.db.query('SELECT id FROM users WHERE phone=$1', [p])).rows[0].id;
    await h.db.query("UPDATE users SET business_name='Ada Wigs', city='Abuja' WHERE id=$1", [id]);
    slug = (await h.app.trust.setPublic(id, true))!;
    await get(`/s/${slug}`); await get(`/s/${slug}`); // same visitor twice: one view
    await get(`/s/${slug}`, PHONE, '102.89.2.2');      // another visitor
    await get(`/s/${slug}`, { 'user-agent': 'WhatsApp/2.23.20.0' }); // link preview
    await get(`/s/${slug}`, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    await get(`/s/${slug}/buy`); await get(`/s/${slug}/buy`);
    expect(await h.app.trust.pageStats(id)).toEqual({ views30: 2, buys30: 1, socials30: 0, total: 2, totalBuys: 1 });
    // only one-way codes are kept, never the IP, and only for 2 days
    const seen = (await h.db.query('SELECT visitor FROM seller_page_seen WHERE user_id=$1', [id])).rows;
    expect(seen.length).toBe(3);
    expect(JSON.stringify(seen)).not.toContain('102.89');
  });

  it('the Features switch decides who sees the numbers; counting never stops', async () => {
    // off (the default): nobody sees them
    let t = (await h.app.trust.seller(id))!;
    expect([t.pageViews, t.ownStats]).toEqual([null, null]);
    expect((await get(`/s/${slug}`, { 'user-agent': 'bot' })).body).not.toContain('page views');
    // on: the seller sees theirs; buyers only from 50 views
    await h.app.settings.save(h.db, { feature_seller_stats: true }, null);
    t = (await h.app.trust.seller(id))!;
    expect(t.ownStats).toEqual({ views30: 2, buys30: 1, total: 2 });
    expect(t.pageViews).toBeNull();
    expect(msg.myTrustCard(msg.trustCardText(t), 'https://go.hoolam.test/s/x', t.ownStats).text).toContain('📊 Last 30 days: *2* views · *1* tapped Buy');
    await h.db.query(`INSERT INTO seller_page_stats (user_id, day, views) VALUES ($1, current_date - 40, $2)`, [id, PUBLIC_VIEWS_FROM + 1200]);
    t = (await h.app.trust.seller(id))!;
    expect(t.pageViews).toBe(PUBLIC_VIEWS_FROM + 1202);
    expect(msg.trustCardText(t)).toContain('👀 1.2k page views');
    expect((await get(`/s/${slug}`, { 'user-agent': 'bot' })).body).toMatch(/<b>1\.2k<\/b>[\s\S]*page views/);
    // a hidden page shows nothing to buyers
    await h.app.trust.setPublic(id, false);
    expect((await h.app.trust.seller(id))!.pageViews).toBeNull();
    await h.app.settings.save(h.db, { feature_seller_stats: false }, null);
  });

  it('writes counts short', () => {
    expect([0, 49, 999, 1000, 1049, 1250, 15_400, 999_999, 1_000_000, 1_250_000].map(compact)).toEqual(['0', '49', '999', '1k', '1k', '1.2k', '15.4k', '999.9k', '1m', '1.2m']);
  });
});
