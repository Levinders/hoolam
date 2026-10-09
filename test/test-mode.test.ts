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
    await h.tap(me, 'menu:sell');
    await h.say(me, 'Test sneakers');
    await h.say(me, '10000');
    await h.tap(me, 'sell:nophotos');
    await h.tap(me, 'sell:nophone');
    await h.say(me, '0123456789 GTBank');
    await h.tap(me, 'bank:yes');
    await h.tap(me, 'sell:confirm');
    const code = h.last(me).match(/HL-[A-Z2-9]{5}/)![0];

    await h.say(me, `Pay ${code}`);
    expect(h.last(me)).toMatch(/You pay: ₦10,000/);
    await h.tap(me, `pay:${code}`);
    expect(h.last(me)).toMatch(/TEST MODE: no real money/);

    await h.say(me, 'paid');
    const status = async () => (await h.db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0].status;
    expect(await status()).toBe('FUNDED');
    await h.tap(me, `shipped:${code}`);
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
});
