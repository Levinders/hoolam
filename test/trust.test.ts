import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { Trust, namesOverlap, shipText, shortBankName, slugify } from '../src/trust.js';
import { checkLimits } from '../src/whatsapp/client.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
// This harness uses pretend money, so count test deals (as you'd do on the test number).
beforeAll(async () => { h = await startHarness({ quiet: true, env: { TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: 'https://hoolam.test' } }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348070000${String(++seq).padStart(3, '0')}`;
const userId = async (p: string) => (await h.db.query('SELECT id FROM users WHERE phone=$1', [p])).rows[0].id;
const codeIn = (t: string) => t.match(/HL-[A-Z2-9]{5}/)![0];
const lastBody = async (p: string) => (await h.db.query('SELECT body FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [p])).rows[0]?.body;

async function newSeller(name = 'Bayo Shoes') {
  const seller = phone();
  await h.say(seller, 'hi', name);
  await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
  return seller;
}
/** One full deal from seller to a given buyer, ending with the buyer happy (and optionally rating). */
async function completeDeal(seller: string, buyer: string, opts: { rate?: 'up' | 'down'; shipHours?: number } = {}) {
  await h.sell(seller);
  await h.say(seller, 'Sneakers'); await h.say(seller, '10000');
  await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone'); await h.tap(seller, 'sell:confirm');
  const code = codeIn(h.last(seller));
  await h.say(buyer, `Pay ${code}`, 'Ada Obi');
  await h.tap(buyer, `pay:${code}`);
  const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
  h.provider.pay(r.rows[0].provider_reference);
  await h.app.deals.handleCollection(r.rows[0].provider_reference);
  await h.tap(seller, `shipped:${code}`);
  await h.tap(seller, `noproof:${code}`);
  if (opts.shipHours != null) await h.db.query(`UPDATE deals SET funded_at = shipped_at - make_interval(hours => $2) WHERE code=$1`, [code, opts.shipHours]);
  await h.tap(buyer, `happy:${code}`);
  if (opts.rate) await h.tap(buyer, `rate${opts.rate}:${code}`);
  return code;
}

describe('the numbers', () => {
  it('counts completed deals, different buyers, shipping time and ratings', async () => {
    const seller = await newSeller();
    const [b1, b2, b3] = [phone(), phone(), phone()];
    await completeDeal(seller, b1, { rate: 'up', shipHours: 20 });
    await completeDeal(seller, b1, { rate: 'up', shipHours: 22 });
    await completeDeal(seller, b2, { rate: 'up', shipHours: 24 });
    await completeDeal(seller, b3, { rate: 'down', shipHours: 30 });
    const t = (await h.app.trust.seller(await userId(seller)))!;
    expect(t).toMatchObject({ name: 'Bayo', completed: 4, buyers: 3, happy: 3, rated: 4, problems: 0, isNew: false });
    expect(t.shipHours).toBe(23);
    const card = msg.trustCardText(t);
    expect(card).toMatch(/✅ 4 orders completed/);
    expect(card).toMatch(/👥 3 different buyers/);
    expect(card).toMatch(/📦 Ships in about 1 day/);
    expect(card).toMatch(/⚖️ No problems reported/);
    expect(card).toMatch(/👍 3 of 4 buyers happy/);
    expect(card).toMatch(/Paid out to Test A\., bank-verified/);
    expect(msg.trustLine(t)).toBe('🛡️ Bayo · ✅ 4 orders');
  });

  it('a refund after review shows on the card; a new seller shows "New on Hoolam"', async () => {
    const seller = await newSeller('Kemi Wigs'); const buyer = phone();
    await h.sell(seller); await h.say(seller, 'Wig'); await h.say(seller, '20000');
    await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone'); await h.tap(seller, 'sell:confirm');
    const code = codeIn(h.last(seller));
    await h.say(buyer, `Pay ${code}`); await h.tap(buyer, `pay:${code}`);
    const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
    h.provider.pay(r.rows[0].provider_reference); await h.app.deals.handleCollection(r.rows[0].provider_reference);
    await h.tap(buyer, `problem:${code}`); await h.say(buyer, 'Wrong colour'); await h.say(buyer, '8012345678 Opay'); await h.tap(buyer, 'bank:yes');
    await h.app.deals.adminRefund(code, 'Wrong item');
    const t = (await h.app.trust.seller(await userId(seller)))!;
    expect(t).toMatchObject({ problems: 1, refunded: 1, completed: 0, isNew: true });
    expect(msg.trustCardText(t)).toMatch(/🌱 New on Hoolam: no completed orders yet/);
    expect(msg.trustCardText(t)).toMatch(/⚖️ 1 problem reported · 1 refunded after review/);
    expect(msg.trustLine(t)).toBe('🛡️ Kemi · 🌱 New on Hoolam · ⚖️ 1 refunded');
    const b = (await h.app.trust.buyer(await userId(buyer)))!;
    expect(msg.buyerLine(b)).toMatch(/⚖️ 1 problem reported \(1 refunded\)/);
  });

  it('pretend-money deals and deals with yourself never count', async () => {
    const seller = await newSeller();
    await completeDeal(seller, phone());
    const strict = new Trust(h.db, false); // production setting
    expect((await strict.seller(await userId(seller)))!.completed).toBe(0);
    await h.db.query('UPDATE deals SET buyer_id=seller_id WHERE seller_id=$1', [await userId(seller)]);
    expect((await h.app.trust.seller(await userId(seller)))!.completed).toBe(0);
  });
});

describe('where buyers see it', () => {
  it('a one-line record above Pay now, and the full card one tap away', async () => {
    const seller = await newSeller();
    await completeDeal(seller, phone()); await completeDeal(seller, phone()); await completeDeal(seller, phone());
    await h.sell(seller); await h.say(seller, 'Bag'); await h.say(seller, '9000');
    await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone'); await h.tap(seller, 'sell:confirm');
    const code = codeIn(h.last(seller));
    const buyer = phone();
    await h.say(buyer, `Pay ${code}`, 'Tolu');
    expect(h.last(buyer)).toMatch(/🛡️ Bayo · ✅ 3 orders/);
    expect(h.last(buyer)).toMatch(/\[💳 Pay now\] \[🛡️ Seller's record\] \[Not now\]/);
    expect(h.last(seller)).toMatch(/👤 Tolu · 🌱 new buyer on Hoolam/); // sellers see the buyer too
    await h.tap(buyer, `record:${code}`);
    expect(h.last(buyer)).toMatch(/✅ 3 orders completed/);
    expect(h.last(buyer)).toMatch(/\[💳 Pay now\] \[Main menu\]/);
  });

  it('"Check a seller" by number or deal code; unknown numbers get a kind answer', async () => {
    const seller = await newSeller();
    const code = await completeDeal(seller, phone());
    const buyer = phone();
    await h.say(buyer, 'hi');
    await h.tap(buyer, 'menu:check');
    expect(h.last(buyer)).toMatch(/Send the seller's WhatsApp number/);
    await h.say(buyer, seller.replace('+234', '0'));
    expect(h.last(buyer)).toMatch(/🛡️ \*Bayo\*/);
    expect(h.last(buyer)).toMatch(/\[🛒 Buy from them\]/);
    await h.say(buyer, '/check'); await h.say(buyer, code);
    expect(h.last(buyer)).toMatch(/🛡️ \*Bayo\*/);
    await h.say(buyer, '/check'); await h.say(buyer, '08099999999');
    expect(h.last(buyer)).toMatch(/No Hoolam record for that number yet/);
  });

  it('"Buy from them" starts a deal already pointed at that seller (no seller question)', async () => {
    const seller = await newSeller();
    await completeDeal(seller, phone());
    const sid = await userId(seller);
    const buyer = phone();
    await h.say(buyer, 'hi', 'Ada');
    await h.tap(buyer, `buyfrom:${sid}`);
    expect(h.last(buyer)).toMatch(/You're buying from \*Bayo\*/);
    await h.say(buyer, 'Loafers'); await h.say(buyer, 'Brown, size 41'); await h.tap(buyer, 'cat:shoes');
    await h.say(buyer, '12000'); await h.tap(buyer, 'dlv:pickup'); await h.tap(buyer, 'buy:nophotos');
    expect(h.last(buyer)).toMatch(/Check your order/);
    expect(h.last(buyer)).toMatch(/We'll alert \+234 807/);
    await h.tap(buyer, 'buy:send');
    expect((await lastBody(seller)).text).toMatch(/\[template hoolam_new_order_request\]/);
  });
});

describe('ratings', () => {
  it('one tap, once, only by the buyer; a 👎 comment stays private', async () => {
    const seller = await newSeller(); const buyer = phone();
    const code = await completeDeal(seller, buyer);
    expect(h.last(buyer)).toMatch(/How was Bayo\?/);
    expect(h.last(buyer)).toMatch(/\[👍 Great\] \[👎 Not great\]/);
    await h.tap(seller, `rateup:${code}`); // the seller can't rate themselves
    expect((await h.app.trust.seller(await userId(seller)))!.rated).toBe(0);
    await h.tap(buyer, `ratedown:${code}`);
    expect(h.last(buyer)).toMatch(/What went wrong\? \(Optional\. Only our team sees this\.\)/);
    await h.say(buyer, 'Came late');
    expect(h.last(buyer)).toMatch(/reads every one/);
    await h.tap(buyer, `rateup:${code}`);
    expect(h.last(buyer)).toMatch(/already rated/);
    const t = (await h.app.trust.seller(await userId(seller)))!;
    expect(t).toMatchObject({ happy: 0, rated: 1 });
    expect(msg.trustCardText(t)).not.toMatch(/Came late/);
    const att = await h.app.app.inject({ method: 'GET', url: '/admin/attention', headers: { authorization: 'Bearer test-admin-token-123456' } });
    expect(att.json().unhappyBuyers.some((u: { comment: string }) => u.comment === 'Came late')).toBe(true);
  });
});

describe('the seller\'s own card and public page', () => {
  it('name & city, share (live page + forwardable text), Buy from @page, hide', async () => {
    const seller = await newSeller('Bayo');
    await completeDeal(seller, phone(), { rate: 'up' });
    await h.tap(seller, 'menu:card');
    expect(h.last(seller)).toMatch(/This is what buyers see before they pay/);
    expect(h.last(seller)).toMatch(/\[🔗 Share my card\] \[✏️ Edit my page\]/);
    await h.tap(seller, 'card:edit');
    expect(h.last(seller)).toMatch(/Edit my page/);
    await h.tap(seller, 'card:name');
    expect(h.last(seller)).toMatch(/What name should buyers see/);
    await h.say(seller, 'Bayo Kicks Lagos');
    await h.say(seller, 'Lagos');
    expect(h.last(seller)).toMatch(/🛡️ \*Bayo Kicks Lagos\* · Lagos/);

    await h.tap(seller, 'card:share');
    const shared = h.transcript.filter((t) => t.phone === seller).slice(-2).map((t) => t.text);
    expect(shared[0]).toMatch(/Your page is live:\nhttps:\/\/hoolam\.test\/s\/bayo-kicks-lagos/);
    expect(shared[1]).toMatch(/Buy from Bayo Kicks Lagos safely with Hoolam/);

    const page = await h.app.app.inject({ method: 'GET', url: '/s/bayo-kicks-lagos' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/Bayo Kicks Lagos/);
    expect(page.body).toMatch(/order completed/);
    expect(page.body).toMatch(/text=Buy%20from%20%40bayo-kicks-lagos/);
    expect(page.body).toMatch(/og:image" content="https:\/\/hoolam\.test\/s\/bayo-kicks-lagos\/share\.jpg/);
    expect((await h.app.app.inject({ method: 'GET', url: '/share.png' })).headers['content-type']).toBe('image/png');

    const buyer = phone();
    await h.say(buyer, 'Buy from @bayo-kicks-lagos', 'Femi'); // what the page's button types
    expect(h.last(buyer)).toMatch(/You're buying from \*Bayo Kicks Lagos\*/);

    await h.tap(seller, 'card:hide');
    expect(h.last(seller)).toMatch(/Your page is hidden/);
    expect((await h.app.app.inject({ method: 'GET', url: '/s/bayo-kicks-lagos' })).statusCode).toBe(404);
  });

  it('two sellers with the same name get different page addresses', async () => {
    const a = await newSeller('Same Name'); const b = await newSeller('Same Name');
    await h.tap(a, 'card:share'); await h.tap(b, 'card:share');
    const slugs = (await h.db.query('SELECT profile_slug FROM users WHERE phone = ANY($1) ORDER BY profile_slug', [[a, b]])).rows.map((r) => r.profile_slug);
    expect(slugs).toEqual(['same-name', 'same-name-2']);
  });
});

describe('helpers and limits', () => {
  it('names, slugs, shipping text', () => {
    expect(slugify('Bayo’s Kicks & Co.')).toBe('bayo-s-kicks-co');
    expect(slugify('Ọlá Fabrics')).toBe('ola-fabrics');
    expect(namesOverlap('ADEYEMI BABATUNDE OLUWASEUN', ['Tunde Adeyemi'])).toBe(true);
    expect(namesOverlap('ADEYEMI BABATUNDE', ['Bayo Shoes'])).toBe(false);
    expect(shortBankName('ADEYEMI BABATUNDE OLUWASEUN')).toBe('Adeyemi B.');
    expect(shipText(0.5)).toBe('within an hour');
    expect(shipText(5)).toBe('in about 5 hours');
    expect(shipText(23)).toBe('in about 1 day');
    expect(shipText(72)).toBe('in about 3 days');
  });

  it('every new message fits WhatsApp limits', () => {
    const money = { minor: 100, currency: 'NGN' as const };
    for (const m of [
      msg.menu('Ada'), msg.myTrustCard('card', null), msg.myTrustCard('card', 'https://x/s/y'), msg.sellerRecord('card', 'HL-AAAAA', null),
      msg.sellerRecord('card', null, 'id'), msg.noSellerRecord(), msg.askBusinessName('Bayo'), msg.askCity(), msg.buyerReleased('HL-AAAAA', 'Bayo'),
      msg.askRatingComment('HL-AAAAA'), msg.dealForBuyer('HL-AAAAA', 'x', 'Bayo', money, money, money, 'line'), msg.help(),
    ]) expect(() => checkLimits(m)).not.toThrow();
  });
});
