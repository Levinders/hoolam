import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode } from '../src/console/crypto.js';

// Settings → Security → "Authenticator code at sign-in": off on a new install (the other console tests turn it on)
let h: Harness;
const ADMIN = 'test-admin-token-123456';
beforeAll(async () => { h = await startHarness({ quiet: true, twoStep: false }); }, 120_000);
afterAll(async () => { await h?.stop(); });

async function call(method: string, url: string, body?: unknown, cookie?: string) {
  const r = await h.app.app.inject({
    method: method as 'GET', url: `/console/api${url}`,
    headers: { ...(cookie ? { cookie } : {}), 'x-hoolam-console': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers['set-cookie'];
  const cookieOut = typeof set === 'string' && set.includes('hoolam_console=') ? set.split(';')[0] : undefined;
  let json: any = null;
  try { json = r.json(); } catch { json = r.body; }
  return { status: r.statusCode, json, cookie: cookieOut };
}
const login = (email: string, password = 'Str0ngPassw0rd') => call('POST', '/auth/login', { email, password });

describe('signing in without the authenticator code (the default)', () => {
  let owner = '';
  let adaToken = '';

  it('setup, invites and sign-in need only the email and password', async () => {
    expect((await call('GET', '/auth/state')).json).toMatchObject({ setupNeeded: true, twoStep: false });
    const s = await call('POST', '/auth/setup', { setupToken: ADMIN, name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' });
    expect(s.json).toEqual({ ok: true });
    owner = s.cookie!;
    expect((await call('GET', '/auth/state', undefined, owner)).json).toMatchObject({ setupNeeded: false, me: { name: 'Raphael' } });

    const inv = await call('POST', '/team/invite', { email: 'ada@hoolam.ng', name: 'Ada Support', role: 'SUPPORT' }, owner);
    adaToken = inv.json.inviteUrl.split('/').pop();
    expect((await call('GET', `/auth/invite/${adaToken}`)).json).toMatchObject({ twoStep: false });
    const a = await call('POST', `/auth/invite/${adaToken}`, { password: 'An0therGoodOne' });
    expect(a.json).toEqual({ ok: true });
    expect(a.cookie).toBeTruthy();

    const l = await login('r@hoolam.ng');
    expect(l.json).toEqual({ ok: true });
    expect((await call('GET', '/auth/state', undefined, l.cookie)).json.me.name).toBe('Raphael');
    expect((await login('r@hoolam.ng', 'wrong-password-1')).status).toBe(401);
    expect((await call('POST', '/team/invite', { email: 'ada@hoolam.ng', name: 'Ada', role: 'SUPPORT' }, owner)).status).toBe(409); // already joined
    const team = (await call('GET', '/team', undefined, owner)).json;
    expect(team.twoStep).toBe(false);
    expect(team.rows.find((x: any) => x.email === 'ada@hoolam.ng')).toMatchObject({ joined: true, totp_enabled: false });
  });

  it('only an owner switches the code on; then people without an authenticator set one up after their password', async () => {
    const ada = (await login('ada@hoolam.ng', 'An0therGoodOne')).cookie!;
    expect((await call('PUT', '/settings', { changes: { two_step_login: true }, reason: 'turning the code on' }, ada)).status).toBe(403);
    expect((await call('PUT', '/settings', { changes: { two_step_login: true }, reason: 'turning the code on' }, owner)).status).toBe(200);
    expect((await call('GET', '/auth/state')).json.twoStep).toBe(true);

    const l = await login('ada@hoolam.ng', 'An0therGoodOne');
    expect(l.json.enroll).toBe(true);
    expect(l.cookie).toBeUndefined();
    expect((await call('POST', '/auth/enroll', { ticket: l.json.ticket, code: '000000' })).status).toBe(401);
    const e = await call('POST', '/auth/enroll', { ticket: l.json.ticket, code: totpCode(l.json.secret) });
    expect(e.cookie).toBeTruthy();

    const again = await login('ada@hoolam.ng', 'An0therGoodOne');
    expect(again.json.ticket).toBeTruthy();
    expect(again.json.enroll).toBeUndefined();
    expect((await call('POST', '/auth/code', { ticket: again.json.ticket, code: totpCode(l.json.secret) })).cookie).toBeTruthy();
  });

  it('switching it off again keeps the authenticators; Reset login stops the old password', async () => {
    expect((await call('PUT', '/settings', { changes: { two_step_login: false }, reason: 'off for now' }, owner)).status).toBe(200);
    expect((await login('ada@hoolam.ng', 'An0therGoodOne')).json).toEqual({ ok: true });
    const team = (await call('GET', '/team', undefined, owner)).json;
    const ada = team.rows.find((x: any) => x.email === 'ada@hoolam.ng');
    expect(ada.totp_enabled).toBe(true);

    const r = await call('POST', `/team/${ada.id}/reset`, undefined, owner);
    expect(r.json.inviteUrl).toBeTruthy();
    expect((await login('ada@hoolam.ng', 'An0therGoodOne')).status).toBe(401);
    const a = await call('POST', `/auth/invite/${r.json.inviteUrl.split('/').pop()}`, { password: 'BrandN3wPassword' });
    expect(a.json).toEqual({ ok: true });
    expect((await login('ada@hoolam.ng', 'BrandN3wPassword')).json).toEqual({ ok: true });
  });
});
