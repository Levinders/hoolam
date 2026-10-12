import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode } from '../src/console/crypto.js';
import { FakeKycChecker, namesMatch, readDate, readDob, titleName } from '../src/kyc.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true, env: { KYC_PROVIDER: 'fake', ALLOW_SELF_DEAL: 'true', TRUST_COUNT_TEST_DEALS: 'true' } }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348070000${String(++seq).padStart(3, '0')}`;
const codeIn = (t: string) => t.match(/HL-[A-Z2-9]{5}/)![0];
const user = async (p: string) => (await h.db.query('SELECT * FROM users WHERE phone=$1', [p])).rows[0];
const deal = async (code: string) => (await h.db.query('SELECT * FROM deals WHERE code=$1', [code])).rows[0];
const fake = () => h.app.checker as FakeKycChecker;

/** BVN → date of birth → number. */
async function verify(p: string, number = '22212345678', dob = '25/12/1995') {
  await h.tap(p, 'kyc:bvn');
  expect(h.last(p)).toMatch(/date of birth/);
  await h.say(p, dob);
  expect(h.last(p)).toMatch(/11-digit BVN/);
  await h.say(p, number);
}

/** A buyer's order by chat, up to the price. */
async function buyTo(p: string, price: string) {
  await h.say(p, 'hi', 'Ada Obi');
  await h.tap(p, 'menu:buy');
  await h.say(p, 'iPhone 13');
  await h.say(p, '128GB, clean'); await h.tap(p, 'cat:other');
  await h.say(p, price);
}
async function buyRest(p: string, seller: string) {
  await h.say(p, '12 Woji Road, Port Harcourt'); await h.tap(p, 'bdate:3');
  await h.tap(p, 'buy:nophotos');
  await h.say(p, seller);
  await h.tap(p, 'buy:send');
  return codeIn(h.last(p));
}
/** An existing seller (made before ID checks): a trust card and a payout account, not verified. */
async function oldSeller(p: string, name = 'Bayo Shoes', accountName = 'TEST ACCOUNT HOLDER') {
  await h.say(p, 'hi', 'Bayo');
  const u = await h.app.deals.upsertUser(p, 'Bayo');
  await h.db.query(`UPDATE users SET seller_since=now(), menu_mode='seller', business_name=$2 WHERE id=$1`, [u.id, name]);
  h.provider.accountNames[`058:${p.slice(-10)}`] = accountName;
  await h.app.deals.saveBankAccount(u.id, { bank_code: '058', bank_name: 'GTBank', account_number: p.slice(-10), account_name: accountName });
  return u;
}

describe('names and dates', () => {
  it('matches bank names to ID names, in any order, with middle names and small slips', () => {
    expect(namesMatch('Chidera Anita Johnson', 'JOHNSON CHIDERA')).toBe(true);
    expect(namesMatch('Chidera Anita Johnson', 'JOHNSON ANITA CHIDERA')).toBe(true);
    expect(namesMatch('Chidinma Okafor', 'OKAFOR CHIDIMMA')).toBe(true);
    expect(namesMatch('Mrs Ngozi Eze', 'EZE NGOZI')).toBe(true);
    expect(namesMatch('Chidera Johnson', 'BELLA STORES - CHIDERA JOHNSON')).toBe(true);
    expect(namesMatch('Chidera Johnson', 'JOHNSON MUSA')).toBe(false);
    expect(namesMatch('Chidera Johnson', 'EMEKA OKORO')).toBe(false);
    expect(namesMatch(null, 'EMEKA OKORO')).toBe(false);
  });
  it('reads dates the way people and checkers write them', () => {
    expect(readDob('25/12/1995')).toBe('1995-12-25');
    expect(readDob('25-12-1995')).toBe('1995-12-25');
    expect(readDob('25 Dec 1995')).toBe('1995-12-25');
    expect(readDob('December 25, 1995')).toBe('1995-12-25');
    expect(readDob('31/02/1995')).toBeNull();
    expect(readDob('25/12/2024')).toBeNull(); // too young
    expect(readDate('01-Jan-2000')).toBe('2000-01-01');
    expect(readDate('22-05-1998')).toBe('1998-05-22');
    expect(titleName('CHIDERA ANITA JOHNSON')).toBe('Chidera Anita Johnson');
  });
});

describe('Prembly answers', () => {
  it('reads a BVN and a NIN answer, and treats their outages as "try again"', async () => {
    const { PremblyChecker } = await import('../src/kyc.js');
    const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
    const answer = (status: number, json: unknown) => (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;
    const bvn = new PremblyChecker({ apiKey: 'k', appId: 'a', fetch: answer(200, { status: true, response_code: '00', data: { firstName: 'JOHN', middleName: 'DOE', lastName: 'JANE', dateOfBirth: '01-Jan-2000' }, verification: { reference: 'R1' } }) });
    expect(await bvn.check('BVN', '54651333604')).toEqual({ found: true, name: 'JOHN DOE JANE', dob: '2000-01-01', reference: 'R1' });
    expect(seen[0]!.url).toBe('https://api.prembly.com/identitypass/verification/bvn');
    expect(JSON.parse(seen[0]!.body)).toEqual({ number: '54651333604' });
    expect(seen[0]!.headers['x-api-key']).toBe('k');
    expect(seen[0]!.headers['app-id']).toBe('a');
    const nin = new PremblyChecker({ apiKey: 'k', fetch: answer(200, { status: true, response_code: '00', data: { firstname: 'CHIDERA', middlename: 'ANITA', surname: 'JOHNSON', birthdate: '22-05-1998' } }) });
    expect(await nin.check('NIN', '12345678901')).toMatchObject({ found: true, name: 'CHIDERA ANITA JOHNSON', dob: '1998-05-22' });
    expect(seen[1]!.url).toBe('https://api.prembly.com/identitypass/verification/nin');
    expect(JSON.parse(seen[1]!.body)).toEqual({ number: '12345678901', number_nin: '12345678901' });
    // the dashboard's answer: first_name, last_name, dob, verification_reference
    const dash = new PremblyChecker({ apiKey: 'k', fetch: answer(200, { status: true, detail: 'Verification Successful', data: { first_name: 'JOHN', last_name: 'DOE', dob: '1990-01-01', verification_reference: 'REF_123456' } }) });
    expect(await dash.check('BVN', '12345678901')).toEqual({ found: true, name: 'JOHN DOE', dob: '1990-01-01', reference: 'REF_123456' });
    // a wrong address or a refused request is our setup: "try again", never "not found"
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(404, { detail: 'Not Found' }) }).check('NIN', '1')).toMatchObject({ unavailable: true });
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(400, { status: false, detail: 'number_nin is required' }) }).check('NIN', '1')).toMatchObject({ unavailable: true });
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(400, { status: false, detail: 'No record found for this NIN' }) }).check('NIN', '1')).toMatchObject({ found: false });
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(200, { status: false, response_code: '01', detail: 'Record not found' }) }).check('BVN', '1')).toMatchObject({ found: false });
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(200, { status: false, detail: 'Insufficient wallet balance' }) }).check('BVN', '1')).toMatchObject({ unavailable: true });
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(503, { detail: 'down' }) }).check('BVN', '1')).toMatchObject({ unavailable: true });
    expect(await new PremblyChecker({ apiKey: 'k', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch }).check('BVN', '1')).toMatchObject({ unavailable: true });
  });
});

describe('a buyer\'s order above the limit without ID', () => {
  it('asks for the ID check once, then carries on with the same order', async () => {
    const buyer = phone(), seller = phone();
    await buyTo(buyer, '120000');
    const intro = h.last(buyer);
    expect(intro).toMatch(/Quick ID check, once/);
    expect(intro).toMatch(/above \*₦50,000\*/);
    expect(intro).toMatch(/up to \*₦2,000,000\*/);
    expect(intro).toMatch(/We store only the result, never your BVN or NIN/);
    expect(intro).toMatch(/\[Use BVN\] \[Use NIN\] \[Not now\]/);
    // the webhook copy of the number message is blanked
    await h.db.query(`INSERT INTO webhook_events (source, event_key, payload) VALUES ('whatsapp', 'bvn-msg-1', '{"text":"22212345678"}')`);
    await h.tap(buyer, 'kyc:bvn');
    await h.say(buyer, '25/12/1995');
    await h.app.chat.handle({ id: 'bvn-msg-1', phone: buyer, name: null, type: 'text', text: '22212345678', buttonId: null, mediaId: null });
    expect((await h.db.query(`SELECT payload FROM webhook_events WHERE event_key='bvn-msg-1'`)).rows[0].payload.text).toBe('[ID number removed]');
    const done = h.transcript.filter((t) => t.phone === buyer).slice(-2).map((t) => t.text).join('\n');
    expect(done).toMatch(/You're verified, Test Account Holder/);
    expect(h.last(buyer)).toMatch(/delivery address/); // the order carries on where it was
    const code = await buyRest(buyer, seller);
    expect(Number((await deal(code)).price_minor)).toBe(120_000_00);
    const u = await user(buyer);
    expect(u).toMatchObject({ kyc_status: 'VERIFIED', kyc_method: 'BVN', kyc_last4: '5678', kyc_name: 'Test Account Holder' });
    // nothing anywhere keeps the full number
    const all = await h.db.query(`SELECT 1 FROM outbound_messages WHERE body::text LIKE '%22212345678%' UNION ALL SELECT 1 FROM kyc_checks WHERE last4 <> '5678' AND user_id=$1 UNION ALL SELECT 1 FROM chat_sessions WHERE data::text LIKE '%22212345678%'`, [u.id]);
    expect(all.rowCount).toBe(0);
    // once is enough: the next big order goes straight through
    await buyTo(buyer, '300000');
    expect(h.last(buyer)).toMatch(/delivery address/);
  });

  it('"Not now" keeps the order: a smaller price carries on', async () => {
    const buyer = phone();
    await buyTo(buyer, '80000');
    await h.tap(buyer, 'kyc:later');
    expect(h.last(buyer)).toMatch(/No problem\. Orders up to \*₦50,000\* don't need an ID check/);
    await h.say(buyer, '45000');
    expect(h.last(buyer)).toMatch(/delivery address/);
  });

  it('"Check my ID" after "Not now" brings the price back', async () => {
    const buyer = phone();
    await buyTo(buyer, '80000');
    await h.tap(buyer, 'kyc:later');
    await h.tap(buyer, 'kyc:retry');
    await verify(buyer);
    expect(h.last(buyer)).toMatch(/delivery address/);
    const s = (await h.db.query('SELECT data FROM chat_sessions WHERE phone=$1', [buyer])).rows[0].data;
    expect(s.priceMinor).toBe(80_000_00);
  });

  it('above the verified limit: tells them the most', async () => {
    const buyer = phone();
    await buyTo(buyer, '2500000');
    expect(h.last(buyer)).toMatch(/orders can be up to \*₦2,000,000\*/);
  });

  it('wrong details: a plain reason, Try again and Talk to a rep; 3 tries a day, then Needs review', async () => {
    const buyer = phone();
    await buyTo(buyer, '90000');
    await verify(buyer, '00000000000');
    expect(h.last(buyer)).toMatch(/We couldn't find that BVN[\s\S]*2 tries left today[\s\S]*\[Try again\] \[Talk to a rep\]/);
    await h.tap(buyer, 'kyc:retry');
    await verify(buyer, '11111111111');
    expect(h.last(buyer)).toMatch(/date of birth doesn't match[\s\S]*1 try left today/);
    await h.tap(buyer, 'kyc:retry');
    await verify(buyer, '99999999999'); // the checker is down: doesn't count
    expect(h.last(buyer)).toMatch(/We can't check IDs right now[\s\S]*Nothing is lost/);
    await h.tap(buyer, 'kyc:retry');
    await verify(buyer, '00000000000');
    expect(h.last(buyer)).toMatch(/We couldn't find that BVN[\s\S]*0 tries left today[\s\S]*\[Talk to a rep\]/);
    expect((await user(buyer)).kyc_status).toBe('REVIEW');
    await h.tap(buyer, 'kyc:retry');
    expect(h.last(buyer)).toMatch(/used your 3 tries for today/);
    await h.tap(buyer, 'kyc:rep');
    expect(h.last(buyer)).toMatch(/Type your message for the team/);
  });

  it('a short number or a bad date is asked again', async () => {
    const buyer = phone();
    await buyTo(buyer, '70000');
    await h.tap(buyer, 'kyc:nin');
    await h.say(buyer, 'yesterday');
    expect(h.last(buyer)).toMatch(/25\/12\/1995/);
    await h.say(buyer, '1/2/1990');
    expect(h.last(buyer)).toMatch(/11-digit NIN[\s\S]*\*346#/);
    await h.say(buyer, '1234');
    expect(h.last(buyer)).toMatch(/A NIN has \*11 digits\*/);
    await h.say(buyer, '12345678901');
    expect(h.last(buyer)).toMatch(/delivery address/);
    expect((await user(buyer)).kyc_method).toBe('NIN');
  });
});

describe('sellers', () => {
  it('a new seller checks their ID before the payout account; the account must be in that name', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi', 'Chidera');
    await h.sell(seller);
    await h.say(seller, 'Ankara gown'); await h.say(seller, 'Size 12'); await h.tap(seller, 'cat:other');
    await h.say(seller, '15000');
    await h.say(seller, '12 Woji Road, Port Harcourt'); await h.tap(seller, 'bdate:1');
    await h.tap(seller, 'sell:nophotos');
    await h.say(seller, buyer);
    expect(h.last(seller)).toMatch(/One step before your payout account[\s\S]*Verified seller/);
    fake().names['33312345678'] = 'CHIDERA ANITA JOHNSON';
    await verify(seller, '33312345678');
    expect(h.last(seller)).toMatch(/account number/);
    h.provider.accountNames['058:0111111111'] = 'EMEKA OKORO';
    await h.say(seller, '0111111111 GTBank');
    expect(h.last(seller)).toMatch(/This account is in another name[\s\S]*\*EMEKA OKORO\*[\s\S]*\*Chidera Anita Johnson\*/);
    h.provider.accountNames['058:0222222222'] = 'JOHNSON CHIDERA';
    await h.say(seller, '0222222222 GTBank');
    expect(h.last(seller)).toMatch(/JOHNSON CHIDERA/);
    await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/Check your order/);
    await h.tap(seller, 'sell:send');
    const t = await h.app.trust.seller((await user(seller)).id);
    expect(t?.verified).toBe(true);
    expect(msg.trustLine(t!)).toMatch(/Verified seller/);
    expect(msg.trustCardText(t!)).toMatch(/Verified seller\*: ID and bank account name checked by Hoolam/);
    const slug = await h.app.trust.setPublic((await user(seller)).id, true);
    const page = await h.app.app.inject({ url: `/s/${slug}` });
    expect(page.body).toMatch(/Verified seller<span class="tip"[^>]*>ID and bank account name checked by Hoolam/);
  });

  it('an existing seller verifies before their next payout; then the money goes', async () => {
    const seller = phone(), buyer = phone();
    await oldSeller(seller);
    const code = await h.sellOrder(seller, buyer, { price: '20000' }); // no ID check: under the limit, account already there
    await h.say(buyer, 'hi', 'Ngozi');
    await h.acceptOrder(buyer, code);
    await h.say(buyer, 'paid');
    await h.handOver(seller, code);
    await h.tap(buyer, `happy:${code}`);
    const p = (await h.db.query(`SELECT p.status FROM payouts p JOIN deals d ON d.id=p.deal_id WHERE d.code=$1 AND p.kind='SELLER'`, [code])).rows[0];
    expect(p.status).toBe('WAITING_KYC');
    expect(h.last(seller)).toMatch(/your money is ready[\s\S]*check your ID once[\s\S]*\[Check my ID\]/);
    expect((await deal(code)).status).toBe('RELEASING');
    await h.tap(seller, 'kyc:payout');
    expect(h.last(seller)).toMatch(/One step before we pay you/);
    await verify(seller);
    expect((await deal(code)).status).toBe('COMPLETED');
    expect(h.last(seller)).toMatch(/You've been paid/);
  });

  it('verified, but the old payout account is in another name: asks for one in their name, then pays', async () => {
    const seller = phone(), buyer = phone();
    await oldSeller(seller, 'Musa Bags', 'MUSA ABDULLAHI');
    const code = await h.sellOrder(seller, buyer, { price: '20000' });
    await h.say(buyer, 'hi', 'Ivana');
    await h.acceptOrder(buyer, code);
    await h.say(buyer, 'paid');
    await h.handOver(seller, code);
    await h.tap(buyer, `happy:${code}`);
    await h.tap(seller, 'kyc:payout');
    fake().names['44412345678'] = 'IBRAHIM SANI';
    await verify(seller, '44412345678');
    expect(h.last(seller)).toMatch(/in the name \*MUSA ABDULLAHI\*, but your ID says \*Ibrahim Sani\*/);
    expect((await deal(code)).status).toBe('RELEASING');
    h.provider.accountNames['058:0333333333'] = 'SANI IBRAHIM';
    await h.say(seller, '0333333333 GTBank');
    await h.tap(seller, 'bank:yes');
    expect((await deal(code)).status).toBe('COMPLETED');
    const acct = (await h.db.query(`SELECT b.account_number FROM payouts p JOIN bank_accounts b ON b.id=p.bank_account_id JOIN deals d ON d.id=p.deal_id WHERE d.code=$1 AND p.kind='SELLER'`, [code])).rows[0];
    expect(acct.account_number).toBe('0333333333');
  });

  it('a seller accepting a buyer\'s order above the limit verifies first; the order waits', async () => {
    const buyer = phone(), seller = phone();
    await buyTo(buyer, '150000');
    await verify(buyer);
    const code = await buyRest(buyer, seller);
    await oldSeller(seller, 'Ada Phones');
    await h.tap(seller, `saccept:${code}`);
    expect(h.last(seller)).toMatch(/so we check your ID before you accept[\s\S]*The order waits for you/);
    expect((await deal(code)).status).toBe('AWAITING_SELLER');
    await verify(seller);
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');
  });

  it('a buyer receiving a seller\'s order above the limit verifies before paying', async () => {
    const seller = phone(), buyer = phone();
    await oldSeller(seller, 'Big Gadgets');
    await h.app.kyc.approve((await user(seller)).id, 'Test Account Holder', 'test');
    const code = await h.sellOrder(seller, buyer, { price: '250000' });
    await h.say(buyer, 'hi', 'Emeka');
    await h.tap(buyer, `baccept:${code}`);
    expect(h.last(buyer)).toMatch(/so we check your ID before you pay/);
    await verify(buyer);
    expect(h.last(buyer)).toMatch(/deliver/i); // back to accepting: the address
    await h.tap(buyer, `baddr:${code}`);
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');
  });
});

describe('the My orders form', () => {
  it('Accept above the limit sends the ID check to the chat, and the order carries on after', async () => {
    const { signToken } = await import('../src/whatsapp/orders-flow.js');
    const buyer = phone(), seller = phone();
    await buyTo(buyer, '180000');
    await verify(buyer);
    const code = await buyRest(buyer, seller);
    await oldSeller(seller, 'Form Seller');
    const r = await h.app.orders.handle({ action: 'data_exchange', flow_token: signToken(h.app.formSecret, seller, 'seller', 'order', code), data: { action: 'accept', code } }) as any;
    expect(r.screen).toBe('DONE');
    expect(r.data.title).toMatch(/Quick ID check first/);
    expect(h.last(seller)).toMatch(/so we check your ID before you accept/);
    await verify(seller);
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');
  });
});

describe('refunds for verified buyers', () => {
  it('go only to an account in their own name', async () => {
    const buyer = phone();
    await buyTo(buyer, '60000');
    await verify(buyer);
    await h.db.query(`UPDATE chat_sessions SET state='REFUND_BANK', data='{"code":"HL-XXXXX"}' WHERE phone=$1`, [buyer]);
    h.provider.accountNames['058:0444444444'] = 'SOMEONE ELSE';
    await h.say(buyer, '0444444444 GTBank');
    expect(h.last(buyer)).toMatch(/This account is in another name[\s\S]*Refunds go only to an account in your own name/);
  });
});

describe('the console', () => {
  let owner = '';
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await h.app.app.inject({ method: method as 'GET', url: `/console/api${url}`, headers: { ...(owner ? { cookie: owner } : {}), 'x-hoolam-console': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const set = r.headers['set-cookie'];
    if (typeof set === 'string' && set.includes('hoolam_console=')) owner = set.split(';')[0]!;
    return { status: r.statusCode, json: r.json() };
  };
  it('shows the ID check, lists Needs review, and approves or removes with a reason', async () => {
    const s = await call('POST', '/auth/setup', { setupToken: 'test-admin-token-123456', name: 'Owner', email: 'o@hoolam.ng', password: 'Str0ngPassw0rd' });
    await call('POST', '/auth/enroll', { ticket: s.json.ticket, code: totpCode(s.json.secret) });
    const review = await call('GET', '/people?kind=review');
    expect(review.json.rows.length).toBeGreaterThan(0);
    const id = review.json.rows[0].id;
    const inbox = await call('GET', '/inbox');
    expect(inbox.json.items.some((i: any) => i.kind === 'kyc' && i.link === `/people/${id}`)).toBe(true);
    const p = await call('GET', `/people/${id}`);
    expect(p.json.kyc).toMatchObject({ status: 'REVIEW', provider: 'fake' });
    expect(p.json.kyc.checks[0]).toMatchObject({ method: 'BVN', last4: '0000' });
    expect(p.json.verifiedCapMinor).toBe(2_000_000_00);
    expect((await call('POST', `/people/${id}/kyc`, { action: 'approve', name: 'Ada', reason: 'Checked on a call' })).status).toBe(400); // full name needed
    expect((await call('POST', `/people/${id}/kyc`, { action: 'approve', name: 'ada obi', reason: 'x' })).status).toBe(400); // reason needed
    expect((await call('POST', `/people/${id}/kyc`, { action: 'approve', name: 'ada obi', reason: 'Checked her NIN slip on a video call' })).status).toBe(200);
    const after = await call('GET', `/people/${id}`);
    expect(after.json.kyc).toMatchObject({ status: 'VERIFIED', method: 'MANUAL', name: 'Ada Obi' });
    expect(after.json.trail[0]).toMatchObject({ action: 'user.kyc.approve', reason: 'Checked her NIN slip on a video call' });
    expect((await call('POST', `/people/${id}/kyc`, { action: 'remove', reason: 'Wrong person' })).status).toBe(200);
    expect((await call('GET', `/people/${id}`)).json.kyc.status).toBe('UNVERIFIED');
  });
  it('the two limits are settings', async () => {
    expect((await call('PUT', '/settings', { changes: { max_deal_verified: 40_000 }, reason: 'Below the other one' })).status).toBe(400);
    expect((await call('PUT', '/settings', { changes: { max_deal_verified: 1_000_000 }, reason: 'Start smaller' })).status).toBe(200);
    expect(h.app.deals.maxDealVerifiedMinor).toBe(1_000_000_00);
    const buyer = phone();
    await buyTo(buyer, '1500000');
    expect(h.last(buyer)).toMatch(/up to \*₦1,000,000\*/);
  });
});
