import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { addMonths, monthKey, normPhone, tidyName } from '../src/ambassadors.js';
import { ambApplyFlowJson, ambDetailsFlowJson, detailsToken } from '../src/whatsapp/amb-flow.js';
import type { FakeKycChecker } from '../src/kyc.js';

let h: Harness;
let seq = 0;
beforeAll(async () => {
  h = await startHarness({ quiet: true, env: { KYC_PROVIDER: 'fake', ALLOW_SELF_DEAL: 'true', TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: 'https://go.hoolam.test', SITE_URL: 'https://hoolam.test' } });
  await h.app.settings.save(h.db, { feature_ambassadors: true, amb_bonus_orders: 2 }, null);
}, 120_000);
afterAll(async () => { await h?.stop(); });

const phone = () => `+2348090000${String(++seq).padStart(3, '0')}`;
const user = async (p: string) => (await h.db.query('SELECT * FROM users WHERE phone=$1', [p])).rows[0];
const amb = () => h.app.ambassadors;
const apply = (p: string, extra: Record<string, unknown> = {}) => h.app.app.inject({
  method: 'POST', url: '/ambassadors/apply', headers: { 'content-type': 'text/plain' },
  payload: JSON.stringify({ name: 'Tobi Adeyemi', phone: p, state: 'Lagos', city: 'Yaba', community: 'UNILAG', knows: ['vendors', 'students'], channels: ['status', 'instagram'], reach: '500_2000', sells: 'no', agree: true, ...extra }),
});

/** A seller who has checked their ID and saved a payout account (so their orders go straight through). */
async function readySeller(p: string, shop: string) {
  const u = await user(p);
  await h.db.query(`UPDATE users SET kyc_status='VERIFIED', kyc_verified_at=now(), kyc_name='Test Account Holder', seller_since=now(), menu_mode='seller', business_name=$2 WHERE id=$1`, [u.id, shop]);
  await h.app.deals.saveBankAccount(u.id, { bank_code: '058', bank_name: 'GTBank', account_number: p.slice(-10), account_name: 'TEST ACCOUNT HOLDER' });
}

/** Applies, is approved, and finishes setup in WhatsApp. Returns their link name. */
async function becomeAmbassador(p: string, name: string, term = '6'): Promise<string> {
  await h.say(p, 'hi', name.split(' ')[0]);
  expect((await apply(p, { name })).statusCode).toBe(200);
  const app = (await h.db.query(`SELECT id FROM ambassador_applications WHERE phone=$1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];
  await amb().approve(Number(app.id), null);
  expect(h.last(p)).toMatch(/You're in[\s\S]*Get started/);
  await h.tap(p, 'amb:setup');
  expect(h.last(p)).toMatch(/First, a quick ID check/);
  const num = `2221${p.slice(-7)}`;
  (h.app.checker as FakeKycChecker).names[num] = name.toUpperCase(); // the name on their ID, and on their bank account
  h.provider.accountNames[`058:${p.slice(-10)}`] = name.toUpperCase();
  await h.tap(p, 'kyc:bvn'); await h.say(p, '25/12/1995'); await h.say(p, num);
  expect(h.last(p)).toMatch(/account number/);
  await h.say(p, `${p.slice(-10)} GTBank`); await h.tap(p, 'bank:yes');
  expect(h.last(p)).toMatch(/Choose your term[\s\S]*whatever term you pick/);
  await h.tap(p, `amb:term:${term}`);
  expect(h.last(p)).toMatch(/Type the name for your link/);
  return name.toLowerCase().split(' ')[0]!;
}
async function finishWithName(p: string, slug: string) {
  await h.say(p, slug);
  expect(h.last(p)).toMatch(/Add your photo \(optional\)/);
  await h.tap(p, 'amb:nophoto');
  expect(h.last(p)).toMatch(/You're live[\s\S]*hoolam\.test\/a\//);
}

describe('applying', () => {
  it('checks the website form and keeps one open application per number', async () => {
    const p = phone();
    expect((await apply(p, { state: 'Atlantis' })).json().error).toMatch(/Choose your state/);
    expect((await apply(p, { knows: [] })).json().error).toMatch(/who you know/);
    expect((await apply(p, { agree: false })).json().error).toMatch(/agree/);
    expect((await apply('12345')).json().error).toMatch(/WhatsApp number/);
    const ok = await apply(p);
    expect([ok.statusCode, ok.json().ok, ok.headers['access-control-allow-origin']]).toEqual([200, true, '*']);
    expect((await apply(p)).json().already).toBe(true);
    const rows = await amb().applications('PENDING');
    expect(rows.find((r) => r.phone === normPhone(p))).toMatchObject({ name: 'Tobi Adeyemi', state: 'Lagos', knows: ['vendors', 'students'], source: 'website' });
  });

  it('declining tells them kindly; the form is closed while the feature is off', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Kemi');
    await apply(p, { name: 'Kemi Bello' });
    const app = (await h.db.query(`SELECT id FROM ambassador_applications WHERE phone=$1`, [p])).rows[0];
    await amb().decline(Number(app.id), null, 'Not in our area yet');
    expect(h.last(p)).toMatch(/thank you for applying[\s\S]*apply again later/);
    await h.app.settings.save(h.db, { feature_ambassadors: false }, null);
    expect((await apply(phone())).statusCode).toBe(403);
    await h.app.settings.save(h.db, { feature_ambassadors: true }, null);
  });

  it('the WhatsApp form has 4 short steps, and its answers make an application', async () => {
    const f = ambApplyFlowJson();
    expect(f.screens.map((s) => s.id)).toEqual(['ABOUT', 'WHERE', 'REACH', 'CHECK']);
    expect(f.screens.map((s) => s.title)).toEqual(['About you (1 of 4)', 'Where you are (2 of 4)', 'Your reach (3 of 4)', 'Check and send (4 of 4)']);
    expect(ambDetailsFlowJson().routing_model).toEqual({ MONTH: ['PEOPLE', 'ACCOUNT'] });
    const p = phone();
    await h.say(p, 'hi', 'Ada');
    await h.app.chat.handle({ id: 'f1', phone: p, name: null, type: 'form', text: '', buttonId: null, mediaId: null,
      form: { flow_token: 'amb-apply', name: 'Ada Obi', email: '', state: 'Rivers', city: 'Woji', community: '', knows: ['vendors'], channels: ['groups'], handle: '', reach: 'under_500', sells: 'yes', why: 'I know many vendors', agree: true } } as any);
    expect(h.last(p)).toMatch(/Application sent[\s\S]*within 24 hours/);
    expect((await h.db.query(`SELECT source, sells_online FROM ambassador_applications WHERE phone=$1`, [p])).rows[0]).toEqual({ source: 'whatsapp', sells_online: true });
  });
});

describe('setting up and the link name', () => {
  let tobi = '';
  it('approval → ID check → payout account → term → link name → live', async () => {
    tobi = phone();
    await becomeAmbassador(tobi, 'Tobi Adeyemi');
    await h.say(tobi, 'about');
    expect(h.last(tobi)).toMatch(/reserved/);
    await h.say(tobi, 'Tobi UNILAG');
    await h.tap(tobi, 'amb:nophoto');
    const a = await amb().get((await user(tobi)).id);
    expect(a).toMatchObject({ status: 'ACTIVE', slug: 'tobi-unilag', term_months: 6 });
    const months = (new Date(a!.term_ends_at!).getTime() - new Date(a!.term_started_at!).getTime()) / 86400_000;
    expect(months).toBeGreaterThan(180); expect(months).toBeLessThan(186);
    expect(h.transcript.filter((t) => t.phone === tobi).map((t) => t.text).join('\n')).toMatch(/You're live, Tobi[\s\S]*hoolam\.test\/a\/tobi-unilag[\s\S]*Never collect money for Hoolam/);
  });

  it('names are first come, never reused, and can\'t clash with campaign links', async () => {
    expect(tidyName(' Mama  Bella_PH ')).toBe('mama-bella-ph');
    expect(await amb().checkName('tobi-unilag')).toMatchObject({ ok: false });
    expect(await amb().checkName('TOBI-UNILAG')).toMatchObject({ ok: false });
    await expect(h.app.links.create(null, { slug: 'tobi-unilag', source: 'instagram' })).rejects.toThrow(/already exists/);
    await h.app.links.create(null, { slug: 'promo-ig', source: 'instagram' });
    expect(await amb().checkName('promo-ig')).toMatchObject({ ok: false, why: expect.stringMatching(/already used by Hoolam/) });
    // a changed name keeps the old one reserved, and it moves people to the new one
    const id = (await user(tobi)).id;
    await amb().claimName(id, 'tobi');
    const site = await amb().forSite();
    expect(site.find((x) => x.slug === 'tobi-unilag')).toMatchObject({ to: 'tobi', active: true });
    expect(site.find((x) => x.slug === 'tobi')).toMatchObject({ to: null, name: 'Tobi', area: 'UNILAG' });
    expect(await amb().checkName('tobi-unilag', 'someone-else')).toMatchObject({ ok: false });
  });

  it('the menu shows the right row for each person', async () => {
    expect(await amb().menuRow({ id: (await user(tobi)).id })).toMatchObject({ title: '🤝 Ambassador', description: 'Your earnings, link and term' });
    const fresh = phone(); await h.say(fresh, 'hi', 'Joy');
    expect(await amb().menuRow({ id: (await user(fresh)).id })).toBeNull(); // no completed order yet
    await h.app.settings.save(h.db, { amb_menu_after: 0 }, null);
    expect(await amb().menuRow({ id: (await user(fresh)).id })).toMatchObject({ title: '🤝 Become an ambassador' });
    await h.tap(fresh, 'menu:open');
    expect(h.last(fresh)).toMatch(/Become an ambassador/);
    await h.app.settings.save(h.db, { amb_menu_after: 1, feature_ambassadors: false }, null);
    expect(await amb().menuRow({ id: (await user(tobi)).id })).toBeNull();
    await h.app.settings.save(h.db, { feature_ambassadors: true }, null);
  });
});

describe('who brought whom, and earnings', () => {
  let a = '', aId = '', slug = '';
  beforeAll(async () => {
    a = phone();
    slug = await becomeAmbassador(a, 'Chioma Eze');
    await finishWithName(a, slug);
    aId = (await user(a)).id;
  }, 60_000);

  it('a new person from their link is theirs; existing users, the ambassador and repeats are not', async () => {
    const s = phone();
    await h.say(s, `Hi Hoolam, I want to sell safely. Chioma sent me (${slug.toUpperCase()})`, 'Mama Bella');
    expect(h.last(s)).toMatch(/Set up as a seller/); // straight into selling, no extra question
    expect(h.last(a)).toMatch(/Someone joined Hoolam with your link/);
    const r = (await h.db.query('SELECT * FROM ambassador_referrals WHERE referred_id=$1', [(await user(s)).id])).rows[0];
    expect(r).toMatchObject({ ambassador_id: aId, via: 'link', slug });
    expect(await amb().attribute(await user(a), slug, 'link')).toBe('self');
    expect(await amb().attribute(await user(s), slug, 'link')).toBe('not-new');
    expect(await amb().attribute(await user(s), 'nobody-here', 'link')).toBe('unknown');
  });

  it('someone new is asked once, before their first order', async () => {
    const b = phone();
    await h.say(b, 'hi', 'Koffi');
    await h.tap(b, 'menu:buy');
    expect(h.last(b)).toMatch(/did a \*Hoolam ambassador\* send you/);
    await h.say(b, slug);
    expect(h.transcript.filter((t) => t.phone === b).map((t) => t.text).join('\n')).toMatch(/We've noted that Chioma sent you/);
    expect(h.last(b)).toMatch(/What are you buying/);
    expect((await h.db.query('SELECT ambassador_id, via FROM ambassador_referrals WHERE referred_id=$1', [(await user(b)).id])).rows[0]).toEqual({ ambassador_id: aId, via: 'code' });
    await h.tap(b, 'menu:buy');
    expect(h.last(b)).not.toMatch(/ambassador/); // once only
  });

  it('a completed order earns the share of everything Hoolam made, in the ledger; the bonus after the seller\'s orders', async () => {
    const s = phone(), b = phone();
    await h.say(s, `Hi Hoolam, I want to sell safely. Chioma sent me (${slug})`, 'Bayo');
    await readySeller(s, 'Bayo');
    for (let i = 0; i < 2; i++) {
      const code = await h.sellOrder(s, b, { price: '20000' });
      await h.say(b, 'hi', 'Ngozi'); await h.app.ambassadors.markAsked((await user(b)).id);
      await h.acceptOrder(b, code);
      await h.say(b, 'paid');
      await h.handOver(s, code);
      await h.tap(b, `happy:${code}`);
      const d = (await h.db.query('SELECT id, buyer_pays_minor - seller_gets_minor AS rev FROM deals WHERE code=$1', [code])).rows[0];
      const e = (await h.db.query(`SELECT * FROM ambassador_earnings WHERE deal_id=$1 AND kind='SHARE'`, [d.id])).rows[0];
      expect(e).toMatchObject({ ambassador_id: aId, side: 'SELLER', status: 'CONFIRMED', revenue_minor: Number(d.rev), amount_minor: Math.floor(Number(d.rev) * 0.2) });
    }
    const bonus = (await h.db.query(`SELECT * FROM ambassador_earnings WHERE ambassador_id=$1 AND kind='BONUS'`, [aId])).rows;
    expect(bonus).toHaveLength(1);
    expect(Number(bonus[0].amount_minor)).toBe(100_000);
    expect(h.transcript.filter((t) => t.phone === a).map((t) => t.text).join('\n')).toMatch(/\*Bayo\* completed 2 orders[\s\S]*₦1,000\* bonus/);
    const ledger = (await h.db.query(`SELECT account, sum(amount_minor)::bigint AS b FROM ledger_entries WHERE account IN ('expense:ambassadors','payable:ambassador') GROUP BY account`)).rows;
    const total = Number((await h.db.query(`SELECT sum(amount_minor)::bigint AS t FROM ambassador_earnings WHERE status='CONFIRMED'`)).rows[0].t);
    expect(Object.fromEntries(ledger.map((x) => [x.account, Number(x.b)]))).toEqual({ 'expense:ambassadors': total, 'payable:ambassador': -total });
  }, 60_000);

  it('an order the ambassador is part of is held for the team', async () => {
    const s = phone();
    await h.say(s, `Hi Hoolam, I want to sell safely. Chioma sent me (${slug})`, 'Femi');
    await readySeller(s, 'Femi Wears');
    const code = await h.sellOrder(s, a, { price: '15000' });
    await h.acceptOrder(a, code);
    await h.say(a, 'paid');
    await h.handOver(s, code);
    await h.tap(a, `happy:${code}`);
    const e = (await h.db.query(`SELECT e.* FROM ambassador_earnings e JOIN deals d ON d.id=e.deal_id WHERE d.code=$1`, [code])).rows[0];
    expect(e).toMatchObject({ status: 'HELD', hold_reason: 'The ambassador is one side of this order' });
    expect((await amb().held()).map((x) => x.id)).toContain(Number(e.id));
    const before = Number((await h.db.query(`SELECT sum(amount_minor)::bigint AS b FROM ledger_entries WHERE account='payable:ambassador'`)).rows[0].b);
    await amb().decideHold(Number(e.id), true, null);
    const after = Number((await h.db.query(`SELECT sum(amount_minor)::bigint AS b FROM ledger_entries WHERE account='payable:ambassador'`)).rows[0].b);
    expect(before - after).toBe(Number(e.amount_minor));
  }, 60_000);

  it('the month shows every naira with its maths; Details opens any month', async () => {
    const o = (await amb().overview(aId))!;
    expect(o.summary.earned).toBeGreaterThan(100_000);
    expect(o.lines.some((l) => l.kind === 'BONUS')).toBe(true);
    expect(o.lines.find((l) => l.kind === 'SHARE')).toMatchObject({ side: 'SELLER', percent: 20, who: expect.any(String) });
    expect(o.people.sellers.length).toBeGreaterThanOrEqual(2);
    expect(o.chart).toHaveLength(12);
    const { AmbassadorDetailsFlow } = await import('../src/whatsapp/amb-flow.js');
    const f = new AmbassadorDetailsFlow(amb(), h.app.formSecret);
    const r = await f.handle({ action: 'INIT', flow_token: detailsToken(h.app.formSecret, a) }) as any;
    expect(r.screen).toBe('MONTH');
    expect(r.data.lines).toMatch(/20% of ₦[\d,]+ = ₦/);
    expect((await f.handle({ action: 'data_exchange', data: { op: 'people' }, flow_token: detailsToken(h.app.formSecret, a) }) as any).screen).toBe('PEOPLE');
    expect((await f.handle({ action: 'INIT', flow_token: 'a1.234.1.bad' }) as any).data.headline).toMatch(/expired/);
    await h.tap(a, 'menu:amb');
    expect(h.last(a)).toMatch(/Chioma, Hoolam ambassador[\s\S]*This month:\* ₦[\d,]+[\s\S]*Sellers: \*\d+\*/);
  });

  it('payouts: from the minimum, marked paid by the team, and the last one is paid whatever the amount', async () => {
    const mk = monthKey();
    await h.app.settings.save(h.db, { amb_payout_min: 100_000 }, null); // more than they've earned: it waits
    expect(await amb().payoutRun(mk)).toBe(0);
    await h.app.settings.save(h.db, { amb_payout_min: 1000 }, null);
    expect(await amb().payoutRun(mk)).toBe(1);
    expect(await amb().payoutRun(mk)).toBe(0); // once a month
    const p = (await amb().payouts('DUE')).find((x) => x.userId === aId)!;
    expect(p.bank).toMatchObject({ name: 'GTBank' });
    await expect(amb().markPaid(p.id, '', null)).rejects.toThrow(/reference/);
    await amb().markPaid(p.id, 'TRF-123', null);
    expect(h.last(a)).toMatch(/paid\* to your GTBank account[\s\S]*TRF-123/);
    expect((await amb().overview(aId))!.totals.owedMinor).toBe(0);
    const bal = (await h.db.query(`SELECT account, sum(amount_minor)::bigint AS b FROM ledger_entries WHERE account IN ('payable:ambassador','cash:bank') GROUP BY account`)).rows;
    expect(Number(bal.find((x) => x.account === 'cash:bank').b)).toBe(-p.amountMinor);
    // ending: no more earning, and anything owed goes in a final payout, however small
    await h.db.query(`INSERT INTO ambassador_earnings (ambassador_id, kind, referred_id, side, deal_id, amount_minor, currency, month)
      SELECT $1, 'SHARE', referred_id, 'BUYER', deal_id, 5000, 'NGN', month FROM ambassador_earnings WHERE ambassador_id=$1 LIMIT 1
      ON CONFLICT DO NOTHING`, [aId]);
    await h.tap(a, 'amb:end'); await h.tap(a, 'amb:endyes');
    expect(h.last(a)).toMatch(/ambassador term has ended/);
    const fin = (await amb().payouts('DUE')).find((x) => x.userId === aId && x.final);
    expect(fin?.amountMinor).toBe(5000);
  }, 60_000);
});

describe('terms', () => {
  it('a notice before the end (Renew / Switch / End), then it rolls over, a switch from the next term', async () => {
    const p = phone();
    const slug = await becomeAmbassador(p, 'Musa Bello', '3');
    await finishWithName(p, `${slug}-ph`);
    const id = (await user(p)).id;
    await h.db.query(`UPDATE ambassadors SET term_ends_at=now() + interval '3 days' WHERE user_id=$1`, [id]);
    await amb().sweep();
    expect(h.last(p)).toMatch(/Your 3-month term ends on[\s\S]*renews by itself[\s\S]*whatever term/);
    await amb().sweep();
    expect(h.transcript.filter((t) => t.phone === p && /term ends on/.test(t.text))).toHaveLength(1); // once
    await h.tap(p, 'amb:switch'); await h.tap(p, 'amb:term:12');
    expect(h.last(p)).toMatch(/From your next term[\s\S]*12 months/);
    await h.db.query(`UPDATE ambassadors SET term_ends_at=now() - interval '1 minute' WHERE user_id=$1`, [id]);
    await amb().sweep();
    const a = (await amb().get(id))!;
    expect([a.term_months, a.next_term_months]).toEqual([12, null]);
    expect(new Date(a.term_ends_at!).getTime()).toBeGreaterThan(addMonths(new Date(), 11).getTime());
  }, 60_000);
});

describe('the web dashboard', () => {
  it('signs in with a code sent to their WhatsApp, then shows their numbers; changes need the header', async () => {
    const p = phone();
    const slug = await becomeAmbassador(p, 'Ifeoma Nwosu');
    await finishWithName(p, slug);
    const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-hoolam': '1' }) =>
      h.app.app.inject({ method: 'POST', url, payload: body as object, headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130', ...headers } });
    expect((await post('/ambassador/api/code', { phone: p }, {})).statusCode).toBe(403);
    expect((await post('/ambassador/api/code', { phone: '08000000001' })).statusCode).toBe(200); // the same answer for anyone
    expect((await post('/ambassador/api/code', { phone: p })).statusCode).toBe(200);
    const code = h.last(p).match(/\*(\d{6})\*/)![1]!;
    expect((await post('/ambassador/api/code', { phone: p })).statusCode).toBe(429); // a minute between codes
    expect((await post('/ambassador/api/verify', { phone: p, code: '000000' === code ? '111111' : '000000' })).json().error).toMatch(/isn't right/);
    const ok = await post('/ambassador/api/verify', { phone: p, code });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    expect(h.last(p)).toMatch(/signed in to your ambassador dashboard on \*Chrome on Android\*/);
    const me = await h.app.app.inject({ url: '/ambassador/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ status: 'ACTIVE', slug, firstName: 'Ifeoma', pct: { seller: 20, buyer: 10 }, payoutDay: 1 });
    expect(me.json().phone).toBeUndefined();
    expect(me.json().shares.map((x: { label: string }) => x.label)).toEqual(['For sellers', 'For buyers', 'For your status']);
    const dash = (await h.app.app.inject({ url: '/ambassador' })).body;
    for (const v of ['home', 'earnings', 'people', 'share', 'account']) expect(dash).toMatch(new RegExp(`data-view="${v}"`));
    expect(me.headers['cache-control']).toMatch(/no-store/);
    expect((await h.app.app.inject({ url: '/ambassador/api/me' })).statusCode).toBe(401);
    expect((await post('/ambassador/api/term', { action: 'switch', months: 12 }, { cookie })).statusCode).toBe(403); // no header
    expect((await post('/ambassador/api/term', { action: 'switch', months: 12 }, { cookie, 'x-hoolam': '1' })).statusCode).toBe(200);
    expect((await amb().get((await user(p)).id))!.next_term_months).toBe(12);
    const page = await h.app.app.inject({ url: '/ambassador' });
    expect(page.headers['x-robots-tag']).toMatch(/noindex/);
    expect(page.body).toMatch(/Your ambassador dashboard|Ambassador dashboard/);
    const card = await h.app.app.inject({ url: '/ambassador/api/card.jpg', headers: { cookie } });
    expect([card.statusCode, card.headers['content-type']]).toEqual([200, 'image/jpeg']);
    await h.tap(p, 'amb:signout');
    expect((await h.app.app.inject({ url: '/ambassador/api/me', headers: { cookie } })).statusCode).toBe(401);
  }, 60_000);

  it('the website gets each active link, and taps are counted', async () => {
    const j = (await h.app.app.inject({ url: '/site.json' })).json();
    expect(j.ambassadors).toMatchObject({ on: true, sellerPct: 20, buyerPct: 10, bonus: 1000, bonusOrders: 2 });
    expect(j.ambassadorLinks.some((x: { slug: string; active: boolean }) => x.slug === 'ifeoma' && x.active)).toBe(true);
    expect(j.ambassadorLinks.find((x: { slug: string }) => x.slug === 'chioma')).toMatchObject({ active: false, name: null }); // ended: no name on the page
    await h.app.app.inject({ method: 'POST', url: '/a/ifeoma/tap', headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
    await h.app.app.inject({ method: 'POST', url: '/a/ifeoma/tap', headers: { 'user-agent': 'Googlebot/2.1' } });
    expect((await h.db.query(`SELECT sum(taps)::int AS n FROM ambassador_link_taps WHERE slug='ifeoma'`)).rows[0].n).toBe(1);
  });
});
