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

/** Seller goes through the chat. Returns the deal code. */
async function sellByChat(seller: string, opts: { buyerPhone?: string; photos?: number; price?: string } = {}) {
  await h.say(seller, 'hi', 'Bayo Shoes');
  await h.sell(seller);
  await h.say(seller, 'Black sneakers, size 42');
  await h.say(seller, opts.price ?? '15000');
  for (let i = 0; i < (opts.photos ?? 0); i++) await photo(seller);
  await h.tap(seller, opts.photos ? 'sell:photosdone' : 'sell:nophotos');
  if (opts.buyerPhone) await h.say(seller, opts.buyerPhone); else await h.tap(seller, 'sell:nophone');
  if (/account number and bank/.test(h.last(seller))) { await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes'); }
  await h.tap(seller, 'sell:confirm');
  return codeIn(h.last(seller));
}

/** Buyer starts a deal with no seller number. Returns the code. */
async function buyByChat(buyer: string, price = '15000') {
  await h.say(buyer, 'hi', 'Ada Obi');
  await h.tap(buyer, 'menu:buy');
  await h.say(buyer, 'Red dress');
  await h.say(buyer, 'Brand new, in the box'); await h.tap(buyer, 'cat:other');
  await h.say(buyer, price); await h.say(buyer, '12 Woji Road, Port Harcourt');
  await h.tap(buyer, 'buy:nophotos');
  await h.tap(buyer, 'buy:nophone');
  await h.tap(buyer, 'buy:send');
  return codeIn(h.last(buyer));
}

describe('seller creates a deal: whoever starts the deal pays the fee', () => {
  it('summary shows what the seller receives; the buyer pays just the price', async () => {
    const seller = phone();
    await h.say(seller, 'hi', 'Bayo');
    await h.sell(seller);
    await h.say(seller, 'Sneakers'); await h.say(seller, '15000');
    expect(h.last(seller)).toMatch(/Add photos of the item/);
    await photo(seller);
    await h.tap(seller, 'sell:photosdone');
    expect(h.last(seller)).toMatch(/buyer's WhatsApp number/);
    await h.tap(seller, 'sell:nophone');
    await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/Check your order/);
    expect(h.last(seller)).toMatch(/📷 1 photo/);
    expect(h.last(seller)).toMatch(/Hoolam fee   −₦400/);
    expect(h.last(seller)).toMatch(/You receive  ₦14,600/);
    expect(h.last(seller)).toMatch(/The buyer pays ₦15,000/);
    await h.tap(seller, 'sell:confirm');
    const d = await deal(codeIn(h.last(seller)));
    expect(d).toMatchObject({ fee_payer: 'SELLER', buyer_pays_minor: 1_500_000, seller_gets_minor: 1_460_000, fee_minor: 40_000 });
  });

  it('with the buyer\'s number: the buyer is alerted, sees photos, pays just the price', async () => {
    const seller = phone(), buyer = phone();
    const code = await sellByChat(seller, { buyerPhone: buyer.replace('+234', '0'), photos: 2 });
    expect(h.last(seller)).toMatch(/We've sent the buyer the order/);
    const alerts = await outs(buyer, 'template');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body.text).toMatch(/Bayo is selling you Black sneakers, size 42 for ₦15,000/);
    expect(alerts[0].body.buttons.map((b: { id: string }) => b.id)).toEqual([`bview:${code}`, `bnotme:${code}`]);

    await h.app.chat.handle({ id: `b${++n}`, phone: buyer, name: 'Ada', type: 'button', text: 'View deal', buttonId: `bview:${code}`, mediaId: null });
    expect(await outs(buyer, 'image')).toHaveLength(2);
    expect(h.last(buyer)).toMatch(/You pay: ₦15,000/);
    expect(h.last(buyer)).toMatch(/the seller pays it/);
    expect((await deal(code)).status).toBe('AWAITING_PAYMENT');
  });

  it('"Not me" from the buyer: closed, the seller is told, never alerted again', async () => {
    const seller = phone(), stranger = phone();
    const code = await sellByChat(seller, { buyerPhone: stranger });
    await h.tap(stranger, `bnotme:${code}`);
    expect((await deal(code)).status).toBe('CANCELLED');
    expect(h.last(seller)).toMatch(/says it isn't your buyer/);
    await sellByChat(seller, { buyerPhone: stranger });
    expect(await outs(stranger, 'template')).toHaveLength(1);
    expect(h.last(seller)).toMatch(/asked us not to message it/);
  });

  it('the seller form: answers go to the summary', async () => {
    const seller = phone();
    await h.say(seller, 'hi', 'Bayo');
    await h.app.chat.handle({ id: `f${++n}`, phone: seller, name: 'Bayo', type: 'form', text: '', buttonId: null, mediaId: null,
      form: { flow_token: 'sell:v1', item: 'Wig', price: 20000, other_phone: '', photos: [{ id: 'p1', mime_type: 'image/jpeg' }] } });
    expect(h.last(seller)).toMatch(/account number and bank/);
    await h.say(seller, '0123456789 Kuda'); await h.tap(seller, 'bank:yes');
    expect(h.last(seller)).toMatch(/Check your order/);
    expect(h.last(seller)).toMatch(/📷 1 photo/);
    expect(h.last(seller)).toMatch(/You receive  ₦19,500/);
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
    expect(h.last(seller)).toMatch(/We've asked Ada if ₦17,000 works/);
    expect(h.last(buyer)).toMatch(/Chidi wants a different price/);
    expect(h.last(buyer)).toMatch(/💬 Reason: The price went up at the market/);
    expect(h.last(buyer)).toMatch(/~₦15,000~ → \*₦17,000\*/);
    expect(h.last(buyer)).toMatch(/You'd pay \*₦17,400\*/);

    await h.tap(buyer, `cyes:${code}`);
    const d = await deal(code);
    expect(d).toMatchObject({ status: 'AWAITING_PAYMENT', price_minor: 1_700_000, buyer_pays_minor: 1_740_000, seller_gets_minor: 1_700_000, counter_price_minor: null });
    expect(h.last(seller)).toMatch(/accepted your price/);
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
    expect(h.last(s1)).toMatch(/waiting for the buyer to answer your price/);
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
  async function fundedDeal() {
    const seller = phone(), buyer = phone();
    const code = await sellByChat(seller);
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
  it('the seller form fits WhatsApp limits', () => {
    const json = sellFlowJson('aGVsbG8=') as any;
    expect(json.screens[0].title).toBe('Sell safely');
    const fields = json.screens[0].layout.children[1].children;
    for (const c of fields) if (c.type === 'TextInput') { expect(c.label.length).toBeLessThanOrEqual(20); expect((c['helper-text'] ?? '').length).toBeLessThanOrEqual(30); }
    expect(fields.some((c: any) => c.type === 'DatePicker')).toBe(false);
    expect(json.screens[1].data.price.type).toBe('string');
    expect(sellFlowName(json)).toMatch(/^hoolam_sell_/);
  });

  it('new messages fit WhatsApp limits', () => {
    const money = { minor: 1_500_000, currency: 'NGN' as const };
    for (const m of [
      msg.confirmDeal({ item: 'x', photos: 1, buyerPhone: '+2348030000000', price: money, fee: money, buyerPays: money, sellerGets: money }),
      msg.askSellPhotos(), msg.askBuyerPhone(), msg.sellForm('1', 'draft'), msg.buyerCounterOffer('HL-AAAAA', 'Bayo', 'x', money, money, money),
      msg.askDeclineReason('HL-AAAAA'), msg.sellerShippedOk('HL-AAAAA'), msg.dealCreated('HL-AAAAA', 'https://x', 'sent'),
    ]) expect(() => checkLimits(m)).not.toThrow();
  });

  it('fees explain who pays', async () => {
    const p = phone();
    await h.say(p, 'hi'); await h.say(p, '/fees');
    expect(h.last(p)).toMatch(/Whoever starts the order pays the fee/);
  });

  it('the buyer alert template is transactional and well-formed', async () => {
    expect(BUYER_ALERT.body).not.toMatch(/^\{\{|\}\}$/);
    const posted: any[] = [];
    const f = (async (_u: string, init: RequestInit = {}) => {
      if (init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return Response.json({ id: 't', status: 'PENDING', category: 'UTILITY' }); }
      return Response.json({ data: [] });
    }) as unknown as typeof fetch;
    expect(await ensureTemplate({ token: 't', phoneNumberId: 'p', graphVersion: 'v26.0', wabaId: 'w', formMode: 'draft', fetchImpl: f }, BUYER_ALERT, 'buyer alert')).toBe('PENDING');
    expect(posted[0].name).toBe('hoolam_order_payment_request');
    expect(posted[0].category).toBe('UTILITY');
  });
});
