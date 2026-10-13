import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { Messenger, toPayload } from '../src/whatsapp/client.js';
import { parseInbound, parseStatuses } from '../src/whatsapp/inbound.js';
import { mapsLink } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348050000${String(++seq).padStart(3, '0')}`;
const deal = async (code: string) => (await h.db.query('SELECT * FROM deals WHERE code=$1', [code])).rows[0];
const sent = async (p: string) => (await h.db.query('SELECT kind, body FROM outbound_messages WHERE phone=$1 ORDER BY id', [p])).rows as { kind: string; body: any }[];
const said = (p: string) => h.transcript.filter((t) => t.phone === p).map((t) => t.text);
let n = 0;
const location = (p: string, lat: number, lng: number, name: string | null = null) =>
  h.app.chat.handle({ id: `loc${++n}`, phone: p, name: null, type: 'location', text: name ?? '', buttonId: null, mediaId: null, location: { latitude: lat, longitude: lng, name, address: null } });

/** A buyer's order by form, accepted by the seller and paid. */
async function paidOrder(opts: { address?: string } = {}) {
  const buyer = phone(), seller = phone();
  await h.say(seller, 'hi', 'Bayo Shoes');
  await h.say(buyer, 'hi', 'Ivana Eze');
  await h.app.chat.handle({
    id: `f${++n}`, phone: buyer, name: 'Ivana Eze', type: 'form', text: '', buttonId: null, mediaId: null,
    form: { flow_token: 'buy:v1', item: 'Leather bag', description: 'Brown, medium', category: 'bags', price: '20000', address: opts.address ?? '12 Woji Road, Port Harcourt', arrive_by: '2099-12-31', other_phone: seller, photos: [{ id: 'p1' }] },
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

describe('typing and blue ticks', () => {
  it('marks their message read with "typing…" (live only), and never blocks the reply', async () => {
    const calls: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const live = new Messenger(h.db, { dryRun: false, token: 't', phoneNumberId: '1', graphVersion: 'v26.0', fetchImpl: f });
    await live.markReadTyping('wamid.ABC');
    expect(calls[0]).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.ABC', typing_indicator: { type: 'text' } });
    const refusing = new Messenger(h.db, { dryRun: false, token: 't', phoneNumberId: '1', graphVersion: 'v26.0', fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch });
    await expect(refusing.markReadTyping('wamid.X')).resolves.toBeUndefined();
    const dry = new Messenger(h.db, { dryRun: true, token: 't', phoneNumberId: '1', graphVersion: 'v26.0', fetchImpl: f });
    await dry.markReadTyping('wamid.Y');
    expect(calls).toHaveLength(1);
  });
});

describe('quoting their message', () => {
  it('a correction quotes what they typed', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Ada');
    await h.tap(p, 'menu:buy');
    await h.say(p, 'Shoes'); await h.say(p, 'Size 42'); await h.tap(p, 'cat:shoes');
    await h.app.chat.handle({ id: 'wamid.price1', phone: p, name: null, type: 'text', text: 'a lot', buttonId: null, mediaId: null });
    const last = (await sent(p)).at(-1)!;
    expect(last.body.replyTo).toBe('wamid.price1');
    expect(toPayload('234', { kind: 'text', text: 'x', replyTo: 'wamid.price1' })).toMatchObject({ context: { message_id: 'wamid.price1' } });
  });
});

describe('Hoolam\'s contact card', () => {
  it('once, on the first message: why, then the card; never again', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Ada');
    const first = await sent(p);
    expect(first[0]!.body.text).toBe('📇 Save Hoolam so you always know it\'s really us. Our messages only ever come from this number, and we never ask for your PIN or OTP.');
    expect(first[1]!.kind).toBe('contact');
    expect(first[1]!.body.contact).toMatchObject({ name: 'Hoolam', phone: '2349000000000', org: 'HOOLAM DIGITAL PLATFORM LTD' });
    expect(toPayload('234', first[1]!.body)).toMatchObject({ type: 'contacts', contacts: [{ name: { formatted_name: 'Hoolam' }, phones: [{ phone: '+2349000000000', wa_id: '2349000000000' }] }] });
    await h.say(p, 'menu');
    expect((await sent(p)).filter((m) => m.kind === 'contact')).toHaveLength(1);
  });
});

describe('"seen"', () => {
  it('the seller opening the order tells the buyer once; the seen time shows in My orders', async () => {
    const buyer = phone(), seller = phone();
    await h.say(seller, 'hi', 'Bayo Shoes');
    await h.say(buyer, 'hi', 'Ivana Eze');
    await h.tap(buyer, 'menu:buy');
    await h.say(buyer, 'Loafers'); await h.say(buyer, 'Brown'); await h.tap(buyer, 'cat:shoes');
    await h.say(buyer, '12000'); await h.say(buyer, '12 Woji Road, Port Harcourt'); await h.tap(buyer, 'bdate:3');
    await h.tap(buyer, 'buy:nophotos'); await h.say(buyer, seller);
    await h.tap(buyer, 'buy:send');
    const code = h.last(buyer).match(/HL-[A-Z2-9]{5}/)![0];
    expect((await deal(code)).alert_wa_id).toMatch(/^dry\./);
    await h.tap(seller, `sview:${code}`);
    expect(said(buyer).at(-1)).toMatch(new RegExp(`👀 \\*Bayo\\* has seen your order \\*${code}\\*`)); // the name buyers see for this seller
    const before = said(buyer).length;
    await h.tap(seller, `sview:${code}`);
    expect(said(buyer).length).toBe(before); // once
    expect((await deal(code)).seen_at).toBeTruthy();
    const { signToken } = await import('../src/whatsapp/orders-flow.js');
    const order = await h.app.orders.handle({ action: 'data_exchange', flow_token: signToken(h.app.formSecret, buyer, 'buyer', 'orders', '-'), data: { action: 'open', code } }) as any;
    expect(order.data.info).toMatch(/^👀 Seen \d{1,2} \w{3} · \d{1,2}:\d{2} [ap]m/);
  });

  it('a read receipt for the alert counts too', async () => {
    const buyer = phone(), seller = phone();
    await h.say(buyer, 'hi', 'Ivana Eze');
    await h.tap(buyer, 'menu:buy');
    await h.say(buyer, 'Loafers'); await h.say(buyer, 'Brown'); await h.tap(buyer, 'cat:shoes');
    await h.say(buyer, '12000'); await h.say(buyer, '12 Woji Road, Port Harcourt'); await h.tap(buyer, 'bdate:3');
    await h.tap(buyer, 'buy:nophotos'); await h.say(buyer, seller);
    await h.tap(buyer, 'buy:send');
    const code = h.last(buyer).match(/HL-[A-Z2-9]{5}/)![0];
    const d = await deal(code);
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: d.alert_wa_id, status: 'read', recipient_id: seller.slice(1) }] } }] }] };
    expect(parseStatuses(body)).toEqual([{ id: d.alert_wa_id, status: 'read', phone: seller }]);
    await h.app.deals.seenByMessage(d.alert_wa_id);
    expect(said(buyer).at(-1)).toMatch(/has seen your order/);
  });
});

describe('sharing a location', () => {
  it('reads a location message', () => {
    const [m] = parseInbound({ entry: [{ changes: [{ value: { contacts: [], messages: [{ id: 'w1', from: '2348011112222', type: 'location', location: { latitude: 4.8156, longitude: 7.0498, name: 'Woji Junction' } }] } }] }] });
    expect(m).toMatchObject({ type: 'location', text: 'Woji Junction', location: { latitude: 4.8156, longitude: 7.0498, name: 'Woji Junction' } });
  });

  it('the buyer shares a pin, adds a landmark; the seller gets a map link, the rider a real pin', async () => {
    const buyer = phone(), seller = phone(), rider = phone();
    await h.say(seller, 'hi', 'Bayo Shoes');
    await h.say(buyer, 'hi', 'Ivana Eze');
    await h.tap(buyer, 'menu:buy');
    await h.say(buyer, 'Loafers'); await h.say(buyer, 'Brown'); await h.tap(buyer, 'cat:shoes');
    await h.say(buyer, '12000');
    expect(h.last(buyer)).toMatch(/Or share your location: tap 📎 → \*Location\*/);
    await location(buyer, 4.8156, 7.0498, 'Woji Junction');
    expect(h.last(buyer)).toMatch(/Got your location: _Woji Junction_[\s\S]*landmark[\s\S]*\[Skip\]/);
    await h.say(buyer, 'Blue gate, opposite First Bank');
    expect(h.last(buyer)).toMatch(/expecting it/i); // on to the next question
    await h.tap(buyer, 'bdate:3'); await h.tap(buyer, 'buy:nophotos'); await h.say(buyer, seller);
    await h.tap(buyer, 'buy:send');
    const code = h.last(buyer).match(/HL-[A-Z2-9]{5}/)![0];
    expect(await deal(code)).toMatchObject({ delivery_address: 'Blue gate, opposite First Bank · Woji Junction', delivery_pin: '4.815600,7.049800' });
    await h.tap(seller, `saccept:${code}`);
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    await h.tap(buyer, `pay:${code}`);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
    h.provider.pay(r.rows[0].provider_reference);
    await h.app.deals.handleCollection(r.rows[0].provider_reference);
    expect(h.last(seller)).toMatch(/🗺️ Map: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=4\.815600,7\.049800/);
    // the rider is in the chat with Hoolam, so they get a real pin too
    await h.say(rider, 'hi', 'Musa');
    await h.tap(seller, `dispatch:${code}`); await h.tap(seller, 'dm:rider');
    await h.say(seller, 'Musa'); await h.say(seller, rider); await h.say(seller, '2000');
    expect(h.last(seller)).toMatch(/Or share your location/);
    await h.tap(seller, 'dloc:buyer');
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'dacct:yes');
    const riderMsgs = await sent(rider);
    expect(riderMsgs.some((m) => m.body.text?.includes('🗺️ Map: https://www.google.com/maps/search/?api=1&query=4.815600,7.049800'))).toBe(true);
    expect(riderMsgs.find((m) => m.kind === 'location')?.body).toMatchObject({ latitude: 4.8156, longitude: 7.0498, name: 'Deliver to Ivana' });
  });

  it('a typed address still gets a map link that searches it', () => {
    expect(mapsLink('12 Woji Road, Port Harcourt')).toBe('https://www.google.com/maps/search/?api=1&query=12%20Woji%20Road%2C%20Port%20Harcourt');
    expect(mapsLink('ok')).toBeNull();
  });
});

describe('receipts', () => {
  it('payment: the buyer\'s receipt and the seller\'s copy come just before the messages, as pictures', async () => {
    const { buyer, seller, code } = await paidOrder();
    const b = said(buyer), s = said(seller);
    expect(b.at(-2)).toBe(`[photo] 🧾 Receipt · Order ${code}`);
    expect(b.at(-1)).toMatch(/held/i);
    expect(s.at(-2)).toBe(`[photo] 🧾 Receipt · Order ${code}`);
    expect(s.at(-1)).toMatch(/has paid for order/);
    const d = await deal(code);
    const copy = await h.app.deals.receiptData(d.id, 'payment-seller');
    expect(copy).toMatchObject({ title: 'Payment confirmed by Hoolam', amount: '₦20,500', note: expect.stringMatching(/not a buyer’s screenshot/) });
    expect(copy!.rows.at(-1)).toMatchObject({ label: 'You receive', value: '₦19,500', strong: true });
    const mine = await h.app.deals.receiptData(d.id, 'payment');
    expect(mine).toMatchObject({ title: 'Payment received', status: 'Held safely by Hoolam until you’re happy' });
    const img = await h.app.deals.receiptImage(d.id, 'payment');
    expect(img!.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // a JPEG
  });

  it('payout: the seller gets a receipt; My orders and the order page show them', async () => {
    const { buyer, seller, code } = await paidOrder();
    await h.tap(seller, `dispatch:${code}`); await h.tap(seller, 'dm:pickup'); await h.say(seller, 'Shop 4, Rumuola Plaza');
    const d0 = await deal(code);
    await h.tap(seller, `hcode:${code}`); await h.say(seller, d0.handover_code);
    await h.tap(buyer, `happy:${code}`);
    const s = said(seller);
    expect(s.at(-2)).toBe(`[photo] 🧾 Receipt · Order ${code}`);
    expect(s.at(-1)).toMatch(/You've been paid/);
    const list = await h.app.deals.receiptsFor(d0.id, 'seller');
    expect(list.map((r) => r.kind)).toEqual(['payment-seller', 'payout']);
    const payout = await h.app.deals.receiptData(d0.id, 'payout', list[1]!.payoutId);
    expect(payout).toMatchObject({ title: 'Payout sent', status: 'Sent to GTBank ••••6789' });
    // the order page, seller's link
    const { viewKey } = await import('../src/deals/service.js');
    const k = viewKey(d0.view_token, 'seller');
    const page = await h.app.app.inject({ url: `/o/${code}?k=${k}` });
    expect(page.body).toMatch(/<h2>Receipts<\/h2>/);
    const pic = await h.app.app.inject({ url: `/o/${code}/r/1.jpg?k=${k}` });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/jpeg');
    expect((await h.app.app.inject({ url: `/o/${code}/r/1.jpg?k=wrongkey123` })).statusCode).toBe(404);
  });
});

describe('order alerts with a picture', () => {
  it('the new alert carries the item\'s first photo; the older one (while Meta reviews) has none', async () => {
    const calls: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Response.json({ messages: [{ id: 'wamid.T1' }] }); }) as unknown as typeof fetch;
    const live = new Messenger(h.db, { dryRun: false, token: 't', phoneNumberId: '1', graphVersion: 'v26.0', fetchImpl: f });
    live.setTemplateImageHeader('hoolam_new_order_request_v3');
    live.setTemplateReplaces('hoolam_new_order_request_v3', 'hoolam_new_order_request_v2');
    const tpl = { name: 'hoolam_new_order_request_v3', language: 'en', params: ['Ada', 'Shoes', '₦1', 'HL-X'], preview: 'x', headerImage: 'media-1' };
    live.setTemplateStatus('hoolam_new_order_request_v2', 'APPROVED');
    await live.sendTemplate('+2348000000001', tpl);
    expect(calls[0].template.name).toBe('hoolam_new_order_request_v2');
    expect(calls[0].template.components.some((c: any) => c.type === 'header')).toBe(false);
    live.setTemplateStatus('hoolam_new_order_request_v3', 'APPROVED');
    await live.sendTemplate('+2348000000001', tpl);
    expect(calls[1].template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] });
    expect(await live.lastSentId('+2348000000001')).toBe('wamid.T1');
  });
});
