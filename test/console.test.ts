import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode, verifyTotp, base32Decode, base32Encode, hashPassword, verifyPassword } from '../src/console/crypto.js';

let h: Harness;
const ADMIN = 'test-admin-token-123456';
beforeAll(async () => { h = await startHarness({ quiet: true, env: { TRUST_COUNT_TEST_DEALS: 'true' } }); }, 120_000);
afterAll(async () => { await h?.stop(); });

type Res = { status: number; json: any; cookie?: string; headers: Record<string, unknown> };
async function call(method: string, url: string, body?: unknown, cookie?: string, opts: { noHeader?: boolean } = {}): Promise<Res> {
  const r = await h.app.app.inject({
    method: method as 'GET', url: `/console/api${url}`,
    headers: { ...(cookie ? { cookie } : {}), ...(opts.noHeader ? {} : { 'x-hoolam-console': '1' }), ...(body ? { 'content-type': 'application/json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers['set-cookie'];
  const cookieOut = typeof set === 'string' && set.includes('hoolam_console=') ? set.split(';')[0] : undefined;
  let json: any = null;
  try { json = r.json(); } catch { json = r.body; }
  return { status: r.statusCode, json, cookie: cookieOut, headers: r.headers };
}

let owner = '';
const secrets: Record<string, string> = {};

describe('first owner and signing in', () => {
  it('setup needs the ADMIN_TOKEN, then an authenticator code', async () => {
    expect((await call('GET', '/auth/state')).json.setupNeeded).toBe(true);
    expect((await call('POST', '/auth/setup', { setupToken: 'wrong', name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' })).status).toBe(401);
    expect((await call('POST', '/auth/setup', { setupToken: ADMIN, name: 'Raphael', email: 'r@hoolam.ng', password: 'short' })).status).toBe(400);
    const s = await call('POST', '/auth/setup', { setupToken: ADMIN, name: 'Raphael', email: 'R@Hoolam.ng', password: 'Str0ngPassw0rd' });
    expect(s.status).toBe(200);
    expect(s.json.qr).toMatch(/^data:image\/png;base64,/);
    secrets.owner = s.json.secret;
    expect((await call('POST', '/auth/enroll', { ticket: s.json.ticket, code: '000000' })).status).toBe(401);
    const e = await call('POST', '/auth/enroll', { ticket: s.json.ticket, code: totpCode(secrets.owner) });
    expect(e.status).toBe(200);
    expect(e.cookie).toMatch(/^hoolam_console=/);
    expect(String(e.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    owner = e.cookie!;
    expect((await call('GET', '/auth/state', undefined, owner)).json.me).toMatchObject({ name: 'Raphael', role: 'OWNER', email: 'r@hoolam.ng' });
    expect((await call('POST', '/auth/setup', { setupToken: ADMIN, name: 'X', email: 'x@y.co', password: 'Str0ngPassw0rd' })).status).toBe(409);
  });

  it('signing in takes a password and a code; wrong codes are refused', async () => {
    const l = await call('POST', '/auth/login', { email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' });
    expect(l.json.ticket).toBeTruthy();
    expect((await call('POST', '/auth/code', { ticket: l.json.ticket, code: '123456' })).status).toBe(401);
    const ok = await call('POST', '/auth/code', { ticket: l.json.ticket, code: totpCode(secrets.owner) });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toBeTruthy();
  });

  it('locks an account after 5 wrong passwords', async () => {
    const inv = await call('POST', '/team/invite', { email: 'lock@hoolam.ng', name: 'Lock Test', role: 'SUPPORT' }, owner);
    const token = inv.json.inviteUrl.split('/').pop();
    const a = await call('POST', `/auth/invite/${token}`, { password: 'Str0ngPassw0rd' });
    await call('POST', '/auth/enroll', { ticket: a.json.ticket, code: totpCode(a.json.secret) });
    for (let i = 0; i < 5; i++) expect((await call('POST', '/auth/login', { email: 'lock@hoolam.ng', password: 'nope-nope-1' })).status).toBe(401);
    expect((await call('POST', '/auth/login', { email: 'lock@hoolam.ng', password: 'Str0ngPassw0rd' })).status).toBe(429);
  });

  it('everything else needs a session, and changes need the console header', async () => {
    expect((await call('GET', '/inbox')).status).toBe(401);
    expect((await call('POST', '/inbox/dismiss', { key: 'rating:x' }, owner, { noHeader: true })).status).toBe(403);
  });
});

describe('roles and the audit trail', () => {
  let support = '';
  let code = '';

  it('an invited Support member signs up and can\'t move money', async () => {
    const inv = await call('POST', '/team/invite', { email: 'ada@hoolam.ng', name: 'Ada Support', role: 'SUPPORT' }, owner);
    expect(inv.json.inviteUrl).toMatch(/\/console\/invite\//);
    const token = inv.json.inviteUrl.split('/').pop();
    expect((await call('GET', `/auth/invite/${token}`)).json).toMatchObject({ name: 'Ada Support', role: 'SUPPORT' });
    const a = await call('POST', `/auth/invite/${token}`, { password: 'An0therGoodOne' });
    const e = await call('POST', '/auth/enroll', { ticket: a.json.ticket, code: totpCode(a.json.secret) });
    support = e.cookie!;
    expect((await call('GET', `/auth/invite/${token}`)).status).toBe(404); // one use only

    // a funded deal to act on
    const seller = '+2348090000001', buyer = '+2348090000002';
    await h.say(seller, 'hi', 'Bayo'); await h.sell(seller); await h.say(seller, 'Bag'); await h.say(seller, '10000');
    await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone'); await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes'); await h.tap(seller, 'sell:confirm');
    code = h.last(seller).match(/HL-[A-Z2-9]{5}/)![0];
    await h.say(buyer, `Pay ${code}`, 'Ada'); await h.tap(buyer, `pay:${code}`);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
    h.provider.pay(r.rows[0].provider_reference); await h.app.deals.handleCollection(r.rows[0].provider_reference);

    const denied = await call('POST', `/deals/${code}/release`, { reason: 'Buyer confirmed by phone' }, support);
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatch(/Support/);
    expect((await call('POST', `/deals/${code}/notes`, { note: 'Called the buyer, item arrived' }, support)).status).toBe(200);
  });

  it('the owner releases with a reason; the trail records who, when, why and what changed', async () => {
    expect((await call('POST', `/deals/${code}/release`, {}, owner)).status).toBe(400); // reason required
    const r = await call('POST', `/deals/${code}/release`, { reason: 'Buyer confirmed on a call' }, owner);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('COMPLETED');
    const trail = await call('GET', `/audit?target=${code}`, undefined, owner);
    const entry = trail.json.rows.find((x: any) => x.action === 'deal.release');
    expect(entry).toMatchObject({ actor: 'Raphael', role: 'OWNER', reason: 'Buyer confirmed on a call', target_type: 'deal', target_id: code });
    expect(entry.details).toMatchObject({ from: 'FUNDED', ok: true });
    expect(new Date(entry.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(trail.json.rows.some((x: any) => x.action === 'deal.note' && x.actor === 'Ada Support')).toBe(true);
    const detail = await call('GET', `/deals/${code}`, undefined, owner);
    expect(detail.json.notes[0]).toMatchObject({ note: 'Called the buyer, item arrived', by: 'Ada Support' });
    expect(detail.json.trail.map((t: any) => t.action)).toEqual(expect.arrayContaining(['deal.note', 'deal.release']));
    expect(detail.json.events.some((e: any) => /Buyer confirmed on a call \(by Raphael\)/.test(e.note ?? ''))).toBe(true);
  });

  it('the audit trail can\'t be edited or deleted, even directly in the database', async () => {
    await expect(h.db.query(`UPDATE audit_log SET actor='someone else'`)).rejects.toThrow(/append-only/);
    await expect(h.db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });

  it('failed attempts are in the trail too', async () => {
    await call('POST', `/deals/${code}/refund`, { reason: 'Testing a refund on a done deal' }, owner);
    const t = await call('GET', `/audit?action=deal.refund&target=${code}`, undefined, owner);
    expect(t.json.rows[0].details.ok).toBe(false);
  });

  it('support can\'t see the audit trail or change settings; only the owner manages the team', async () => {
    expect((await call('GET', '/audit', undefined, support)).status).toBe(403);
    expect((await call('PUT', '/settings', { changes: { fee_rate_percent: 3 }, reason: 'try' }, support)).status).toBe(403);
    expect((await call('GET', '/settings', undefined, support)).status).toBe(403);
    expect((await call('POST', '/team/invite', { email: 'z@z.co', name: 'Z', role: 'ADMIN' }, support)).status).toBe(403);
  });

  it('the last owner can\'t be removed or demoted', async () => {
    const me = (await call('GET', '/auth/state', undefined, owner)).json.me;
    expect((await call('POST', `/team/${me.id}/active`, { active: false }, owner)).status).toBe(400);
  });
});

describe('settings change the live service (new deals only)', () => {
  it('fee rate change applies to the next deal and is audited with before/after', async () => {
    const r = await call('PUT', '/settings', { changes: { fee_rate_percent: 5, fee_min: 500 }, reason: 'Pilot pricing test' }, owner);
    expect(r.status).toBe(200);
    expect(h.app.deals.previewDeal(2_000_000, 'seller').feeMinor).toBe(100_000); // 5% of ₦20,000
    const s = await call('GET', '/settings', undefined, owner);
    expect(s.json.history[0]).toMatchObject({ actor: 'Raphael', reason: 'Pilot pricing test' });
    expect(s.json.history[0].details.changes.fee_rate_percent).toEqual({ from: 2.5, to: 5 });
    expect((await call('PUT', '/settings', { changes: { fee_min: 9000, fee_max: 5000 }, reason: 'bad' }, owner)).status).toBe(400);
    expect((await call('PUT', '/settings', { changes: { fee_rate_percent: 99 }, reason: 'too high' }, owner)).status).toBe(400);
    await call('PUT', '/settings', { changes: { fee_rate_percent: 2.5, fee_min: 300 }, reason: 'Back to normal' }, owner);
  });
});

describe('people controls reach WhatsApp', () => {
  it('pausing someone stops their deals; a custom cap lets them go higher', async () => {
    const p = '+2348090000077';
    await h.say(p, 'hi', 'Kemi');
    const id = (await h.db.query('SELECT id FROM users WHERE phone=$1', [p])).rows[0].id;
    expect((await call('POST', `/people/${id}/cap`, { cap: 200000, reason: 'Verified wholesale seller' }, owner)).status).toBe(200);
    await h.sell(p); await h.say(p, 'Fridge'); await h.say(p, '150000');
    expect(h.last(p)).toMatch(/Add photos/); // allowed above the normal ₦50,000 cap
    expect((await call('POST', `/people/${id}/pause`, { paused: true, reason: 'Reported for fake photos' }, owner)).status).toBe(200);
    await h.say(p, 'hi');
    expect(h.last(p)).toMatch(/account is paused/);
    const person = await call('GET', `/people/${id}`, undefined, owner);
    expect(person.json.trail.map((t: any) => t.action)).toEqual(['user.pause', 'user.cap']);
  });
});

describe('screens\' data', () => {
  it('inbox, deals, money, insights, support, export all answer', async () => {
    const inbox = await call('GET', '/inbox', undefined, owner);
    expect(inbox.status).toBe(200);
    expect(inbox.json.counts).toHaveProperty('inbox');
    const deals = await call('GET', '/deals?q=Bag', undefined, owner);
    expect(deals.json.rows.length).toBeGreaterThan(0);
    const money = await call('GET', '/money', undefined, owner);
    expect(money.json.reconciled).toBe(true);
    const ins = await call('GET', '/insights?days=30', undefined, owner);
    expect(ins.json.kpis.completed).toBeGreaterThan(0);
    expect(ins.json.series).toHaveLength(30);
    const csv = await h.app.app.inject({ method: 'GET', url: '/console/api/money/export.csv', headers: { cookie: owner } });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\n')[0]).toMatch(/^code,created_at,status/);
    const search = await call('GET', '/search?q=Bayo', undefined, owner);
    expect(search.json.people.length).toBeGreaterThan(0);
  });

  it('support inbox: reply goes out on WhatsApp and is logged', async () => {
    const p = '+2348090000088';
    await h.say(p, 'hi', 'Tolu'); await h.say(p, '/human'); await h.say(p, 'Where is my refund?');
    const list = await call('GET', '/support', undefined, owner);
    const req = list.json.rows.find((r: any) => r.phone === p);
    const r = await call('POST', `/support/${req.id}/reply`, { text: 'It went out this morning.', close: true }, owner);
    expect(r.status).toBe(200);
    expect(h.last(p)).toMatch(/From the Hoolam team:\n\nIt went out this morning\./);
    const t = await call('GET', `/support/${req.id}`, undefined, owner);
    expect(t.json.request.status).toBe('CLOSED');
    expect(t.json.trail.map((x: any) => x.action)).toEqual(['support.reply', 'support.close']);
  });

  it('logout ends the session', async () => {
    const l = await call('POST', '/auth/login', { email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' });
    const s = (await call('POST', '/auth/code', { ticket: l.json.ticket, code: totpCode(secrets.owner) })).cookie!;
    expect((await call('GET', '/inbox', undefined, s)).status).toBe(200);
    await call('POST', '/auth/logout', {}, s);
    expect((await call('GET', '/inbox', undefined, s)).status).toBe(401);
  });
});

describe('crypto helpers', () => {
  it('passwords and authenticator codes', async () => {
    const hsh = await hashPassword('Correct horse 1');
    expect(await verifyPassword('Correct horse 1', hsh)).toBe(true);
    expect(await verifyPassword('wrong', hsh)).toBe(false);
    // RFC 6238 test vector (SHA1, secret "12345678901234567890", T=59s → 94287082, last 6 digits)
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '287082', 59_000 + 120_000)).toBe(false);
  });
});
