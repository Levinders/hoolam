import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { BUYER_ALERT, ensureTemplate } from '../src/whatsapp/automation.js';
import { sellFlowJson, sellFlowName } from '../src/whatsapp/buy-flow.js';
import { checkLimits } from '../src/whatsapp/client.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348060000${String(++seq).padStart(3, '0')}`;
let n = 0;
const photo = (p: string, caption = '') => h.app.chat.handle({ id: `simg${++n}`, phone: p, name: null, type: 'image', text: caption, buttonId: null, mediaId: `smedia-${n}`, mimeType: 'image/jpeg' });
const deal = async (code: string) => (await h.db.query('SELECT * FROM deals WHERE code=$1', [code])).rows[0];
const outs = async (p: string, kind: string) => (await h.db.query('SELECT body FROM outbound_messages WHERE phone=$1 AND kind=$2 ORDER BY id', [p, kind])).rows;
const codeIn = (t: string) => t.match(/HL-[A-Z2-9]{5}/)![0];

/** Seller goes through the chat (the mirror of Buy something). Returns the order code. */
async function sellByChat(seller: string, opts: { buyerPhone?: string; photos?: number; price?: string; address?: string | null } = {}) {
  await h.say(seller, 'hi', 'Bayo Shoes');
  await h.sell(seller);
  await h.say(seller, 'Black sneakers, size 42');
  await h.say(seller, 'Brand new, in the box'); await h.tap(seller, 'cat:shoes');
  await h.say(seller, opts.price ?? '15000');
  if (opts.address === null) await h.tap(seller, 'sell:noaddress'); else await h.say(seller, opts.address ?? '12 Woji Road, Port Harcourt');
  await h.tap(seller, 'bdate:1');
  for (let i = 0; i < (opts.photos ?? 0); i++) await photo(seller);
  await h.tap(seller, opts.photos ? 'sell:photosdone' : 'sell:nophotos');
  await h.say(seller, opts.buyerPhone ?? phone());
  if (/account number/.test(h.last(seller))) { await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes'); }
  if (!/Check your order/.test(h.last(seller))) throw new Error(`expected the summary, got: ${h.last(seller)}`);
  await h.tap(seller, 'sell:send');
  return codeIn(h.last(seller));
}

/** Buyer starts a deal (the seller's number is required). Returns the code. */
async function buyByChat(buyer: string, price = '15000') {
  await h.say(buyer, 'hi', 'Ada Obi');
  await h.tap(buyer, 'menu:buy');
  await h.say(buyer, 'Red dress');
  await h.say(buyer, 'Brand new, in the box'); await h.tap(buyer, 'cat:other');
  await h.say(buyer, price); await h.say(buyer, '12 Woji Road, Port Harcourt'); await h.tap(buyer, 'bdate:3');
  await h.tap(buyer, 'buy:nophotos');
  await h.say(buyer, phone());
  await h.tap(buyer, 'buy:send');
  return codeIn(h.last(buyer));
}

describe('Sell something: the mirror of Buy something', () => {
  it('the seller answers the same questions; the summary shows their own money and the buyer\'s number', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi', 'Bayo');
    await h.sell(seller);
    expect(h.last(seller)).toMatch(/What are you selling\?/);
    await h.say(seller, 'Sneakers');
    expect(h.last(seller)).toMatch(/Describe it/);
    await h.say(seller, 'White, size 43'); await h.tap(seller, 'cat:shoes');
    expect(h.last(seller)).toMatch(/\*total price\*/);
    await h.say(seller, '15000');
    expect(h.last(seller)).toMatch(/buyer's delivery address\*, if you know it[\s\S]*\[Buyer will add it\]/);
    await h.say(seller, '12 Woji Road, Port Harcourt');
    expect(h.last(seller)).toMatch(/\*ready to send\*[\s\S]*\[Today\] \[Tomorrow\] \[In 3 days\]/);
    await h.tap(seller, 'bdate:0');
    expect(h.last(seller)).toMatch(/\*photos\*/);
    await photo(seller);
    await h.tap(seller, 'sell:photosdone');
    expect(h.last(seller)).toMatch(/\*buyer's WhatsApp number\*/);
    await h.say(seller, seller.replace('+234', '0'));
    expect(h.last(seller)).toMatch(/That's your own number/);
    await h.say(seller, '09000000000'.replace(/^0/, '+234').replace('+2349000000000', '2349000000000'));
    expect(h.last(seller)).toMatch(/That's Hoolam's number/);
    await h.say(seller, buyer.replace('+234', '0'));
    expect(h.last(seller)).toMatch(/account number/); // first time: where to pay them
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    const t = h.last(seller);
    expect(t).toMatch(/Check your order/);
    expect(t).toMatch(/📷 1 photo/);
    expect(t).toMatch(/📍 Deliver to: \*12 Woji Road, Port Harcourt\*/);
    expect(t).toMatch(/📅 Ready by \*/);
    expect(t).toMatch(new RegExp(`Buyer's WhatsApp: \\*${buyer.replace('+234', '0')}\\*`));
    expect(t).toMatch(/Total price  ₦15,000\nHoolam fee  −₦400\n\*You receive  ₦14,600\*/);
    expect(t).not.toMatch(/Transaction fee|₦15,500/); // the buyer's transaction fee is theirs to see
    expect(t).toMatch(/\[📨 Send to buyer\] \[✏️ Edit order\] \[🔄 Start again\]/);
    await h.tap(seller, 'sell:send');
    expect(h.last(seller)).toMatch(new RegExp(`✅ \\*${buyer.replace('+234', '0')}\\* · Order \\*HL-[A-Z2-9]{5}\\* is sent`));
    expect(h.last(seller)).toMatch(/They have \*48 hours\* to accept/);
    const d = await deal(codeIn(h.last(seller)));
    expect(d).toMatchObject({ status: 'AWAITING_BUYER', started_by: 'SELLER', fee_payer: 'SELLER', txn_fee_payer: 'BUYER', buyer_id: null, legacy_ship: false, category: 'shoes', delivery_address: '12 Woji Road, Port Harcourt' });
    expect(d.accept_by).not.toBeNull();
    expect(d.view_token).toBeTruthy();
    expect([d.buyer_pays_minor, d.seller_gets_minor, d.fee_minor, d.txn_fee_minor].map(Number)).toEqual([1_550_000, 1_460_000, 40_000, 50_000]);
  });

  it('the buyer is alerted, sees the order, accepts with the address, and gets the payment details; the seller is told', async () => {
    const seller = phone(), buyer = phone();
    await h.say(buyer, 'hi', 'Ada');
    const code = await sellByChat(seller, { buyerPhone: buyer.replace('+234', '0'), photos: 2 });
    expect(h.last(seller)).toMatch(/We've sent the buyer your order/);
    const alerts = await outs(buyer, 'template');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body.text).toMatch(/New order for you\* on \*Hoolam\*[\s\S]*Seller: \*Bayo[^*]*\*[\s\S]*Item: \*Black sneakers, size 42\*[\s\S]*Total price: \*₦15,000\*[\s\S]*You pay: \*₦15,500\*/);
    expect(alerts[0].body.buttons.map((b: { id: string }) => b.id)).toEqual([`bview:${code}`, `bnotme:${code}`]);

    await h.tap(buyer, `bview:${code}`);
    expect(await outs(buyer, 'image')).toHaveLength(2);
    const card = h.last(buyer);
    expect(card).toMatch(/🛍️ \*Bayo[^*]*\* · New order for you/);
    expect(card).toMatch(/📍 Deliver to: \*12 Woji Road, Port Harcourt\*\n📅 Ready by \*/);
    expect(card).toMatch(/Total price  ₦15,000\nTransaction fee  ₦500\n\*You pay  ₦15,500\*/);
    expect(card).not.toMatch(/Hoolam fee/); // the seller started it, so Hoolam's fee is the seller's
    expect(card).toMatch(/Accept within \*48 hours\*/);
    expect(card).toMatch(/\[✅ Accept order\] \[✕ Decline\] \[🛡️ Seller's record\]/);
    expect((await deal(code))).toMatchObject({ status: 'AWAITING_BUYER', buyer_id: null }); // looking changes nothing

    await h.tap(buyer, `baccept:${code}`);
    expect(h.last(buyer)).toMatch(/Deliver to:\n\*12 Woji Road, Port Harcourt\*[\s\S]*\[Yes, deliver here\]/);
    await h.tap(buyer, `baddr:${code}`);
    expect(h.last(buyer)).toMatch(new RegExp(`✅ \\*Bayo[^*]*\\* · Order \\*${code}\\* accepted\\. Here's how to pay:\\n\\n💳 Transfer exactly \\*₦15,500\\*`));
    expect(h.last(seller)).toMatch(new RegExp(`✅ \\*Ada\\* · Order \\*${code}\\* accepted\\.\\n👤 \\*Ada\\* · 🌱 new buyer on Hoolam\\n\\nTotal price  ₦15,000\\nHoolam fee  −₦400\\n\\*You receive  ₦14,600\\*`));
    expect(h.last(seller)).toMatch(/\*Don't ship before we confirm the money is held\.\*/);
    expect(await deal(code)).toMatchObject({ status: 'AWAITING_PAYMENT' });
    expect((await deal(code)).buyer_id).toBeTruthy();
  });

  it('no address from the seller: the buyer adds it; a buyer can also change the seller\'s', async () => {
    const seller = phone(), buyer = phone();
    const code = await sellByChat(seller, { buyerPhone: buyer, address: null });
    await h.tap(buyer, `bview:${code}`);
    expect(h.last(buyer)).toMatch(/You add the delivery address when you accept/);
    await h.tap(buyer, `baccept:${code}`);
    expect(h.last(buyer)).toMatch(/Where should it be delivered\?/);
    await h.say(buyer, 'abc');
    expect(h.last(buyer)).toMatch(/Where should it be delivered\?/);
    await h.say(buyer, '5 Aba Road, Port Harcourt');
    expect(h.last(buyer)).toMatch(/Transfer exactly/);
    expect((await deal(code)).delivery_address).toBe('5 Aba Road, Port Harcourt');

    const b2 = phone();
    const code2 = await sellByChat(seller, { buyerPhone: b2 });
    await h.acceptOrder(b2, code2, '7 Olu Street, Ikeja');
    expect((await deal(code2)).delivery_address).toBe('7 Olu Street, Ikeja');
  });

  it('decline, wrong number, the seller cancels, and no answer in time', async () => {
    const seller = phone(), buyer = phone();
    await h.say(buyer, 'hi', 'Ada');
    const a = await sellByChat(seller, { buyerPhone: buyer });
    await h.tap(buyer, `bdecline:${a}`);
    expect(h.last(buyer)).toMatch(/\[Not interested\] \[🚫 Wrong number\]/);
    await h.tap(buyer, `bno:${a}`);
    expect((await deal(a)).status).toBe('CANCELLED');
    expect(h.last(buyer)).toMatch(/\*Bayo[^*]*\* · Order \*HL-\w+\* is declined/);
    expect(h.last(seller)).toMatch(/😕 \*Ada\* · Order \*HL-\w+\* declined\. No money moved\./);

    const b = await sellByChat(seller, { buyerPhone: phone() });
    await h.tap(seller, `scancel:${b}`);
    expect((await deal(b)).status).toBe('CANCELLED');
    expect(h.last(seller)).toMatch(/is cancelled\. No money moved/);

    const c = await sellByChat(seller, { buyerPhone: phone() });
    await h.db.query(`UPDATE deals SET accept_by = now() - interval '1 minute' WHERE code=$1`, [c]);
    await h.app.deals.sweep({ nudgeAfterHours: 9999 });
    expect((await deal(c)).status).toBe('EXPIRED');
    expect(h.last(seller)).toMatch(/⏳ \*0\d+\* · Order \*HL-\w+\*: the buyer didn't accept in time/); // the buyer's number when they have no name yet
  });

  it('"Not me" from the buyer: closed, the seller is told; that seller can\'t alert them again, others can', async () => {
    const seller = phone(), stranger = phone(), other = phone();
    const code = await sellByChat(seller, { buyerPhone: stranger });
    await h.tap(stranger, `bnotme:${code}`);
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(seller)).toMatch(/says it isn't your buyer/);
    await sellByChat(seller, { buyerPhone: stranger });
    expect(await outs(stranger, 'template')).toHaveLength(1);
    expect(h.last(seller)).toMatch(/said it isn't your buyer last time/);
    await sellByChat(other, { buyerPhone: stranger });
    expect(await outs(stranger, 'template')).toHaveLength(2);
  });

  it('once paid, the seller dispatches like any order (handover code), and is paid minus their fee', async () => {
    const seller = phone(), buyer = phone();
    await h.say(buyer, 'hi', 'Ada');
    const code = await sellByChat(seller, { buyerPhone: buyer });
    await h.acceptOrder(buyer, code);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
    h.provider.pay(r.rows[0].provider_reference);
    await h.app.deals.handleCollection(r.rows[0].provider_reference);
    expect(h.last(seller)).toMatch(/💰 \*Ada\* has paid[\s\S]*Dispatch it now[\s\S]*\[🚚 Dispatch now\] \[❌ Can't fulfil\]/);
    await h.handOver(seller, code);
    expect(h.last(buyer)).toMatch(/it's with you/);
    await h.tap(buyer, `happy:${code}`);
    const p = await h.db.query(`SELECT kind, amount_minor FROM payouts WHERE deal_id=(SELECT id FROM deals WHERE code=$1)`, [code]);
    expect(p.rows.map((x) => [x.kind, Number(x.amount_minor)])).toEqual([['SELLER', 1_460_000]]);
  });

  it('the seller form: answers go to the summary', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi', 'Bayo');
    await h.app.chat.handle({ id: `f${++n}`, phone: seller, name: 'Bayo', type: 'form', text: '', buttonId: null, mediaId: null,
      form: { flow_token: 'sell:v2', item: 'Wig', description: 'Bone straight, 20 inches', category: 'beauty', price: '20000', address: '', arrive_by: '2099-12-31', other_phone: buyer.replace('+234', '0'), photos: [{ id: 'p1', mime_type: 'image/jpeg' }] } });
    expect(h.last(seller)).toMatch(/account number/);
    await h.say(seller, '0123456789 Kuda'); await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/Check your order/);
    expect(h.last(seller)).toMatch(/📷 1 photo/);
    expect(h.last(seller)).toMatch(/📍 The buyer adds the delivery address/);
    expect(h.last(seller)).toMatch(/You receive  ₦19,500/);
    await h.tap(seller, 'sell:edit');
    expect(h.last(seller)).toMatch(/What do you want to change\?[\s\S]*Ready by[\s\S]*Buyer's WhatsApp/);
    await h.tap(seller, 'bfix:price');
    await h.say(seller, '22000');
    expect(h.last(seller)).toMatch(/Total price  ₦22,000/);
  });
});

describe('Change price', () => {
  it('seller suggests a new price (adding a bank first), buyer accepts, deal goes on at the new price', async () => {
    const buyer = phone(), seller = phone();
    const code = await buyByChat(buyer);
    await h.say(seller, `View ${code}`, 'Chidi');
    await h.tap(seller, `scounter:${code}`);
    expect(h.last(seller)).toMatch(/What price works for you/);
    expect(h.last(seller)).toMatch(/offered \*₦15,000\*/);
    await h.say(seller, '17k');
    expect(h.last(seller)).toMatch(/Why \*₦17,000\*\?/);
    await h.say(seller, 'ok');
    expect(h.last(seller)).toMatch(/3 to 150 characters/);
    await h.say(seller, 'The price went up at the market');
    expect(h.last(seller)).toMatch(/where should we pay you/);
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/We've asked \*Ada\* if \*₦17,000\* works/);
    expect(h.last(seller)).toMatch(/If they accept:\nTotal price  ₦17,000\nTransaction fee  −₦500\n\*You receive  ₦16,500\*/);
    expect(h.last(buyer)).toMatch(/\*Chidi\* updated the price/);
    expect(h.last(buyer)).toMatch(/💬 Reason: The price went up at the market/);
    expect(h.last(buyer)).toMatch(/~₦15,000~ → \*₦17,000\*/);
    expect(h.last(buyer)).toMatch(/Total price  ₦17,000\nHoolam fee  ₦400\n\*You'd pay  ₦17,400\*/); // the full breakdown

    await h.tap(buyer, `cyes:${code}`);
    const d = await deal(code);
    expect(d).toMatchObject({ status: 'AWAITING_PAYMENT', price_minor: 1_700_000, buyer_pays_minor: 1_740_000, seller_gets_minor: 1_650_000, counter_price_minor: null }); // seller: ₦17,000 − ₦500 transaction fee
    expect(h.last(seller)).toMatch(/\*Ada\* accepted your new price for order \*HL-[A-Z2-9]{5}\*\.\n\nTotal price  ₦17,000\nTransaction fee  −₦500\n\*You receive  ₦16,500\*/); // the full breakdown, not just the total
    expect(h.last(seller)).toMatch(/\*Don't ship before we confirm the money is held\.\*/);
    expect(h.last(buyer)).toMatch(/\[💳 Pay now\]/);
  });

  it('while a new price is pending, nobody else can take the deal', async () => {
    const buyer = phone(), s1 = phone(), s2 = phone();
    const code = await buyByChat(buyer);
    await h.say(s1, 'hi'); await h.tap(s1, 'menu:account'); await h.say(s1, '0123456789 Opay'); await h.tap(s1, 'bank:yes');
    await h.say(s1, `View ${code}`); await h.tap(s1, `scounter:${code}`); await h.say(s1, '16000'); await h.say(s1, 'Delivery costs more');
    await h.say(s2, `View ${code}`);
    expect(h.last(s2)).toMatch(/already has a seller/);
    await h.say(s1, `View ${code}`);
    expect(h.last(s1)).toMatch(/⏳ \*Ada\* · Order \*HL-\w+\*: we're waiting for \*Ada\* to answer your price/);
  });

  it('the buyer can cancel instead; the seller who suggested the price is told', async () => {
    const buyer = phone(), seller = phone();
    const code = await buyByChat(buyer);
    await h.say(seller, 'hi'); await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 Opay'); await h.tap(seller, 'bank:yes');
    await h.say(seller, `View ${code}`); await h.tap(seller, `scounter:${code}`); await h.say(seller, '16000'); await h.say(seller, 'Delivery costs more');
    await h.tap(buyer, `cancel:${code}`);
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(seller)).toMatch(/cancelled order/);
  });
});

describe('proof of shipping', () => {
  // orders a seller created before Sell something was rebuilt keep the old route ("I've sent it") until they finish
  async function fundedDeal() {
    const seller = phone(), buyer = phone();
    const code = await sellByChat(seller);
    await h.db.query('UPDATE deals SET legacy_ship=true WHERE code=$1', [code]);
    await h.say(buyer, `Pay ${code}`, 'Ada');
    await h.tap(buyer, `pay:${code}`);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
    h.provider.pay(r.rows[0].provider_reference);
    await h.app.deals.handleCollection(r.rows[0].provider_reference);
    await h.tap(seller, `shipped:${code}`);
    return { seller, buyer, code };
  }

  it('after "I\'ve sent it", the seller can add a photo; the buyer sees it and it\'s kept', async () => {
    const { seller, buyer, code } = await fundedDeal();
    expect(h.last(seller)).toMatch(/Want to add proof/);
    expect(h.last(buyer)).toMatch(/on the way/);
    await photo(seller, 'GIG waybill');
    const img = (await outs(buyer, 'image')).pop();
    expect(img.body.caption).toMatch(/Proof of shipping/);
    expect(h.last(buyer)).toMatch(/From the seller, about order .*GIG waybill/s);
    expect(h.last(seller)).toMatch(/Proof saved/);
    const d = await deal(code);
    expect(d.shipping_note).toBe('GIG waybill');
    const kept = await h.db.query(`SELECT kind FROM deal_photos WHERE deal_id=$1`, [d.id]);
    expect(kept.rows.map((r) => r.kind)).toEqual(['SHIPPING']);
  });

  it('a tracking note works too, and "No thanks" skips it', async () => {
    const a = await fundedDeal();
    await h.say(a.seller, 'Tracking: GIGL 12345');
    expect(h.last(a.buyer)).toMatch(/Tracking: GIGL 12345/);
    const b = await fundedDeal();
    await h.tap(b.seller, `noproof:${b.code}`);
    expect(h.last(b.seller)).toMatch(/on the way, money held/);
    expect((await deal(b.code)).shipping_note).toBeNull();
  });
});

describe('pieces', () => {
  it('the seller form mirrors the buyer\'s: the address is optional, ready by and the buyer\'s number are required', () => {
    const json = sellFlowJson('aGVsbG8=') as any;
    expect(json.screens.map((x: any) => x.id)).toEqual(['ITEM', 'DELIVERY', 'PHOTOS']);
    expect(json.screens[0].title).toBe('Sell safely');
    const delivery = json.screens[1].layout.children[0].children;
    const field = (name: string) => delivery.find((c: any) => c.name === name);
    expect(field('address').required).toBe(false);
    expect(field('arrive_by')).toMatchObject({ type: 'DatePicker', label: 'Ready by', required: true });
    expect(field('other_phone')).toMatchObject({ label: 'Buyer\'s WhatsApp', required: true });
    expect(json.screens[2].data.price.type).toBe('string');
    expect(sellFlowName(json)).toMatch(/^hoolam_sell_/);
  });

  it('new messages fit WhatsApp limits', () => {
    const money = { minor: 1_500_000, currency: 'NGN' as const };
    for (const m of [
      msg.sellSummary({ item: 'x', photos: 1, readyBy: 'Fri 9 Oct', buyerPhone: '+2348030000000', sum: { price: money, fee: money, feeLabel: 'Hoolam fee', gets: money } }),
      msg.buyerOrderCard({ code: 'HL-AAAAA', sellerName: 'Bayo', item: 'x', sum: { price: money, fee: money, feeLabel: 'Transaction fee', pay: money }, hoursLeft: 48 }),
      msg.sellDealReady('HL-AAAAA', 'Ada', 'https://x', 'sent', 48), msg.askSellAddress(), msg.askReadyBy(), msg.askBuyerDeclineReason('HL-AAAAA'),
      msg.askSellPhotos(), msg.askBuyerPhone(), msg.sellForm('1', 'draft'), msg.buyerCounterOffer('HL-AAAAA', 'Bayo', 'x', money, money, money),
      msg.askDeclineReason('HL-AAAAA'), msg.sellerShippedOk('HL-AAAAA'), msg.dealCreated('HL-AAAAA', 'https://x', 'sent'),
    ]) expect(() => checkLimits(m)).not.toThrow();
  });

  it('fees explain who pays', async () => {
    const p = phone();
    await h.say(p, 'hi'); await h.say(p, '/fees');
    expect(h.last(p)).toMatch(/Whoever starts the order pays Hoolam's fee/);
    expect(h.last(p)).toMatch(/\*Transaction fee\*\n₦500 up to ₦100,000\n₦1,000 up to ₦200,000/);
    expect(h.last(p)).toMatch(/₦2,500 above ₦400,000/);
  });

  it('the buyer alert template is transactional and well-formed', async () => {
    expect(BUYER_ALERT.body).not.toMatch(/^\{\{|\}\}$/);
    const posted: any[] = [];
    const f = (async (u: string, init: RequestInit = {}) => {
      if (/\/app$/.test(u)) return Response.json({ id: 'app1' });
      if (/\/app1\/uploads/.test(u)) return Response.json({ id: 'upload:1' });
      if (/\/upload:1$/.test(u)) return Response.json({ h: '4::sample' });
      if (init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return Response.json({ id: 't', status: 'PENDING', category: 'UTILITY' }); }
      return Response.json({ data: [] });
    }) as unknown as typeof fetch;
    expect(await ensureTemplate({ token: 't', phoneNumberId: 'p', graphVersion: 'v26.0', wabaId: 'w', fetchImpl: f }, BUYER_ALERT, 'buyer alert')).toBe('PENDING');
    expect(posted[0].name).toBe('hoolam_new_order_for_buyer_v2');
    expect(posted[0].components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::sample'] } }); // the item's first photo goes here
    expect(BUYER_ALERT.replaces).toBe('hoolam_new_order_for_buyer'); // used until Meta approves the new one
    expect(posted[0].category).toBe('UTILITY');
  });
});
