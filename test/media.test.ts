import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode } from '../src/console/crypto.js';

let h: Harness;
let owner = '';
let support = '';
let admin = '';
const ADMIN = 'test-admin-token-123456';

async function call(method: string, url: string, opts: { body?: unknown; raw?: Buffer; type?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const r = await h.app.app.inject({
    method: method as 'GET', url,
    headers: { 'x-hoolam-console': '1', ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.type ? { 'content-type': opts.type } : {}), ...opts.headers },
    payload: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  let json: any = null; try { json = r.json(); } catch { /* not JSON */ }
  return { status: r.statusCode, json, headers: r.headers, raw: r.rawPayload };
}
const cookieOf = (h: Record<string, unknown>) => String(h['set-cookie']).split(';')[0]!;

beforeAll(async () => {
  h = await startHarness({ quiet: true, env: { WHATSAPP_PUBLIC_NUMBER: '15551380045' } });
  const s = await call('POST', '/console/api/auth/setup', { body: { setupToken: ADMIN, name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' } });
  const e = await call('POST', '/console/api/auth/enroll', { body: { ticket: s.json.ticket, code: totpCode(s.json.secret) } });
  owner = cookieOf(e.headers);
  const inv = await call('POST', '/console/api/team/invite', { body: { email: 'ada@hoolam.ng', name: 'Ada', role: 'SUPPORT' }, cookie: owner });
  const a = await call('POST', `/console/api/auth/invite/${inv.json.inviteUrl.split('/').pop()}`, { body: { password: 'Str0ngPassw0rd' } });
  support = cookieOf((await call('POST', '/console/api/auth/enroll', { body: { ticket: a.json.ticket, code: totpCode(a.json.secret) } })).headers);
  const inv2 = await call('POST', '/console/api/team/invite', { body: { email: 'tunde@hoolam.ng', name: 'Tunde', role: 'ADMIN' }, cookie: owner });
  const b = await call('POST', `/console/api/auth/invite/${inv2.json.inviteUrl.split('/').pop()}`, { body: { password: 'Str0ngPassw0rd' } });
  admin = cookieOf((await call('POST', '/console/api/auth/enroll', { body: { ticket: b.json.ticket, code: totpCode(b.json.secret) } })).headers);
}, 120_000);
afterAll(async () => { await h?.stop(); });

const photo = (w: number, h2: number) => sharp({ create: { width: w, height: h2, channels: 3, background: '#C9992E' } }).jpeg().toBuffer();

describe('logo and website images', () => {
  it('an owner uploads a photo: it is resized for phones, stored as WebP and served with a version', async () => {
    const r = await call('PUT', '/console/api/media/s2-1', { raw: await photo(4000, 3000), type: 'image/jpeg', cookie: owner, headers: { 'x-file-name': 'street.jpg' } });
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ mime: 'image/webp', width: 1400, height: 1050 });
    const url: string = r.json.item.url;
    expect(url).toMatch(/^\/media\/s2-1\?v=[0-9a-f]{12}$/);
    const img = await call('GET', url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(img.headers['access-control-allow-origin']).toBe('*');
  });

  it('the website gets every uploaded image from /site.json', async () => {
    const j = (await call('GET', '/site.json')).json;
    expect(Object.keys(j.images)).toEqual(['s2-1']);
    expect(j.images['s2-1'].url).toMatch(/\/media\/s2-1\?v=/);
  });

  it('logos can be SVG, but not SVG with scripts; photos can\'t be SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0E5C63"/></svg>');
    expect((await call('PUT', '/console/api/media/logo', { raw: svg, type: 'image/svg+xml', cookie: owner })).status).toBe(200);
    const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await call('PUT', '/console/api/media/mark', { raw: bad, type: 'image/svg+xml', cookie: owner });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/scripts/);
    expect((await call('PUT', '/console/api/media/s1-1', { raw: svg, type: 'image/svg+xml', cookie: owner })).status).toBe(400);
    const served = await call('GET', '/media/logo');
    expect(served.headers['content-security-policy']).toContain('sandbox');
  });

  it('the console reads the logo, even on the sign-in page', async () => {
    const b = await call('GET', '/console/api/auth/brand');
    expect(b.json.logo).toMatch(/^\/media\/logo\?v=/);
    expect(b.json.mark).toBeNull();
  });

  it('rejects files that aren\'t images, unknown spots, and non-owners', async () => {
    expect((await call('PUT', '/console/api/media/s1-1', { raw: Buffer.from('hello'), type: 'image/png', cookie: owner })).json.error).toMatch(/isn't an image/);
    expect((await call('PUT', '/console/api/media/hero', { raw: await photo(10, 10), type: 'image/jpeg', cookie: owner })).status).toBe(404);
    expect((await call('PUT', '/console/api/media/s1-1', { raw: await photo(10, 10), type: 'image/jpeg', cookie: support })).status).toBe(403);
  });

  it('removing an image brings the drawing back, and both are in the audit trail', async () => {
    expect((await call('DELETE', '/console/api/media/s2-1', { cookie: owner })).status).toBe(200);
    expect((await call('GET', '/media/s2-1')).status).toBe(404);
    expect((await call('GET', '/site.json')).json.images['s2-1']).toBeUndefined();
    const log = await h.db.query(`SELECT action, actor, target_id, details FROM audit_log WHERE action LIKE 'media.%' ORDER BY id`);
    expect(log.rows.map((r) => [r.action, r.target_id, r.actor])).toEqual([
      ['media.upload', 's2-1', 'Raphael'], ['media.upload', 'logo', 'Raphael'], ['media.upload', 'mark', 'Raphael'], ['media.upload', 's1-1', 'Raphael'],
      ['media.upload', 's1-1', 'Raphael'], ['media.remove', 's2-1', 'Raphael'],
    ]);
    expect(log.rows[0].details).toMatchObject({ where: 'Section 2 · Image 1', file: 'street.jpg', ok: true });
    expect(log.rows[2].details.ok).toBe(false);
  });
});

describe('Hoolam\'s WhatsApp number from settings', () => {
  it('starts from Render\'s number', async () => {
    expect((await call('GET', '/site.json')).json.whatsapp).toBe('15551380045');
  });

  it('refuses numbers without a country code', async () => {
    const r = await call('PUT', '/console/api/settings', { body: { changes: { whatsapp_number: '08012345678' }, reason: 'New number' }, cookie: owner });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/country code/);
  });

  it('a new number changes the website, the chat link and deal links', async () => {
    const r = await call('PUT', '/console/api/settings', { body: { changes: { whatsapp_number: '+234 801 234 5678' }, reason: 'Real number is live' }, cookie: owner });
    expect(r.status).toBe(200);
    expect((await call('GET', '/site.json')).json.whatsapp).toBe('2348012345678');
    expect((await call('GET', '/chat')).headers.location).toContain('wa.me/2348012345678');
    expect(h.app.deals.payLink('HL-ABCDE')).toContain('wa.me/2348012345678');
  });
});

describe('who can see and change settings', () => {
  it('support and finance can\'t open settings at all', async () => {
    expect((await call('GET', '/console/api/settings', { cookie: support })).status).toBe(403);
    expect((await call('GET', '/console/api/media', { cookie: support })).status).toBe(403);
    const me = (await call('GET', '/console/api/auth/state', { cookie: support })).json.me;
    expect(me.can).not.toContain('settings.view');
  });

  it('admins see everything, change timing and switches, but not fees, limits or the number', async () => {
    expect((await call('GET', '/console/api/settings', { cookie: admin })).status).toBe(200);
    expect((await call('PUT', '/console/api/settings', { body: { changes: { nudge_after_hours: 30 }, reason: 'Remind a bit later' }, cookie: admin })).status).toBe(200);
    for (const changes of [{ fee_rate_percent: 3 }, { max_deal: 90_000 }, { whatsapp_number: '2348099990000' }, { nudge_after_hours: 31, fee_min: 500 }]) {
      const r = await call('PUT', '/console/api/settings', { body: { changes, reason: 'Trying it' }, cookie: admin });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/Only an owner/);
    }
    expect(h.app.settings.get('fee_min')).toBe(300);
    expect(h.app.settings.get('nudge_after_hours')).toBe(30);
  });

  it('admins can change the logo and website images', async () => {
    expect((await call('PUT', '/console/api/media/s5-1', { raw: await photo(300, 300), type: 'image/jpeg', cookie: admin })).status).toBe(200);
    expect((await call('DELETE', '/console/api/media/s5-1', { cookie: admin })).status).toBe(200);
  });
});
