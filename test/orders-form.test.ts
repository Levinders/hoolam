import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { decryptResponseForTest, encryptRequestForTest, flowKeys } from '../src/whatsapp/flow-crypto.js';
import { ordersFlowJson, readToken, rowTitle, signToken } from '../src/whatsapp/orders-flow.js';
import { buyEditFlowJson } from '../src/whatsapp/buy-flow.js';
import { ensureOrdersFlow, registerFlowsKey } from '../src/whatsapp/automation.js';
import { toPayload } from '../src/whatsapp/client.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348070000${String(++seq).padStart(3, '0')}`;
const deal = async (code: string) => (await h.db.query('SELECT * FROM deals WHERE code=$1', [code])).rows[0];

async function paidBuyerOrder(): Promise<{ buyer: string; seller: string; code: string }> {
  const buyer = phone(), seller = phone();
  await h.say(seller, 'hi', 'Bayo Shoes');
  await h.say(buyer, 'hi', 'Ada Obi');
  await h.app.chat.handle({
    id: `f${seq}`, phone: buyer, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null,
    form: { flow_token: 'buy:v1', item: 'Leather bag', description: 'Brown, medium', category: 'bags', price: '20000', address: '12 Woji Road', arrive_by: '2099-12-31', other_phone: seller, photos: [{ id: 'p1' }] },
  });
  await h.tap(buyer, 'buy:send');
  const code = h.last(buyer).match(/HL-[A-Z2-9]{5}/)![0];
  await h.tap(seller, `saccept:${code}`);
  await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
  await h.tap(buyer, `pay:${code}`);
  const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
  h.provider.pay(r.rows[0].provider_reference);
  await h.app.deals.handleCollection(r.rows[0].provider_reference);
  return { buyer, seller, code };
}

const call = (token: string, action: string, data: Record<string, unknown> = {}, screen?: string) =>
  h.app.orders.handle({ action, flow_token: token, data, screen }) as Promise<{ version: string; screen: string; data: any }>;

describe('the form itself', () => {
  it('stays within WhatsApp\'s rules', () => {
   for (const start of ['FILTER', 'ORDER'] as const) {
    const json = ordersFlowJson(start) as any;
    expect(json.data_api_version).toBe('3.0');
    // the step name travels as "op" (never "action") in every payload
    expect(JSON.stringify(json)).not.toMatch(/"action":/);
    const edges = Object.values(json.routing_model as Record<string, string[]>).flat().length;
    expect(edges).toBeLessThanOrEqual(10);
    const ids = json.screens.map((s: any) => s.id);
    for (const [from, to] of Object.entries(json.routing_model as Record<string, string[]>)) {
      expect(ids).toContain(from);
      for (const t of to) expect(ids).toContain(t);
    }
    expect(json.screens.filter((s: any) => s.terminal).map((s: any) => s.id)).toEqual(['DONE']);
    // WhatsApp rules: forward routes only, and exactly one entry screen (no inbound edges)
    const rm = json.routing_model as Record<string, string[]>;
    for (const [from, to] of Object.entries(rm)) for (const t of to) expect(rm[t] ?? []).not.toContain(from);
    const inbound = new Set(Object.values(rm).flat());
    expect(ids.filter((id: string) => !inbound.has(id))).toEqual([start]);
    // and no cycles
    const visit = (id: string, seen: string[]): void => { expect(seen).not.toContain(id); for (const n of rm[id] ?? []) visit(n, [...seen, id]); };
    visit(start, []);
    for (const s of json.screens) {
      const footers = s.layout.children.filter((c: any) => c.type === 'Footer');
      expect(footers.length).toBe(1);
      expect(s.layout.children.filter((c: any) => c.type === 'EmbeddedLink').length).toBeLessThanOrEqual(2);
      expect(s.layout.children.filter((c: any) => c.type === 'Image').length).toBeLessThanOrEqual(3);
      for (const c of s.layout.children) if (c.type === 'TextInput' || c.type === 'TextArea') expect(c.label.length).toBeLessThanOrEqual(20);
      // every ${data.x} the screen uses is declared with an example
      const used = [...JSON.stringify(s.layout).matchAll(/\$\{data\.(\w+)\}/g)].map((m) => m[1]);
      for (const k of used) expect(Object.keys(s.data)).toContain(k);
    }
   }
  });

  it('works out the step when WhatsApp sends it without one', async () => {
    const { seller } = await paidBuyerOrder();
    const t = signToken(h.app.formSecret, seller, 'seller', 'orders');
    const r = await call(t, 'data_exchange', { filter: 'completed' }, 'FILTER');
    expect(r.screen).toBe('ORDERS');
    expect(r.data.summary).toMatch(/^Completed/);
  });

  it('a live form message asks our endpoint for its first screen', () => {
    const p = toPayload('2348000000000', { kind: 'form', text: 'x', cta: 'Open my orders', flowId: '1', flowToken: 't', screen: 'FILTER', mode: 'published', live: true }) as any;
    expect(p.interactive.action.parameters.flow_action).toBe('data_exchange');
    expect(p.interactive.action.parameters.flow_action_payload).toBeUndefined();
  });
});

describe('tokens', () => {
  it('only our signed, unexpired tokens open orders', () => {
    const t = signToken('secret', '+2348011112222', 'seller', 'dispatch', 'HL-AAAAA');
    expect(readToken('secret', t)).toEqual({ phone: '+2348011112222', mode: 'seller', entry: 'dispatch', code: 'HL-AAAAA' });
    expect(readToken('other', t)).toBeNull();
    expect(readToken('secret', t.replace('2348011112222', '2348099999999'))).toBeNull();
    expect(readToken('secret', signToken('secret', '+2348011112222', 'buyer', 'orders', '-', -1))).toBeNull();
  });
});

describe('the encrypted endpoint', () => {
  it('decrypts, answers and encrypts like WhatsApp expects; ping says active', async () => {
    const keys = await flowKeys(h.db);
    expect((await flowKeys(h.db)).privateKeyPem).toBe(keys.privateKeyPem); // made once, kept
    const { request, aesKey, iv } = encryptRequestForTest({ version: '3.0', action: 'ping' }, keys.publicKeyPem);
    const res = await h.app.app.inject({ method: 'POST', url: '/flows/endpoint', payload: request });
    expect(res.statusCode).toBe(200);
    expect(decryptResponseForTest(res.body, aesKey, iv)).toEqual({ data: { status: 'active' } });

    const bad = await h.app.app.inject({ method: 'POST', url: '/flows/endpoint', payload: { ...request, encrypted_aes_key: Buffer.from('nope').toString('base64') } });
    expect(bad.statusCode).toBe(421);
  });

  it('an unknown or expired token gets a friendly screen, never an error', async () => {
    // on opening, the answer must be the form's first screen
    const r = await call('o1.fake', 'INIT');
    expect(r).toMatchObject({ version: '3.0', screen: 'FILTER' });
    expect(r.data.heading).toMatch(/expired/);
    const one = await call('o1.234800.buyer.order.HL-X.1', 'INIT');
    expect(one).toMatchObject({ screen: 'ORDER', data: { primary: 'close' } });
    expect(one.data.heading).toMatch(/expired/);
    // later steps can end on the done screen
    const later = await call('o1.fake', 'data_exchange', { op: 'filter', filter: 'all' });
    expect(later.screen).toBe('DONE');
  });

  it('registers the key with Meta and creates the form with our endpoint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('whatsapp_business_encryption') && (!init.method || init.method === 'GET')) return new Response('{"data":[]}', { status: 200 });
      if (url.includes('/flows?')) return new Response('{"data":[]}', { status: 200 });
      return new Response('{"id":"777","success":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const o = { token: 't', phoneNumberId: '123', graphVersion: 'v26.0', wabaId: '999', formMode: 'published' as const, fetchImpl: fake };
    expect(await registerFlowsKey(o, '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----')).toBe(true);
    expect(String(calls[1]!.init.body)).toMatch(/^business_public_key=/);
    expect(await ensureOrdersFlow(o, 'https://x.test/flows/endpoint')).toBe('777');
    const created = JSON.parse(String(calls.at(-1)!.init.body));
    expect(created).toMatchObject({ endpoint_uri: 'https://x.test/flows/endpoint', publish: true });
    expect(created.name).toMatch(/^hoolam_orders_[0-9a-f]{8}$/);
  });
});

describe('my orders, in the form', () => {
  it('seller: filter, page of orders, the order with its next step, then dispatch by rider with the account checked', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    const t = signToken(h.app.formSecret, seller, 'seller', 'orders');
    const first = await call(t, 'INIT');
    expect(first.screen).toBe('FILTER');
    expect(first.data.filters.map((f: any) => f.id)).toEqual(['pending', 'completed', 'all']);
    expect(first.data.filters[0].description).toBe('1 order still going');

    const list = await call(t, 'data_exchange', { action: 'filter', filter: 'pending' });
    expect(list.screen).toBe('ORDERS');
    expect(list.data.summary).toBe('Pending · 1–1 of 1');
    expect(list.data.orders[0].id).toBe(code);
    expect(list.data.orders[0].title).toMatch(new RegExp(`^\\S+ · ${code} · ₦19,500$`)); // the buyer's name first, then what the seller receives
    expect(list.data.orders[0].description).toMatch(/Leather bag\n👉 Paid: dispatch it now/);
    expect(list.data.nav.map((n: any) => n.id)).toEqual(['f-completed', 'f-all']);

    const order = await call(t, 'data_exchange', { action: 'open', code });
    expect(order.screen).toBe('ORDER');
    expect(order.data).toMatchObject({ primary: 'dispatch', primary_label: 'Dispatch now', secondary: 'cantfulfil', has_secondary: true, has_tertiary: false });
    expect(order.data.key).toMatch(/💰 Total price ₦20,000\n🧾 Transaction fee −₦500\n💸 You receive ₦19,500/);

    expect((await call(t, 'data_exchange', { action: 'dispatch', code })).screen).toBe('DISPATCH');
    const picked = await call(t, 'data_exchange', { action: 'method', code, method: 'pickup' });
    expect(picked.data.show_pickup).toBe(true);
    const courier = await call(t, 'data_exchange', { action: 'dispatch_submit', code, method: 'rider' });
    expect(courier.screen).toBe('COURIER');
    expect(courier.data).toMatchObject({ is_rider: true, location: '12 Woji Road', footer_label: 'Continue', show_banks: false, phone_label: 'Rider\'s number' });
    expect(courier.data.heading).toBe(`🛵 ${(await h.db.query('SELECT display_name FROM users WHERE phone=$1', [buyer])).rows[0].display_name.split(' ')[0]} · ${code}`);

    const base = { op: 'courier', code, method: 'rider', name: 'Musa', phone: '08031234567', fee: '2000', location: '12 Woji Road', account_number: '0000014579' };
    const tooMuch = await call(t, 'data_exchange', { ...base, fee: '50000' });
    expect(tooMuch.data.error).toMatch(/less than what you receive/);
    const noName = await call(t, 'data_exchange', { ...base, name: '' });
    expect(noName.data.error).toMatch(/rider's name/);
    // 1. the account number: we list the banks it can be with, the big fintechs first
    const pick = await call(t, 'data_exchange', base);
    expect(pick.data).toMatchObject({ show_banks: true, footer_label: 'Check account', listed_for: '0000014579', show_confirm: false });
    const ids = pick.data.banks.map((b: any) => b.id);
    expect(ids.slice(0, 4)).toEqual(['999992', '50515', '999991', '50211']); // OPay, Moniepoint, PalmPay, Kuda always
    expect(ids).toContain('011'); // First Bank: 0000014579 passes its NUBAN check (CBN's example)
    expect(ids).not.toContain('058'); // GTBank: it can't be
    // 2. they pick First Bank: we check whose account it is
    const check = await call(t, 'data_exchange', { ...base, listed_for: '0000014579', bank: '011' });
    expect(check.screen).toBe('COURIER');
    expect(check.data).toMatchObject({ show_confirm: true, show_banks: false, bank: '011', footer_label: 'Dispatch' });
    expect(check.data.confirm_text).toMatch(/belongs to TEST ACCOUNT HOLDER \(First Bank ••••4579\)/);
    expect((await deal(code)).status).toBe('FUNDED'); // nothing saved until confirmed
    // 3. they tick "Yes, this is the right account" (the dropdown is hidden now, so the bank comes back from the screen)
    const done = await call(t, 'data_exchange', { ...base, listed_for: '0000014579', bank: '', chosen_bank: '011', confirm: true });
    expect(done.screen).toBe('DONE');
    expect(done.data.title).toBe('✅ Dispatched');
    const d = await deal(code);
    expect(d).toMatchObject({ status: 'SHIPPED', dispatch_method: 'RIDER', delivery_fee_minor: 200_000 });
    expect(h.last(buyer)).toMatch(/Your handover code/);

    // the code, in the form
    const ct = signToken(h.app.formSecret, seller, 'seller', 'code', code);
    const opened = await call(ct, 'INIT');
    expect(opened.screen).toBe('ORDER'); // a form can only open on its first screen
    expect(opened.data).toMatchObject({ primary: 'code', primary_label: 'Enter handover code' });
    expect((await call(ct, 'data_exchange', { op: 'code', code })).screen).toBe('CODE');
    const wrong = await call(ct, 'data_exchange', { action: 'code', code, digits: d.handover_code === '9999' ? '0000' : '9999' });
    expect(wrong.data.error).toMatch(/4 tries left/);
    const ok = await call(ct, 'data_exchange', { action: 'code', code, digits: d.handover_code });
    expect(ok.data.title).toBe('✅ Handed over');
    expect((await deal(code)).courier_paid_at).not.toBeNull();
  });

  it('buyer: the next step is the buyer\'s, and "I\'m happy" pays the seller', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    await h.tap(seller, `dispatch:${code}`); await h.tap(seller, 'dm:pickup'); await h.say(seller, 'Shop 4');
    const t = signToken(h.app.formSecret, buyer, 'buyer', 'order', code);
    const order = await call(t, 'INIT');
    expect(order.screen).toBe('ORDER');
    expect(order.data).toMatchObject({ primary: 'showcode', secondary: 'problem' });
    expect(order.data.key).toMatch(/Your handover code: \d{4}/);
    await h.tap(seller, `hcode:${code}`); await h.say(seller, (await deal(code)).handover_code);
    const again = await call(t, 'data_exchange', { action: 'open', code });
    expect(again.data).toMatchObject({ primary: 'happy', primary_label: 'I\'m happy' });
    const done = await call(t, 'data_exchange', { action: 'happy', code });
    expect(done.data.title).toBe('✅ Thank you');
    expect((await deal(code)).status).toBe('COMPLETED');
  });

  it('someone else\'s order can\'t be opened', async () => {
    const { code } = await paidBuyerOrder();
    const stranger = phone();
    await h.say(stranger, 'hi');
    const r = await call(signToken(h.app.formSecret, stranger, 'buyer', 'order', code), 'INIT');
    expect(r.screen).toBe('ORDER');
    expect(r.data).toMatchObject({ primary: 'close', has_photo1: false });
    expect(r.data.details).toMatch(/couldn't find that order/);
  });

  it('pages of 20, newest first, with next and previous', async () => {
    const buyer = phone();
    await h.say(buyer, 'hi', 'Ada');
    const u = (await h.db.query('SELECT id FROM users WHERE phone=$1', [buyer])).rows[0].id;
    for (let i = 0; i < 23; i++) {
      await h.db.query(
        `INSERT INTO deals (code, buyer_id, item, currency, price_minor, fee_minor, buyer_pays_minor, seller_gets_minor, status, started_by, created_at)
         VALUES ($1,$2,$3,'NGN',100000,30000,130000,100000,'CANCELLED','BUYER', now() - make_interval(mins => $4))`,
        [`HL-P${'ABCDEFGHJKMNPQRSTUVWXYZ'[i]}${'ABC'[i % 3]}22`, u, `Item ${i}`, i]);
    }
    const t = signToken(h.app.formSecret, buyer, 'buyer', 'orders');
    const p1 = await call(t, 'data_exchange', { action: 'filter', filter: 'completed' });
    expect(p1.data.orders).toHaveLength(20);
    expect(p1.data.orders[0].description).toMatch(/^Item 0\n/);
    expect(p1.data.summary).toBe('Completed · 1–20 of 23');
    expect(p1.data.nav.map((n: any) => n.id)).toEqual(['next', 'f-pending', 'f-all']);
    const p2 = await call(t, 'data_exchange', { action: 'nav', to: 'next', filter: 'completed', page: '1' });
    expect(p2.data.orders).toHaveLength(3);
    expect(p2.data.summary).toBe('Completed · 21–23 of 23');
    expect(p2.data.nav.map((n: any) => n.id)).toEqual(['prev', 'f-pending', 'f-all']);
    const back = await call(t, 'data_exchange', { action: 'nav', to: 'prev', filter: 'completed', page: '2' });
    expect(back.data.summary).toBe('Completed · 1–20 of 23');
    const all = await call(t, 'data_exchange', { action: 'nav', to: 'f-all', filter: 'completed', page: '1' });
    expect(all.data.summary).toBe('All orders · 1–20 of 23');
  });
});

describe('the private order page', () => {
  it('opens only with the right key, shows the order like a receipt, and never shows the handover code', async () => {
    const { seller, code } = await paidBuyerOrder();
    await h.tap(seller, `dispatch:${code}`); await h.tap(seller, 'dm:pickup'); await h.say(seller, 'Shop 4, Rumuola Plaza');
    const d = await deal(code);
    const ok = await h.app.app.inject({ method: 'GET', url: `/o/${code}?k=${d.view_token}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-robots-tag']).toBe('noindex');
    expect(ok.body).toMatch(/Leather bag/);
    expect(ok.body).toMatch(/Brown, medium/);
    expect(ok.body).toMatch(/Bags &amp; accessories/);
    expect(ok.body).toMatch(/Paid, money held by Hoolam/);
    expect(ok.body).toMatch(/Pickup at<\/b>Shop 4, Rumuola Plaza/);
    expect(ok.body).toMatch(/₦20,500/);
    expect(ok.body).not.toMatch(/handover code/i); // the page is for both sides; only the buyer may know the code
    expect((await h.app.app.inject({ method: 'GET', url: `/o/${code}?k=wrongwrongwrong` })).statusCode).toBe(404);
    expect((await h.app.app.inject({ method: 'GET', url: `/o/${code}` })).statusCode).toBe(404);
  });
});

describe('a seller opens a new order in the form', () => {
  async function newOrder() {
    const buyer = phone(), seller = phone();
    await h.say(seller, 'hi', 'Bayo Shoes');
    await h.say(buyer, 'hi', 'Ada Obi');
    await h.app.chat.handle({
      id: `n${seq}`, phone: buyer, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null,
      form: { flow_token: 'buy:v1', item: 'Wig', description: 'Bone straight, 22 inches', category: 'beauty', price: '30000', address: 'GRA', arrive_by: '2099-12-31', other_phone: seller, photos: [{ id: 'w1' }] },
    });
    await h.tap(buyer, 'buy:send');
    return { buyer, seller, code: h.last(buyer).match(/HL-[A-Z2-9]{5}/)![0] };
  }

  it('shows the order with Accept, Change price and Decline; the buyer can\'t take the seller\'s place', async () => {
    const { buyer, seller, code } = await newOrder();
    const r = await call(signToken(h.app.formSecret, seller, 'seller', 'order', code), 'INIT');
    expect(r.screen).toBe('ORDER');
    expect(r.data).toMatchObject({ primary: 'accept', primary_label: 'Accept order', secondary: 'counterask', secondary_label: 'Update price', tertiary: 'decline', has_tertiary: true, show_price: false });
    expect(r.data.heading).toMatch(/Ada wants to buy from you/);
    expect(r.data.item).toBe(`Wig (${code})`);
    expect(r.data.about).toMatch(/Bone straight, 22 inches/);
    expect(r.data.key).toMatch(/💰 Total price ₦30,000\n🧾 Transaction fee −₦500\n💸 You receive ₦29,500/);
    expect(r.data.key).toMatch(/📍 Deliver to: GRA/);
    expect(r.data.hint).toMatch(/within 4\d hours/);
    const own = await call(signToken(h.app.formSecret, buyer, 'seller', 'order', code), 'INIT');
    expect(own.data.primary).not.toBe('accept');
  });

  it('change price: asks for the bank in the chat first, then the buyer gets the new price', async () => {
    const { buyer, seller, code } = await newOrder();
    const t = signToken(h.app.formSecret, seller, 'seller', 'order', code);
    const ask = await call(t, 'data_exchange', { action: 'counterask', code });
    expect(ask.data).toMatchObject({ show_price: true, primary: 'counter', has_secondary: false, has_tertiary: false });
    expect(ask.data.hint).toMatch(/The buyer offered ₦30,000/);
    const bad = await call(t, 'data_exchange', { op: 'counter', code, new_price: 'abc', reason: 'Market price' });
    expect(bad.data).toMatchObject({ has_warn: true, show_price: true });
    expect(bad.data.warn).toMatch(/Type the price in naira/);
    const noWhy = await call(t, 'data_exchange', { op: 'counter', code, new_price: '28k', reason: ' ' });
    expect(noWhy.data.warn).toMatch(/Tell the buyer why/);
    const r = await call(t, 'data_exchange', { op: 'counter', code, new_price: '28k', reason: 'Fabric cost went up this week' });
    expect(r.data.title).toBe('🏦 One last step');
    expect(r.data).toMatchObject({ has_important: true, important: 'Then we send the buyer your new price.' });
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    expect(h.last(buyer)).toMatch(/\*Bayo\* updated the price/);
    expect(h.last(buyer)).toMatch(/💬 Reason: Fabric cost went up this week/);
    const d = await deal(code);
    expect(d.counter_price_minor).toBe(2_800_000);
    expect(d.counter_reason).toBe('Fabric cost went up this week');
    // the buyer sees it in the form too
    const seen = await call(signToken(h.app.formSecret, buyer, 'buyer', 'order', code), 'INIT');
    expect(seen.data.key).toMatch(/Seller's new price ₦28,000/);
    expect(seen.data.info).toMatch(/Reason: Fabric cost went up this week/);
  });

  it('decline from the form', async () => {
    const { buyer, seller, code } = await newOrder();
    const r = await call(signToken(h.app.formSecret, seller, 'seller', 'order', code), 'data_exchange', { action: 'decline', code });
    expect(r.data.title).toBe('Order declined');
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(buyer)).toMatch(/seller declined/);
  });

  it('accept from the form (with a saved bank account)', async () => {
    const { buyer, seller, code } = await newOrder();
    await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    const r = await call(signToken(h.app.formSecret, seller, 'seller', 'order', code), 'data_exchange', { action: 'accept', code });
    expect(r.data.title).toBe('✅ Order accepted');
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');
    expect(h.last(buyer)).toMatch(/accepted your order/);
  });

  it('"View order" in the chat opens the form when it\'s available', async () => {
    const { seller, code } = await newOrder();
    const opened: unknown[] = [];
    const chat = h.app.chat as any;
    const before = chat.o.ordersForm;
    chat.o.ordersForm = { open: async (_p: string, _u: unknown, at: unknown) => { opened.push(at); return true; } };
    try { await h.tap(seller, `sview:${code}`); } finally { chat.o.ordersForm = before; }
    expect(opened).toEqual([{ screen: 'order', code, mode: 'seller' }]);
  });
});

describe('the buyer checks their order before it goes to the seller', () => {
  async function filledIn() {
    const buyer = phone(), seller = phone();
    await h.say(buyer, 'hi', 'Ada Obi');
    await h.app.chat.handle({
      id: `p${++seq}`, phone: buyer, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null,
      form: { flow_token: 'buy:v1', item: 'Wig', description: 'Bone straight, 22 inches', category: 'beauty', price: '30000', address: 'GRA', arrive_by: '2099-12-31', other_phone: seller, photos: [{ id: 'w1' }] },
    });
    return { buyer, seller, t: signToken(h.app.formSecret, buyer, 'buyer', 'preview', '-', 24) };
  }

  it('opens in the form when it\'s available', async () => {
    const opened: unknown[] = [];
    const chat = h.app.chat as any;
    const before = chat.o.ordersForm;
    chat.o.ordersForm = { open: async (_p: string, _u: unknown, at: unknown) => { opened.push(at); return true; } };
    try { await filledIn(); } finally { chat.o.ordersForm = before; }
    expect(opened).toEqual([{ screen: 'preview', item: 'Wig', totalMinor: 3_000_000 }]);
  });

  it('shows everything, with the seller\'s number in full, and sends it', async () => {
    const { buyer, seller, t } = await filledIn();
    const r = await call(t, 'INIT');
    expect(r.screen).toBe('ORDER');
    expect(r.data).toMatchObject({ heading: '🛒 Check your order', item: 'Wig', primary: 'bsend', primary_label: 'Send to seller', secondary: 'bedit', tertiary: 'brestart', has_warn: true });
    expect(r.data.about).toMatch(/Bone straight, 22 inches/);
    expect(r.data.key).toMatch(/💰 Total price ₦30,000/);
    expect(r.data.key).toMatch(/📍 Deliver to: GRA/);
    expect(r.data.key).toContain(`Seller's WhatsApp: ${seller.replace('+234', '0')}`); // as people write it, no country code
    const sent = await call(t, 'data_exchange', { op: 'bsend', code: 'preview' });
    expect(sent.data.title).toBe('📨 Sent to the seller');
    expect(h.last(buyer)).toMatch(/HL-[A-Z2-9]{5}/);
    // a second tap doesn't send it twice
    const again = await call(t, 'data_exchange', { op: 'bsend', code: 'preview' });
    expect(again.data.title).toBe('Already sent');
    const stale = await call(t, 'INIT');
    expect(stale.data.heading).toBe('Nothing to check');
  });

  it('edit (in the chat when the edit form isn\'t there): change one thing, then the order shows again', async () => {
    const { buyer, t } = await filledIn();
    const r = await call(t, 'data_exchange', { op: 'bedit', code: 'preview' });
    expect(r.data.title).toBe('✏️ Edit your order');
    expect(h.last(buyer)).toMatch(/What do you want to change/);
    await h.tap(buyer, 'bfix:price');
    await h.say(buyer, '25000');
    expect(h.last(buyer)).toMatch(/💰 Total price  ₦25,000/);
    expect(h.last(buyer)).toMatch(/Bone straight/); // the rest is kept
  });

  it('the edit form keeps the photos unless new ones are added', async () => {
    const { buyer } = await filledIn();
    await h.app.chat.handle({
      id: `p${++seq}`, phone: buyer, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null,
      form: { flow_token: 'buyedit:v1', item: 'Wig, 24 inches', description: 'Bone straight', category: 'beauty', price: '32000', address: 'GRA', arrive_by: '2099-12-31', other_phone: '08031234567', photos: [] },
    });
    expect(h.last(buyer)).toMatch(/\*Wig, 24 inches\*/);
    expect(h.last(buyer)).toMatch(/📷 1 photo/);
    expect(h.last(buyer)).toMatch(/₦32,000/);
  });

  it('the edit form is the buyer\'s form, filled in, with photos optional', () => {
    const json = buyEditFlowJson('X') as any;
    const item = json.screens[0];
    expect(Object.keys(item.data)).toEqual(expect.arrayContaining(['item', 'description', 'category', 'price', 'address', 'arrive_by', 'other_phone', 'photo_note']));
    const fields = item.layout.children[1].children.filter((c: any) => c.name);
    for (const f of fields) expect(f['init-value']).toBe(`\${data.${f.name}}`);
    const picker = json.screens[2].layout.children[2].children[0];
    expect(picker['min-uploaded-photos']).toBe(0);
  });
});

describe('the order list', () => {
  it('names the other person, then the order code and amount, in 30 characters', () => {
    expect(rowTitle('Ada Obi', '+2348031234567', 'seller', 'HL-7K2QF', '₦20,000')).toBe('Ada · HL-7K2QF · ₦20,000');
    const noName = rowTitle(null, '+2348031234567', 'seller', 'HL-7K2QF', '₦20,000');
    expect(noName).toMatch(/^0803\d*…? · HL-7K2QF · ₦20,000$/);
    expect(noName.length).toBeLessThanOrEqual(30);
    expect(rowTitle(null, null, 'buyer', 'HL-7K2QF', '₦20,000')).toBe('Seller · HL-7K2QF · ₦20,000');
    expect(rowTitle('Oluwaseunfunmi', null, 'seller', 'HL-7K2QF', '₦1,200,000').length).toBeLessThanOrEqual(30);
  });
});
