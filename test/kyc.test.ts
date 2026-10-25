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
    expect(await bvn.check('BVN', '54651333604')).toEqual({ found: true, name: 'JOHN DOE JANE', dob: '2000-01-01', reference: 'R1', flag: null });
    expect(seen[0]!.url).toBe('https://api.prembly.com/verification/bvn_validation');
    expect(JSON.parse(seen[0]!.body)).toEqual({ number: '54651333604' });
    expect(seen[0]!.headers['x-api-key']).toBe('k');
    expect(seen[0]!.headers['app-id']).toBe('a');
    const nin = new PremblyChecker({ apiKey: 'k', fetch: answer(200, { status: true, response_code: '00', data: { firstname: 'CHIDERA', middlename: 'ANITA', surname: 'JOHNSON', birthdate: '22-05-1998' } }) });
    expect(await nin.check('NIN', '12345678901')).toMatchObject({ found: true, name: 'CHIDERA ANITA JOHNSON', dob: '1998-05-22' });
    expect(seen[1]!.url).toBe('https://api.prembly.com/verification/vnin-basic');
    expect(JSON.parse(seen[1]!.body)).toEqual({ number: '12345678901' });
    // the dashboard's answer: first_name, last_name, dob, verification_reference
    const dash = new PremblyChecker({ apiKey: 'k', fetch: answer(200, { status: true, detail: 'Verification Successful', data: { first_name: 'JOHN', last_name: 'DOE', dob: '1990-01-01', verification_reference: 'REF_123456' } }) });
    expect(await dash.check('BVN', '12345678901')).toEqual({ found: true, name: 'JOHN DOE', dob: '1990-01-01', reference: 'REF_123456', flag: null });
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

describe('Prembly\'s own example answers (BVN Basic, NIN Basic)', () => {
  const answer = (json: unknown) => (async () => new Response(JSON.stringify(json), { status: 200 })) as unknown as typeof fetch;
  it('BVN Basic: the name and date of birth, and a NIBSS watchlist is a flag', async () => {
    const { PremblyChecker } = await import('../src/kyc.js');
    // exactly as the docs show it
    const json = {
      status: true, detail: 'Verification Successfull', response_code: '00',
      data: { watchListed: true, watchListMessage: 'BVN has been watchlisted by NIBSS', firstName: 'John', middleName: 'Doe', lastName: 'Jane', dateOfBirth: '01-Jan-2000', phoneNumber: '08012345678' },
      source: 'API', user_info: null, request_data: { number: '54651333604' },
    };
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(json) }).check('BVN', '54651333604'))
      .toEqual({ found: true, name: 'John Doe Jane', dob: '2000-01-01', reference: null, flag: 'BVN watchlisted by NIBSS' });
    const clean = { ...json, data: { ...json.data, watchListed: false } };
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(clean) }).check('BVN', '54651333604')).toMatchObject({ found: true, flag: null });
  });
  it('NIN Basic: the name and date of birth (the photo, address and phone are ignored), and a suspension is a flag', async () => {
    const { PremblyChecker } = await import('../src/kyc.js');
    const person = { nin_suspension_status: false, birthdate: '23-05-1999', nin_suspension_message: 'NOT SUSPENDED', firstname: 'GRACE', surname: 'AMANDA', middlename: 'CHIMAMANDA', nin: '56182742701', telephoneno: '07082078516', residence_address: '21Z AGO PALACE EKENE', photo: 'data:image/jpeg;base64,AAAA', gender: 'f' };
    const json = {
      status: true, response_code: '00', message: 'National Identity Number (NIN) - Basic verification successful', detail: 'National Identity Number (NIN) - Basic verification successful',
      data: person, meta: {}, billing_info: { was_charged: true, amount: '50.00', currency: 'NGN', note: 'Wallet charged 50.00 NGN' },
      verification: { status: 'VERIFIED', reference: 'a8d3c167-5689-48c3-a867-59ba05e0ea68', verification_id: '6dd48a71-cc0d-4644-aa38-f3bf37c73907' },
      reference_id: 'VER-NIN_BASIC-OCXBW0Z6IM', transaction_id: 'e0000591-6cbd-4a6a-b465-a591107d1c9c', verification_status: 'verified', nin_data: person,
    };
    const got = await new PremblyChecker({ apiKey: 'k', fetch: answer(json) }).check('NIN', '56182742701');
    expect(got).toEqual({ found: true, name: 'GRACE CHIMAMANDA AMANDA', dob: '1999-05-23', reference: 'a8d3c167-5689-48c3-a867-59ba05e0ea68', flag: null });
    const suspended = { ...json, data: { ...person, nin_suspension_status: true, nin_suspension_message: 'SUSPENDED' } };
    expect(await new PremblyChecker({ apiKey: 'k', fetch: answer(suspended) }).check('NIN', '56182742701')).toMatchObject({ found: true, flag: 'NIN suspended by NIMC' });
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
  it('a flagged ID (watchlist, suspension): Needs review, no more checks with BVN or NIN, then the team declines or approves', async () => {
    const buyer = phone();
    await buyTo(buyer, '120000');
    await verify(buyer, '22222222222'); // the pretend checker's "flagged" number
    const first = h.last(buyer);
    expect(first).toMatch(/couldn't confirm your ID right away/);
    expect(first).toMatch(/Our team will check it and message you/);
    expect(first).toMatch(/up to \*₦50,000\*\. Type a smaller price to carry on/);
    expect(first).not.toMatch(/watchlist|NIBSS|suspend/i); // the reason is for the team only
    const u = await user(buyer);
    expect(u).toMatchObject({ kyc_status: 'REVIEW', kyc_flag: 'BVN watchlisted by NIBSS', kyc_declined_at: null });
    expect(u.kyc_review_reason).toBe('BVN watchlisted by NIBSS (BVN ••••2222, name on it: Test Account Holder)');
    expect(await h.app.kyc.triesLeft(u.id)).toBe(3); // not a used try
    const checks = async () => (await h.db.query('SELECT result FROM kyc_checks WHERE user_id=$1', [u.id])).rows.map((r) => r.result);
    expect(await checks()).toEqual(['FLAGGED']);
    // asking again, or switching to NIN: no check, they're told the team has it
    await h.tap(buyer, 'kyc:retry');
    expect(h.last(buyer)).toMatch(/Your ID is with our team for checking/);
    await h.tap(buyer, 'kyc:nin');
    expect(h.last(buyer)).toMatch(/Your ID is with our team for checking/);
    expect(await h.app.kyc.verify(u.id, 'NIN', '12312312312', '1995-12-25')).toMatchObject({ ok: false, reason: 'IN_REVIEW' });
    expect(await checks()).toEqual(['FLAGGED']); // nothing more sent to the checker
    // a smaller price still carries on
    await h.say(buyer, '40000');
    expect(h.last(buyer)).toMatch(/delivery address/);
    // the team sees it flagged, and can only approve or decline it
    const inbox = await call('GET', '/inbox');
    expect(inbox.json.items.find((i: any) => i.link === `/people/${u.id}`)).toMatchObject({ kind: 'kyc', severity: 'high', title: expect.stringMatching(/^ID flagged/) });
    expect((await call('GET', `/people/${u.id}`)).json.kyc).toMatchObject({ status: 'REVIEW', flag: 'BVN watchlisted by NIBSS', declined: false });
    expect((await call('POST', `/people/${u.id}/kyc`, { action: 'clear', reason: 'Spoke to them' })).status).toBe(400);
    expect((await call('POST', `/people/${u.id}/kyc`, { action: 'decline', reason: 'Could not confirm on a call' })).status).toBe(200);
    expect(h.last(buyer)).toMatch(/We couldn't confirm your ID\. You can keep using Hoolam for orders up to ₦50,000\./);
    const declined = (await call('GET', `/people/${u.id}`)).json;
    expect(declined.kyc).toMatchObject({ status: 'UNVERIFIED', declined: true, flag: 'BVN watchlisted by NIBSS' });
    expect(declined.trail[0]).toMatchObject({ action: 'user.kyc.decline', reason: 'Could not confirm on a call' });
    // declined: still no checks
    await buyTo(buyer, '150000');
    expect(h.last(buyer)).toMatch(/We couldn't confirm your ID\.\* You can keep using Hoolam for orders up to \*₦50,000\*/);
    expect(await checks()).toEqual(['FLAGGED']);
    // the team can still approve later: verified, and told so
    expect((await call('POST', `/people/${u.id}/kyc`, { action: 'approve', name: 'grace amanda', reason: 'Saw her ID and bank statement' })).status).toBe(200);
    expect(h.last(buyer)).toMatch(/Your ID is confirmed, Grace Amanda\. You can now do orders up to ₦2,000,000\./);
    expect(await user(buyer)).toMatchObject({ kyc_status: 'VERIFIED', kyc_flag: null, kyc_declined_at: null });
  });
  it('the same for a suspended NIN, and a seller\'s payouts are told they wait', async () => {
    const seller = phone();
    const u = await oldSeller(seller);
    await h.app.chat.startKycFor(u, 'seller', { kind: 'none' });
    await h.tap(seller, 'kyc:nin');
    await h.say(seller, '25/12/1995');
    await h.say(seller, '22222222222');
    expect(h.last(seller)).toMatch(/couldn't confirm your ID right away[\s\S]*Your payouts wait until then/);
    expect(await user(seller)).toMatchObject({ kyc_status: 'REVIEW', kyc_flag: 'NIN suspended by NIMC' });
    // "Talk to a rep" doesn't overwrite the flag's reason
    await h.tap(seller, 'kyc:rep');
    expect((await user(seller)).kyc_review_reason).toMatch(/^NIN suspended by NIMC/);
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

describe('paying Prembly once', () => {
  it('someone already verified is never checked again (a second form, an old form)', async () => {
    const buyer = phone();
    await buyTo(buyer, '120000');
    await verify(buyer);
    const u = await user(buyer);
    let calls = 0;
    const real = fake().check.bind(fake());
    fake().check = async (...a) => { calls++; return real(...a); };
    try {
      expect(await h.app.kyc.verify(u.id, 'NIN', '12312312312', '1990-01-01')).toEqual({ ok: true, name: 'Test Account Holder' });
      expect(calls).toBe(0);
    } finally { fake().check = real; }
    expect((await h.db.query('SELECT count(*)::int n FROM kyc_checks WHERE user_id=$1', [u.id])).rows[0].n).toBe(1);
  });
  it('real ID checks with pretend money: payout account names aren\'t matched until real payments are on', async () => {
    const { KycService } = await import('../src/kyc.js');
    expect(new KycService(h.db, fake(), undefined, { skipAccountMatch: true }).accountMatches('Grace Amanda', 'TEST ACCOUNT HOLDER')).toBe(true);
    expect(new KycService(h.db, fake()).accountMatches('Grace Amanda', 'TEST ACCOUNT HOLDER')).toBe(false);
    expect(new KycService(h.db, fake()).accountMatches('Grace Amanda', 'AMANDA GRACE')).toBe(true);
  });
});

describe('forms', () => {
  const form = (p: string, token: string, f: Record<string, unknown>, id = `kf${++seq}`) =>
    h.app.chat.handle({ id, phone: p, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null, form: { flow_token: token, ...f } });
  const order = { item: 'iPhone 13', description: '128GB, clean', category: 'other', address: '12 Woji Road, Port Harcourt', arrive_by: '2026-12-01', photos: [{ id: 'm1', mime_type: 'image/jpeg' }] };

  it('the buyer form with a big price: the ID check, then straight to Check your order', async () => {
    const buyer = phone(), seller = phone();
    await form(buyer, 'buy:v1', { ...order, price: '120k', other_phone: seller.replace('+234', '0') });
    expect(h.last(buyer)).toMatch(/Quick ID check, once/);
    await verify(buyer);
    expect(h.last(buyer)).toMatch(/Check your order/);
    await h.tap(buyer, 'buy:send');
    expect(Number((await deal(codeIn(h.last(buyer)))).price_minor)).toBe(120_000_00);
  });

  it('the seller form with a big price: the ID check (once), then the payout account, then Check your order', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi', 'Bayo');
    await h.sell(seller);
    await form(seller, 'sell:v2', { ...order, price: '150000', other_phone: buyer.replace('+234', '0') });
    expect(h.last(seller)).toMatch(/Quick ID check, once/);
    await verify(seller);
    expect(h.last(seller)).toMatch(/account number/); // no second ID check for the payout account
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/Check your order/);
  });

  it('the ID check form: answers in one go, the date as WhatsApp sends it, the number never kept', async () => {
    const buyer = phone();
    await buyTo(buyer, '95000');
    await h.db.query(`INSERT INTO webhook_events (source, event_key, payload) VALUES ('whatsapp', 'kyc-form-1', '{"form":{"number":"22298765432"}}')`);
    await form(buyer, 'kyc:v1', { method: 'NIN', number: '22298765432', dob: String(Date.UTC(1995, 11, 25)) }, 'kyc-form-1');
    expect(h.last(buyer)).toMatch(/delivery address/);
    expect(await user(buyer)).toMatchObject({ kyc_status: 'VERIFIED', kyc_method: 'NIN', kyc_last4: '5432' });
    const ev = (await h.db.query(`SELECT payload FROM webhook_events WHERE event_key='kyc-form-1'`)).rows[0].payload;
    expect(JSON.stringify(ev)).not.toMatch(/22298765432/);
  });

  it('the ID check form follows WhatsApp\'s rules', async () => {
    const { kycFlowJson, kycFlowName } = await import('../src/whatsapp/kyc-flow.js');
    const j = kycFlowJson('aGVsbG8=');
    expect(j.version).toBe('7.3');
    expect(j.screens.map((x) => x.id)).toEqual(['WHY', 'NUMBER']);
    expect(j.screens[1]!.terminal).toBe(true);
    expect((j.screens[0]!.layout.children[0] as any).type).toBe('Image'); // why we check, as a picture
    const why = (j.screens[0]!.layout.children[1] as any).children as any[];
    expect(why.map((k) => k.type)).toEqual(['TextSubheading', 'TextBody', 'RadioButtonsGroup', 'TextCaption', 'Footer']);
    const kids = (j.screens[1]!.layout.children[0] as any).children as any[];
    expect(kids.map((k) => k.type)).toEqual(['TextInput', 'DatePicker', 'TextCaption', 'Footer']); // two fields
    expect(kids.at(-1).label.length).toBeLessThanOrEqual(35);
    expect(kids.at(-1)['on-click-action']).toEqual({ name: 'complete', payload: { method: '${data.method}', number: '${form.number}', dob: '${form.dob}' } });
    expect(kycFlowJson().screens[0]!.layout.children[0]).toMatchObject({ type: 'Form' }); // no picture: just the words
    expect(kycFlowName()).toMatch(/^hoolam_kyc_[0-9a-f]{8}$/);
  });
});
