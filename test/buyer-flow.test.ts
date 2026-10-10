import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { ensureBuyFlow, ensureSellerAlertTemplate, SELLER_ALERT } from '../src/whatsapp/automation.js';
import { buyFlowJson, buyFlowName, readBuyForm, sellFlowJson } from '../src/whatsapp/buy-flow.js';
import { Messenger, checkLimits } from '../src/whatsapp/client.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348050000${String(++seq).padStart(3, '0')}`;
let n = 0;
const photo = (p: string) => h.app.chat.handle({ id: `img${++n}`, phone: p, name: null, type: 'image', text: '', buttonId: null, mediaId: `media-${n}`, mimeType: 'image/jpeg' });
const submitForm = (p: string, form: Record<string, unknown>, name = 'Ada Obi') =>
  h.app.chat.handle({ id: `form${++n}`, phone: p, name, type: 'form', text: '', buttonId: null, mediaId: null, form: { flow_token: 'buy:v1', ...form } });

const deal = async (code: string) => (await h.db.query('SELECT * FROM deals WHERE code=$1', [code])).rows[0];
const lastOut = async (p: string) => (await h.db.query('SELECT kind, body, status FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [p])).rows[0];
const codeIn = (t: string) => t.match(/HL-[A-Z2-9]{5}/)![0];

/** Buyer goes through the chat questions. Returns the deal code. */
async function buyByChat(buyer: string, opts: { sellerPhone?: string; photos?: number; price?: string } = {}) {
  await h.say(buyer, 'hi', 'Ada Obi');
  await h.tap(buyer, 'menu:buy');
  await h.say(buyer, 'Black sneakers, size 42');
  await h.say(buyer, 'Brand new, in the box'); await h.tap(buyer, 'cat:other');
  await h.say(buyer, opts.price ?? '15k'); await h.tap(buyer, 'dlv:free');
  for (let i = 0; i < (opts.photos ?? 0); i++) await photo(buyer);
  await h.tap(buyer, opts.photos ? 'buy:photosdone' : 'buy:nophotos');
  if (opts.sellerPhone) await h.say(buyer, opts.sellerPhone); else await h.tap(buyer, 'buy:nophone');
  await h.tap(buyer, 'buy:send');
  return codeIn(h.last(buyer));
}

describe('the buyer form', () => {
  it('fits WhatsApp limits', () => {
    const json = buyFlowJson('aGVsbG8=');
    const flat = (cs: any[]): any[] => cs.flatMap((c) => (c.type === 'Form' ? flat(c.children) : c.type === 'If' ? flat([...c.then, ...(c.else ?? [])]) : [c]));
    const all = json.screens.flatMap((s) => flat(s.layout.children as any[]));
    expect(json.screens.map((s) => s.id)).toEqual(['ITEM', 'DELIVERY', 'PHOTOS']);
    for (const c of all) if ('required' in c) expect(c.required).toBe(true); // every answer is required
    expect(all.find((c) => c.type === 'PhotoPicker')).toMatchObject({ 'min-uploaded-photos': 1, 'photo-source': 'camera_gallery', 'max-file-size-kb': 25600 });
    expect(all.find((c) => c.type === 'Dropdown')['data-source'].length).toBeLessThanOrEqual(10);
    for (const c of all) {
      if (c.type === 'TextInput') { expect(c.label.length).toBeLessThanOrEqual(20); expect((c['helper-text'] ?? '').length).toBeLessThanOrEqual(30); }
      if (c.type === 'DatePicker') expect(c.label.length).toBeLessThanOrEqual(40);
      if (c.type === 'Footer') expect(c.label.length).toBeLessThanOrEqual(35);
      if (c.type === 'PhotoPicker') expect(c['max-uploaded-photos']).toBe(3);
    }
    expect(json.screens.find((s) => s.id === 'PHOTOS')!.terminal).toBe(true);
    expect(buyFlowName(json)).toMatch(/^hoolam_buy_[0-9a-f]{8}$/);
    expect(buyFlowName(json)).toBe(buyFlowName(buyFlowJson('aGVsbG8=')));
  });

  it('the real banner is small enough for WhatsApp', () => {
    const src = (buyFlowJson().screens[0]!.layout.children[0] as { src: string }).src;
    expect(Buffer.from(src, 'base64').length).toBeLessThan(300 * 1024);
  });

  it('reads form answers, including photos and dates', () => {
    const f = readBuyForm({ item: ' Phone case ', price: 8000, other_phone: '0803 000 0000', arrive_by: '2026-10-09', photos: [{ id: '111', mime_type: 'image/png', file_name: 'a.png' }] });
    expect(f).toEqual({ item: 'Phone case', price: '8000', otherPhone: '0803 000 0000', arriveBy: '2026-10-09', photos: [{ mediaId: '111', mimeType: 'image/png' }],
      description: null, category: null, delivery: null, deliveryFee: null, deliveryPaid: false });
    expect(readBuyForm({ description: ' Black, size 42 ', category: 'shoes', delivery: 'paid', delivery_fee: '2,500' }))
      .toMatchObject({ description: 'Black, size 42', category: 'shoes', delivery: 'DELIVERY', deliveryPaid: true, deliveryFee: '2,500' });
    expect(readBuyForm({ delivery: 'pickup', delivery_fee: '' })).toMatchObject({ delivery: 'PICKUP', deliveryPaid: false, deliveryFee: null });
    expect(readBuyForm({ arrive_by: '1791504000000' }).arriveBy).toBe('2026-10-09');
    expect(readBuyForm({ arrive_by: '' }).arriveBy).toBeNull();
  });

  it('all new messages fit WhatsApp limits', () => {
    const money = { minor: 1_500_000, currency: 'NGN' as const };
    for (const m of [
      msg.buyForm('1', 'draft'), msg.askBuyPhotos(), msg.photoAdded(1, 3), msg.askSellerPhone(),
      msg.buySummary({ item: 'x', photos: 2, arriveBy: 'Fri 9 Oct', sellerPhone: '+2348031234567', price: money, fee: money, total: money }),
      msg.buyDealReady('HL-AAAAA', 'https://wa.me/1?text=View%20HL-AAAAA', 'sent', 48),
      msg.sellerDealCard({ code: 'HL-AAAAA', buyerName: 'Ada', item: 'x', price: money, sellerGets: money, arriveBy: null, hoursLeft: 48, invited: true }),
      msg.buyerSellerAccepted('HL-AAAAA', 'Bayo', 'x', money),
      msg.askCategory(), msg.askDelivery(), msg.askDeliveryFee(), msg.askBuyDescription(),
      msg.sellerDealCard({ code: 'HL-AAAAA', buyerName: 'Ada', item: 'x', description: 'y', category: 'Shoes', delivery: 'DELIVERY', deliveryFee: money, price: money, sellerGets: money, arriveBy: 'Fri 9 Oct', hoursLeft: 48, invited: true }),
    ]) expect(() => checkLimits(m)).not.toThrow();
  });
});

describe('a buyer starts a deal in the chat', () => {
  it('asks step by step, shows a summary, then alerts the seller and gives a link', async () => {
    const buyer = phone(), seller = phone();
    await h.say(buyer, 'hi', 'Ada Obi');
    await h.tap(buyer, 'menu:buy');
    expect(h.last(buyer)).toMatch(/What are you buying/);
    await h.say(buyer, 'Black sneakers, size 42');
    expect(h.last(buyer)).toMatch(/Describe it/);
    await h.say(buyer, 'Brand new, in the box');
    expect((await lastOut(buyer)).body.kind).toBe('list'); // category
    await h.tap(buyer, 'cat:shoes');
    expect(h.last(buyer)).toMatch(/What price did you agree/);
    await h.say(buyer, '15k');
    expect(h.last(buyer)).toMatch(/How will you get it/);
    await h.tap(buyer, 'dlv:paid');
    expect(h.last(buyer)).toMatch(/How much is the delivery fee/);
    await h.say(buyer, '2,500');
    expect(h.last(buyer)).toMatch(/Send up to 3/);
    await photo(buyer);
    expect(h.last(buyer)).toMatch(/Photo saved/);
    await h.tap(buyer, 'buy:photosdone');
    expect(h.last(buyer)).toMatch(/seller's WhatsApp number/);
    await h.tap(buyer, 'buy:restart'); // start over, then do it all in one go
    const code = await buyByChat(buyer, { sellerPhone: seller.replace('+234', '0'), photos: 1 });

    const d = await deal(code);
    expect(d.status).toBe('AWAITING_SELLER');
    expect(d.started_by).toBe('BUYER');
    expect(d.seller_id).toBeNull();
    expect(d.invited_phone).toBe(seller);
    expect(d.buyer_pays_minor).toBe(1_540_000);
    expect(h.last(buyer)).toMatch(/We've alerted the seller/);
    expect(h.last(buyer)).toMatch(/text=View%20HL-/);
    expect(h.last(buyer)).toMatch(/48 hours/);

    const alert = await lastOut(seller);
    expect(alert.kind).toBe('template');
    expect(alert.body.text).toMatch(/Ada wants to buy Black sneakers, size 42 from you for ₦15,000/);
    const photos = await h.db.query('SELECT wa_media_id FROM deal_photos WHERE deal_id=$1', [d.id]);
    expect(photos.rowCount).toBe(1);
  });

  it('the summary shows the money before anything is sent', async () => {
    const buyer = phone();
    await h.say(buyer, 'hi');
    await h.tap(buyer, 'menu:buy');
    await h.say(buyer, 'Wig');
    await h.say(buyer, 'Brand new, in the box'); await h.tap(buyer, 'cat:other');
    await h.say(buyer, '20000'); await h.tap(buyer, 'dlv:free');
    await h.tap(buyer, 'buy:nophotos');
    await h.tap(buyer, 'buy:nophone');
    expect(h.last(buyer)).toMatch(/Check your order/);
    expect(h.last(buyer)).toMatch(/You'll pay    ₦20,500/);
    expect(h.last(buyer)).toMatch(/Nothing to pay yet/);
    expect(h.last(buyer)).toMatch(/\[📨 Send to seller\]/);
  });

  it('a bad phone number can be fixed or skipped', async () => {
    const buyer = phone();
    await h.say(buyer, 'hi');
    await h.tap(buyer, 'menu:buy');
    await h.say(buyer, 'Bag'); await h.say(buyer, 'Brand new, in the box'); await h.tap(buyer, 'cat:other'); await h.say(buyer, '9000'); await h.tap(buyer, 'dlv:free'); await h.tap(buyer, 'buy:nophotos');
    await h.say(buyer, 'not a number');
    expect(h.last(buyer)).toMatch(/couldn't read that number/);
    await h.say(buyer, 'skip');
    expect(h.last(buyer)).toMatch(/You'll get a link for the seller/);
  });
});

describe('the seller answers', () => {
  it('views, accepts (adding a bank), and the deal carries on to payment and payout', async () => {
    const buyer = phone(), seller = phone();
    const code = await buyByChat(buyer, { sellerPhone: seller, photos: 2 });

    await h.app.chat.handle({ id: `t${++n}`, phone: seller, name: 'Bayo Shoes', type: 'button', text: 'View deal', buttonId: `sview:${code}`, mediaId: null });
    expect(h.last(seller)).toMatch(/Ada wants to buy from you/);
    expect(h.last(seller)).toMatch(/You receive \*₦15,000\*/);
    expect(h.last(seller)).toMatch(/Brand new, in the box/);
    expect(h.last(seller)).toMatch(/🚚 Free delivery \(you arrange it\)/);
    expect(h.last(seller)).toMatch(/\[✅ Accept\] \[✏️ Change price\] \[✕ Decline\]/);
    const images = await h.db.query(`SELECT count(*)::int AS c FROM outbound_messages WHERE phone=$1 AND kind='image'`, [seller]);
    expect(images.rows[0].c).toBe(2);

    await h.tap(seller, `saccept:${code}`);
    expect(h.last(seller)).toMatch(/where should we pay you/);
    await h.say(seller, '0123456789 GTBank');
    await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/Order HL-.* accepted/);
    expect(h.last(buyer)).toMatch(/Bayo accepted your order/);
    expect(h.last(buyer)).toMatch(/\[💳 Pay now\]/);
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');

    await h.tap(buyer, `pay:${code}`);
    expect(h.last(buyer)).toMatch(/Transfer exactly ₦15,400/);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
    h.provider.pay(r.rows[0].provider_reference);
    await h.app.deals.handleCollection(r.rows[0].provider_reference);
    expect(h.last(seller)).toMatch(/the buyer has paid/);
    await h.tap(seller, `shipped:${code}`);
    await h.tap(buyer, `happy:${code}`);
    expect((await deal(code)).status).toBe('COMPLETED');
    expect(h.last(seller)).toMatch(/You've been paid/);
  });

  it('decline: the buyer is told, nothing moved', async () => {
    const buyer = phone(), seller = phone();
    const code = await buyByChat(buyer, { sellerPhone: seller });
    await h.tap(seller, `sview:${code}`);
    await h.tap(seller, `sdecline:${code}`);
    expect(h.last(seller)).toMatch(/\[Not interested\] \[🚫 Wrong number\]/); // they were alerted by number
    await h.tap(seller, `sno:${code}`);
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(buyer)).toMatch(/seller declined/);
    expect(h.last(seller)).toMatch(/declined. No money moved/);
  });

  it('"Not me": the number is never alerted again', async () => {
    const buyer = phone(), stranger = phone();
    const code = await buyByChat(buyer, { sellerPhone: stranger });
    await h.tap(stranger, `snotme:${code}`);
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(buyer)).toMatch(/says it isn't the seller/);
    expect(h.last(stranger)).toMatch(/won't send you order alerts again/);

    const before = (await h.db.query(`SELECT count(*)::int AS c FROM outbound_messages WHERE phone=$1 AND kind='template'`, [stranger])).rows[0].c;
    await buyByChat(buyer, { sellerPhone: stranger });
    const after = (await h.db.query(`SELECT count(*)::int AS c FROM outbound_messages WHERE phone=$1 AND kind='template'`, [stranger])).rows[0].c;
    expect(after).toBe(before);
    expect(h.last(buyer)).toMatch(/asked us not to message it/);
  });

  it('without a number: the seller opens the forwarded link and accepts with their saved bank', async () => {
    const buyer = phone(), seller = phone();
    // seller already has a bank account from selling before
    await h.say(seller, 'hi'); await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 Opay'); await h.tap(seller, 'bank:yes');
    const code = await buyByChat(buyer);
    expect(h.last(buyer)).toMatch(/Send this link to the seller/);
    await h.say(seller, `View ${code}`, 'Chidi');
    expect(h.last(seller)).toMatch(/wants to buy from you/);
    expect(h.last(seller)).not.toMatch(/Not me/); // they weren't alerted
    await h.tap(seller, `saccept:${code}`);
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');
    expect(h.last(seller)).toMatch(/paid into .*••••6789/);
  });

  it('a second person can\'t take a deal someone already accepted', async () => {
    const buyer = phone(), s1 = phone(), s2 = phone();
    const code = await buyByChat(buyer);
    await h.say(s1, `View ${code}`); await h.tap(s1, `saccept:${code}`); await h.say(s1, '0123456789 Kuda'); await h.tap(s1, 'bank:yes');
    await h.say(s2, `View ${code}`);
    expect(h.last(s2)).toMatch(/already has a seller/);
  });

  it('the buyer can\'t accept their own deal, and gets the link to forward instead', async () => {
    const buyer = phone();
    const code = await buyByChat(buyer);
    await h.say(buyer, `View ${code}`);
    expect(h.last(buyer)).toMatch(/This is your order/);
  });
});

describe('buyer side, edges', () => {
  it('the form: answers arrive, summary shows photos and date, deal saves the date', async () => {
    const buyer = phone(), seller = phone();
    await h.say(buyer, 'hi', 'Ada Obi');
    await submitForm(buyer, {
      item: 'Gold earrings', description: '18k plated, pair', category: 'bags', price: '12000', other_phone: seller,
      delivery: 'paid', delivery_fee: '2500', arrive_by: '2026-10-09', photos: [{ id: 'f1', mime_type: 'image/jpeg' }, { id: 'f2', mime_type: 'image/jpeg' }],
    });
    expect(h.last(buyer)).toMatch(/Check your order/);
    expect(h.last(buyer)).toMatch(/18k plated, pair/);
    expect(h.last(buyer)).toMatch(/🏷️ Bags & accessories/);
    expect(h.last(buyer)).toMatch(/📷 2 photos/);
    expect(h.last(buyer)).toMatch(/Needed by Fri 9 Oct/);
    expect(h.last(buyer)).toMatch(/Price         ₦12,000\nDelivery      ₦2,500\nHoolam fee    ₦300\n\*You'll pay    ₦14,800\*/);
    await h.tap(buyer, 'buy:send');
    const d = await deal(codeIn(h.last(buyer)));
    expect(d).toMatchObject({ arrive_by: '2026-10-09', description: '18k plated, pair', category: 'bags', delivery_method: 'DELIVERY' });
    expect(Number(d.delivery_fee_minor)).toBe(250_000);
    expect(Number(d.buyer_pays_minor)).toBe(1_480_000); // price + delivery + fee
    expect(Number(d.seller_gets_minor)).toBe(1_450_000); // price + delivery: the seller pays the rider
    await h.tap(seller, `sview:${d.code}`);
    expect(h.last(seller)).toMatch(/Wanted by Fri 9 Oct/);
    expect(h.last(seller)).toMatch(/🚚 Delivery fee ₦2,500 \(you arrange the rider\)/);
    expect(h.last(seller)).toMatch(/You receive \*₦14,500\*/);

    // the seller suggests a new price: the delivery fee stays on top
    await h.tap(seller, `scounter:${d.code}`);
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    await h.say(seller, '14000');
    if (/account number and bank/.test(h.last(seller))) { await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes'); }
    await h.tap(buyer, `cyes:${d.code}`);
    const after = await deal(d.code);
    expect(Number(after.buyer_pays_minor)).toBe(1_400_000 + 250_000 + 40_000);
    expect(Number(after.seller_gets_minor)).toBe(1_400_000 + 250_000);
  });

  it('the form: pickup, no fee; a missing answer is asked in the chat', async () => {
    const buyer = phone(), seller = phone();
    await h.say(buyer, 'hi', 'Ada Obi');
    await submitForm(buyer, { item: 'Rice, 50kg', category: 'food', price: '45000', other_phone: seller, delivery: 'pickup', arrive_by: '2026-10-12', photos: [{ id: 'p1' }] });
    expect(h.last(buyer)).toMatch(/Describe it/); // description missing
    await h.say(buyer, 'Mama Gold, sealed');
    expect(h.last(buyer)).toMatch(/📍 You'll pick it up/);
    expect(h.last(buyer)).toMatch(/Pickup on Mon 12 Oct/);
    expect(h.last(buyer)).not.toMatch(/Delivery  /);
  });

  it('the form: a bad price is asked again in the chat', async () => {
    const buyer = phone();
    await h.say(buyer, 'hi');
    await submitForm(buyer, { item: 'Laptop', description: 'HP, 16GB', category: 'electronics', price: '900000', delivery: 'free', other_phone: '08031112222', photos: [{ id: 'l1' }] });
    expect(h.last(buyer)).toMatch(/up to ₦50,000/);
    await h.say(buyer, '45000');
    expect(h.last(buyer)).toMatch(/Check your order/);
    expect(h.last(buyer)).toMatch(/🚚 Free delivery from the seller/);
  });

  it('the buyer can cancel while waiting for the seller', async () => {
    const buyer = phone();
    const code = await buyByChat(buyer);
    await h.tap(buyer, `cancel:${code}`);
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(buyer)).toMatch(/cancelled/);
  });

  it('if the seller never answers, the deal closes after the time limit', async () => {
    const buyer = phone();
    const code = await buyByChat(buyer);
    await h.db.query(`UPDATE deals SET accept_by=now() - interval '1 minute' WHERE code=$1`, [code]);
    await h.app.deals.sweep({ nudgeAfterHours: 24 });
    expect((await deal(code)).status).toBe('EXPIRED');
    expect(h.last(buyer)).toMatch(/didn't accept order .* in time/);
  });

  it('"My orders" shows an order waiting for the seller', async () => {
    const buyer = phone();
    const code = await buyByChat(buyer);
    await h.tap(buyer, 'menu:deals');
    expect(h.last(buyer)).toMatch(new RegExp(`${code}\\* · .*\\n.* · waiting for the seller to accept`));
  });
});

describe('when WhatsApp refuses the form', () => {
  it('falls back to the chat questions and stops offering the form', async () => {
    const buyer = phone();
    await h.say(buyer, 'hi');
    h.app.setBuyForm({ flowId: 'flow-1', mode: 'draft' });
    const realSend = h.app.messenger.send.bind(h.app.messenger);
    let formTries = 0;
    h.app.messenger.send = async (p, m) => { if (m.kind === 'form') { formTries++; return 'FAILED'; } return realSend(p, m); };
    await h.tap(buyer, 'menu:buy');
    expect(h.last(buyer)).toMatch(/What are you buying/);
    await h.tap(buyer, 'menu:buy');
    expect(formTries).toBe(1);
    h.app.messenger.send = realSend;
  });
});

describe('Meta setup', () => {
  const fakeMeta = (state: { flows: any[]; templates: any[] }) => {
    const calls: { method: string; url: string; body: any }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      if (url.includes('/flows') && method === 'GET') return Response.json({ data: state.flows });
      if (url.includes('/flows')) return Response.json({ id: 'flow-1', success: true, validation_errors: [] });
      if (url.includes('message_templates') && method === 'GET') return Response.json({ data: state.templates });
      return Response.json({ id: 'tpl-1', status: 'PENDING', category: 'UTILITY' });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const base = { token: 't', phoneNumberId: 'p', graphVersion: 'v26.0', wabaId: 'waba', formMode: 'draft' as const };

  it('creates the form and the alert template when missing', async () => {
    const { f, calls } = fakeMeta({ flows: [], templates: [] });
    const log: string[] = [];
    expect(await ensureBuyFlow({ ...base, fetchImpl: f, log: (l) => log.push(l) })).toBe('flow-1');
    expect(await ensureSellerAlertTemplate({ ...base, fetchImpl: f, log: (l) => log.push(l) })).toBe('PENDING');
    const flowPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/waba/flows'))!;
    expect(flowPost.body.name).toMatch(/^hoolam_buy_/);
    expect(flowPost.body.publish).toBe(false);
    expect(JSON.parse(flowPost.body.flow_json).version).toBe('7.3');
    const tplPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/waba/message_templates'))!;
    expect(tplPost.body.category).toBe('UTILITY');
    expect(tplPost.body.components[0].text).toBe(SELLER_ALERT.body);
    expect(tplPost.body.components[0].text).not.toMatch(/^\{\{|\}\}$/); // can't start or end with a variable
    expect(tplPost.body.components[2].buttons.map((b: any) => b.text)).toEqual(['View order', 'Not me']);
  });

  it('never uses a form Meta found problems with', async () => {
    const bad = (async (url: string, init: RequestInit = {}) => (init.method === 'POST'
      ? Response.json({ id: 'flow-x', success: true, validation_errors: [{ message: 'Property is expecting string but got number' }] })
      : Response.json({ data: [] }))) as unknown as typeof fetch;
    const log: string[] = [];
    expect(await ensureBuyFlow({ ...base, fetchImpl: bad, log: (l) => log.push(l) })).toBeNull();
    expect(log[0]).toMatch(/buyer form FAILED: Meta found 1 problem/);
  });

  it('the price is text on both screens (a number field reaches the next screen as text and breaks the form)', () => {
    for (const json of [buyFlowJson('aGVsbG8='), sellFlowJson('aGVsbG8=')] as any[]) {
      const price = json.screens[0].layout.children[1].children.find((c: any) => c.name === 'price');
      expect(price['input-type']).toBe('text');
      expect(json.screens[1].data.price.type).toBe('string');
    }
    expect(readBuyForm({ item: 'Shoes', price: '15k' }).price).toBe('15k');
  });

  it('publishes a draft form when the server is set to published', async () => {
    const { f, calls } = fakeMeta({ flows: [{ id: 'flow-9', name: buyFlowName(), status: 'DRAFT' }], templates: [] });
    expect(await ensureBuyFlow({ ...base, formMode: 'published', fetchImpl: f })).toBe('flow-9');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/flow-9/publish'))).toBe(true);
  });

  it('reuses what already exists', async () => {
    const { f, calls } = fakeMeta({ flows: [{ id: 'flow-9', name: buyFlowName(), status: 'DRAFT' }], templates: [{ name: SELLER_ALERT.name, status: 'APPROVED' }] });
    expect(await ensureBuyFlow({ ...base, fetchImpl: f })).toBe('flow-9');
    expect(await ensureSellerAlertTemplate({ ...base, fetchImpl: f })).toBe('APPROVED');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('sends the alert as a template with button payloads', async () => {
    let sent: any = null;
    const f = (async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ messages: [{ id: 'w' }] }); }) as unknown as typeof fetch;
    const m = new Messenger(h.db, { dryRun: false, token: 't', phoneNumberId: 'p', graphVersion: 'v26.0', fetchImpl: f });
    const status = await m.sendTemplate('+2348000000001', { name: 'hoolam_order_request', language: 'en', params: ['Ada', 'Line one\nline two', '₦15,000', 'HL-AAAAA'], buttonPayloads: ['sview:HL-AAAAA', 'snotme:HL-AAAAA'], preview: 'x' });
    expect(status).toBe('SENT');
    expect(sent.type).toBe('template');
    expect(sent.template.components[0].parameters[1].text).toBe('Line one line two'); // no new lines allowed
    expect(sent.template.components[2]).toEqual({ type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'snotme:HL-AAAAA' }] });
  });
});
