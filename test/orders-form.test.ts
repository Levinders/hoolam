import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { decryptResponseForTest, encryptRequestForTest, flowKeys } from '../src/whatsapp/flow-crypto.js';
import { ordersFlowJson, readToken, signToken } from '../src/whatsapp/orders-flow.js';
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

const call = (token: string, action: string, data: Record<string, unknown> = {}) =>
  h.app.orders.handle({ action, flow_token: token, data }) as Promise<{ version: string; screen: string; data: any }>;

describe('the form itself', () => {
  it('stays within WhatsApp\'s rules', () => {
    const json = ordersFlowJson() as any;
    expect(json.data_api_version).toBe('3.0');
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
    expect(ids.filter((id: string) => !inbound.has(id))).toEqual(['FILTER']);
    // and no cycles
    const visit = (id: string, seen: string[]): void => { expect(seen).not.toContain(id); for (const n of rm[id] ?? []) visit(n, [...seen, id]); };
    visit('FILTER', []);
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
    const r = await call('o1.fake', 'INIT');
    expect(r).toMatchObject({ version: '3.0', screen: 'DONE' });
    expect(r.data.title).toMatch(/expired/);
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
    expect(list.data.orders[0]).toMatchObject({ id: code, title: `${code} · ₦20,000` });
    expect(list.data.orders[0].description).toMatch(/Leather bag\n👉 Paid: dispatch it now/);
    expect(list.data.nav.map((n: any) => n.id)).toEqual(['f-completed', 'f-all']);

    const order = await call(t, 'data_exchange', { action: 'open', code });
    expect(order.screen).toBe('ORDER');
    expect(order.data).toMatchObject({ primary: 'dispatch', primary_label: 'Dispatch now', secondary: 'cantfulfil', has_secondary: true, has_tertiary: false });
    expect(order.data.details).toMatch(/You receive ₦20,000/);

    expect((await call(t, 'data_exchange', { action: 'dispatch', code })).screen).toBe('DISPATCH');
    const picked = await call(t, 'data_exchange', { action: 'method', code, method: 'pickup' });
    expect(picked.data.show_pickup).toBe(true);
    const courier = await call(t, 'data_exchange', { action: 'dispatch_submit', code, method: 'rider' });
    expect(courier.screen).toBe('COURIER');
    expect(courier.data).toMatchObject({ is_rider: true, location: '12 Woji Road', footer_label: 'Check account' });

    const base = { action: 'courier', code, method: 'rider', name: 'Musa', phone: '08031234567', fee: '2000', location: '12 Woji Road', account_number: '9876543210', bank: 'opay' };
    const tooMuch = await call(t, 'data_exchange', { ...base, fee: '50000' });
    expect(tooMuch.data.error).toMatch(/less than what you receive/);
    const check = await call(t, 'data_exchange', base);
    expect(check.screen).toBe('COURIER');
    expect(check.data).toMatchObject({ show_confirm: true, footer_label: 'Dispatch' });
    expect(check.data.confirm_text).toMatch(/belongs to TEST ACCOUNT HOLDER/);
    expect((await deal(code)).status).toBe('FUNDED'); // nothing saved until confirmed
    const done = await call(t, 'data_exchange', { ...base, confirm: true });
    expect(done.screen).toBe('DONE');
    expect(done.data.title).toBe('✅ Dispatched');
    const d = await deal(code);
    expect(d).toMatchObject({ status: 'SHIPPED', dispatch_method: 'RIDER', delivery_fee_minor: 200_000 });
    expect(h.last(buyer)).toMatch(/Your handover code/);

    // the code, in the form
    const ct = signToken(h.app.formSecret, seller, 'seller', 'code', code);
    expect((await call(ct, 'INIT')).screen).toBe('CODE');
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
    expect(order.data.details).toMatch(/Your handover code: \d{4}/);
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
    expect(r.screen).toBe('DONE');
    expect(r.data.message).toMatch(/couldn't find that order/);
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
    expect(r.data).toMatchObject({ primary: 'accept', primary_label: 'Accept order', secondary: 'counterask', secondary_label: 'Change price', tertiary: 'decline', has_tertiary: true, show_price: false });
    expect(r.data.details).toMatch(/Ada wants to buy from you/);
    expect(r.data.details).toMatch(/Bone straight, 22 inches/);
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
    const bad = await call(t, 'data_exchange', { action: 'counter', code, new_price: 'abc' });
    expect(bad.data.hint).toMatch(/Type the price in naira/);
    const r = await call(t, 'data_exchange', { action: 'counter', code, new_price: '28k' });
    expect(r.data.title).toBe('🏦 One last step');
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    expect(h.last(buyer)).toMatch(/suggests a different price/);
    expect((await deal(code)).counter_price_minor).toBe(2_800_000);
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
