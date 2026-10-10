import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { checkLimits } from '../src/whatsapp/client.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348060000${String(++seq).padStart(3, '0')}`;

const deal = async (code: string) => (await h.db.query('SELECT * FROM deals WHERE code=$1', [code])).rows[0];
const ledger = async (code: string) => {
  const r = await h.db.query(`SELECT account, SUM(amount_minor)::bigint AS b FROM ledger_entries WHERE deal_id=(SELECT id FROM deals WHERE code=$1) GROUP BY account`, [code]);
  return Object.fromEntries(r.rows.map((x) => [x.account, Number(x.b)]));
};
const payouts = async (code: string) =>
  (await h.db.query(`SELECT kind, amount_minor, status FROM payouts WHERE deal_id=(SELECT id FROM deals WHERE code=$1) ORDER BY created_at`, [code])).rows;

/** A buyer orders ₦20,000 (delivery included) from a seller, the seller accepts, the buyer pays ₦20,500. */
async function paidBuyerOrder(opts: { arriveBy?: string } = {}): Promise<{ buyer: string; seller: string; code: string }> {
  const buyer = phone(), seller = phone();
  await h.say(seller, 'hi', 'Bayo Shoes');
  await h.say(buyer, 'hi', 'Ada Obi');
  await h.app.chat.handle({
    id: `f${seq}`, phone: buyer, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null,
    form: { flow_token: 'buy:v1', item: 'Leather bag', description: 'Brown, medium', category: 'bags', price: '20000', address: '12 Woji Road, Port Harcourt', arrive_by: opts.arriveBy ?? '2099-12-31', other_phone: seller, photos: [{ id: 'p1' }] },
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

async function dispatchByRider(seller: string, code: string, fee = '2,000') {
  await h.tap(seller, `dispatch:${code}`);
  await h.tap(seller, 'dm:rider');
  await h.say(seller, 'Musa Ibrahim');
  await h.say(seller, '08031234567');
  await h.say(seller, fee);
  await h.tap(seller, 'dloc:buyer');
  if (/account number and bank/.test(h.last(seller))) {
    await h.say(seller, '9876543210 Opay');
    await h.tap(seller, 'dacct:yes');
  }
}

describe('dispatch', () => {
  it('after payment the seller is asked to dispatch (or say they can\'t fulfil)', async () => {
    const { seller } = await paidBuyerOrder();
    expect(h.last(seller)).toMatch(/Dispatch it now/);
    expect(h.last(seller)).toMatch(/\[🚚 Dispatch now\] \[❌ Can't fulfil\]/);
  });

  it('rider: details, the account name is checked, the buyer gets the rider and a 4-digit code', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    h.provider.accountNames['999992:9876543210'] = 'MUSA IBRAHIM';
    await h.tap(seller, `dispatch:${code}`);
    expect(h.last(seller)).toMatch(/\[📍 Pickup\] \[🛵 Dispatch rider\] \[🚌 Waybill\]/);
    await h.tap(seller, 'dm:rider');
    expect(h.last(seller)).toMatch(/rider's name/);
    await h.say(seller, 'Musa Ibrahim');
    await h.say(seller, 'not a phone');
    expect(h.last(seller)).toMatch(/rider's phone number/);
    await h.say(seller, '08031234567');
    expect(h.last(seller)).toMatch(/delivery fee/);
    await h.say(seller, '25000');
    expect(h.last(seller)).toMatch(/less than what you receive/);
    await h.say(seller, '2,000');
    expect(h.last(seller)).toMatch(/12 Woji Road, Port Harcourt[\s\S]*\[Use this address\]/);
    await h.tap(seller, 'dloc:buyer');
    expect(h.last(seller)).toMatch(/Hoolam can't recover money sent to a wrong account/);
    await h.say(seller, '9876543210 Opay');
    expect(h.last(seller)).toMatch(/\*MUSA IBRAHIM\*/);
    await h.tap(seller, 'dacct:no');
    expect(h.last(seller)).toMatch(/account number and bank/);
    await h.say(seller, '9876543210 Opay');
    await h.tap(seller, 'dacct:yes');

    const d = await deal(code);
    expect(d).toMatchObject({ status: 'SHIPPED', dispatch_method: 'RIDER', courier_name: 'Musa Ibrahim', courier_phone: '+2348031234567', courier_location: '12 Woji Road, Port Harcourt', delivery_fee_minor: 200_000 });
    expect(d.handover_code).toMatch(/^\d{4}$/);
    const acct = await h.db.query('SELECT holder, is_default, account_name FROM bank_accounts WHERE id=$1', [d.courier_account_id]);
    expect(acct.rows[0]).toEqual({ holder: 'COURIER', is_default: false, account_name: 'MUSA IBRAHIM' });

    expect(h.last(seller)).toMatch(/ask the receiver for their 4-digit handover code/);
    expect(h.last(seller)).toMatch(/\[🔑 Enter code\]/);
    expect(h.last(buyer)).toMatch(new RegExp(`Your handover code: \\*${d.handover_code}\\*`));
    expect(h.last(buyer)).toMatch(/Rider: \*Musa Ibrahim\*/);
    await h.tap(buyer, `hcodeshow:${code}`);
    expect(h.last(buyer)).toMatch(new RegExp(`\\*${d.handover_code}\\*`));
  });

  it('the right code pays the rider at once; the seller is paid when the buyer is happy, minus the rider', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    await dispatchByRider(seller, code);
    const d = await deal(code);
    await h.tap(seller, `hcode:${code}`);
    await h.say(seller, d.handover_code === '0000' ? '1111' : '0000');
    expect(h.last(seller)).toMatch(/doesn't match.*4 tries left/s);
    await h.tap(seller, `hcode:${code}`);
    await h.say(seller, d.handover_code);
    expect(h.last(buyer)).toMatch(/has been handed over to you/);
    expect(h.last(buyer)).toMatch(/within 24 hours/);
    const after = await deal(code);
    expect(after.handed_over_at).not.toBeNull();
    expect(after.courier_paid_at).not.toBeNull();
    expect(await payouts(code)).toEqual([{ kind: 'DELIVERY', amount_minor: 200_000, status: 'SUCCESS' }]);
    expect(h.transcript.filter((t) => t.phone === seller).map((t) => t.text).join('\n')).toMatch(/Delivery fee sent: ₦2,000 to (MUSA IBRAHIM|TEST ACCOUNT HOLDER) \(OPay\)/);

    await h.tap(buyer, `happy:${code}`);
    expect((await deal(code)).status).toBe('COMPLETED');
    expect((await payouts(code)).map((p) => [p.kind, p.amount_minor])).toEqual([['DELIVERY', 200_000], ['SELLER', 1_800_000]]);
    const l = await ledger(code);
    expect(l['held:deal']).toBe(0);
    expect(l['payable:courier']).toBe(0);
    expect(l['payable:seller']).toBe(0);
    expect(l['revenue:fees']).toBe(-50_000);
  });

  it('five wrong codes lock it for the team', async () => {
    const { seller, code } = await paidBuyerOrder();
    await dispatchByRider(seller, code);
    const real = (await deal(code)).handover_code;
    const wrong = real === '1234' ? '4321' : '1234';
    for (let i = 0; i < 5; i++) { await h.tap(seller, `hcode:${code}`); await h.say(seller, wrong); }
    expect(h.last(seller)).toMatch(/Too many wrong codes/);
    await h.tap(seller, `hcode:${code}`); await h.say(seller, real);
    expect(h.last(seller)).toMatch(/Too many wrong codes/);
    expect((await deal(code)).handed_over_at).toBeNull();
  });

  it('pickup: the buyer gives the code at the shop; nobody else is paid', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    await h.tap(seller, `dispatch:${code}`);
    await h.tap(seller, 'dm:pickup');
    await h.say(seller, 'Shop 4, Rumuola Plaza');
    expect(h.last(buyer)).toMatch(/ready for pickup at:\n_Shop 4, Rumuola Plaza_/);
    expect(h.last(seller)).toMatch(/When the buyer comes, ask them for their 4-digit handover code/);
    await h.tap(seller, `hcode:${code}`); await h.say(seller, (await deal(code)).handover_code);
    expect(await payouts(code)).toEqual([]);
    await h.tap(buyer, `happy:${code}`);
    expect((await payouts(code)).map((p) => [p.kind, p.amount_minor])).toEqual([['SELLER', 2_000_000]]);
  });

  it('no answer after the handover: the seller is paid automatically after the set time', async () => {
    const { buyer, code, seller } = await paidBuyerOrder();
    await dispatchByRider(seller, code);
    await h.tap(seller, `hcode:${code}`); await h.say(seller, (await deal(code)).handover_code);
    await h.app.deals.sweep({ nudgeAfterHours: 9999 });
    expect((await deal(code)).status).toBe('SHIPPED'); // not yet
    await h.db.query(`UPDATE deals SET handed_over_at=now() - interval '25 hours' WHERE code=$1`, [code]);
    const r = await h.app.deals.sweep({ nudgeAfterHours: 9999 });
    expect(r.released).toBe(1);
    expect((await deal(code)).status).toBe('COMPLETED');
    expect(h.last(buyer)).toMatch(/we've paid the seller/);
  });

  it('a problem after the handover: the refund is everything still held (the rider keeps the delivery fee)', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    await dispatchByRider(seller, code);
    await h.tap(seller, `hcode:${code}`); await h.say(seller, (await deal(code)).handover_code);
    await h.tap(buyer, `problem:${code}`);
    await h.say(buyer, 'Wrong colour, I refused it');
    if (/account number and bank/.test(h.last(buyer))) { await h.say(buyer, '1112223334 Kuda'); await h.tap(buyer, 'bank:yes'); }
    await h.app.deals.adminRefund(code, 'Wrong colour, confirmed from photos');
    expect((await payouts(code)).map((p) => [p.kind, p.amount_minor])).toEqual([['DELIVERY', 200_000], ['REFUND', 1_850_000]]);
    expect((await ledger(code))['held:deal']).toBe(0);
  });

  it('"I\'m happy" without a code still pays the rider before the seller', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    await dispatchByRider(seller, code);
    await h.tap(buyer, `happy:${code}`);
    expect((await payouts(code)).map((p) => [p.kind, p.amount_minor])).toEqual([['DELIVERY', 200_000], ['SELLER', 1_800_000]]);
  });

  it('the seller can\'t fulfil: the buyer is asked for an account, then refunded in full', async () => {
    const { buyer, seller, code } = await paidBuyerOrder();
    await h.tap(seller, `srefund:${code}`);
    expect(h.last(seller)).toMatch(/This can't be undone/);
    await h.tap(seller, `srefundok:${code}`);
    expect(h.last(buyer)).toMatch(/The seller can't fulfil order/);
    await h.say(buyer, '1112223334 Kuda'); await h.tap(buyer, 'bank:yes');
    expect((await deal(code)).status).toBe('REFUNDED');
    expect((await payouts(code)).map((p) => [p.kind, p.amount_minor])).toEqual([['REFUND', 2_050_000]]);
  });

  it('overdue: the buyer can remind the seller, or take a refund', async () => {
    const { buyer, seller, code } = await paidBuyerOrder({ arriveBy: '2026-01-01' });
    await h.tap(buyer, `remind:${code}`);
    expect(h.last(seller)).toMatch(/The buyer sent you a reminder/);
    expect(h.last(buyer)).toMatch(/Reminder sent/);
    await h.say(buyer, '1112223334 Kuda'); // not asked: stays a normal message
    await h.tap(buyer, `refundme:${code}`);
    if (/account number and bank/.test(h.last(buyer))) { await h.say(buyer, '1112223334 Kuda'); await h.tap(buyer, 'bank:yes'); }
    expect((await deal(code)).status).toBe('REFUNDED');
    expect(h.transcript.filter((t) => t.phone === seller).map((t) => t.text).join('\n')).toMatch(/asked for a refund/);
  });

  it('a buyer can\'t take a refund before the expected date', async () => {
    const { buyer, code } = await paidBuyerOrder();
    await h.tap(buyer, `refundme:${code}`);
    expect((await deal(code)).status).toBe('FUNDED');
  });

  it('messages fit WhatsApp limits', () => {
    const money = { minor: 200_000, currency: 'NGN' as const };
    const info = { code: 'HL-AAAAA', pickupAddress: 'x', courierName: 'Musa', courierPhone: '+2348031234567', location: 'y' };
    for (const m of [
      msg.sellerFundedDispatch('HL-AAAAA', money), msg.askDispatchMethod('HL-AAAAA'), msg.askCourierLocation('rider', 'x'),
      msg.confirmCourierAccount('rider', 'MUSA', 'Opay', '3210'), msg.sellerDispatched({ ...info, method: 'RIDER', fee: money }),
      msg.buyerDispatched({ ...info, method: 'WAYBILL', handover: '1234' }), msg.handoverWrong('HL-AAAAA', 2), msg.handoverLocked('HL-AAAAA'),
      msg.buyerHandedOver('HL-AAAAA', '24 hours'), msg.sellerDispatchReminder('HL-AAAAA', 'bag', true), msg.confirmSellerRefund('HL-AAAAA'),
    ]) expect(() => checkLimits(m)).not.toThrow();
  });
});

describe('reminders', () => {
  it('a seller who hasn\'t dispatched is reminded once; a late order gives the buyer their options once', async () => {
    const { buyer, seller, code } = await paidBuyerOrder({ arriveBy: '2026-01-01' });
    await h.db.query(`UPDATE deals SET funded_at=now() - interval '13 hours' WHERE code=$1`, [code]);
    await h.app.deals.sweep({ nudgeAfterHours: 9999 });
    const sellerMsgs = () => h.transcript.filter((t) => t.phone === seller).map((t) => t.text).join('\n');
    expect(sellerMsgs()).toMatch(new RegExp(`Order ${code} \\(Leather bag\\) is paid and waiting to be dispatched`));
    expect(h.last(buyer)).toMatch(/hasn't been dispatched yet, and the date you expected it has passed/);
    expect(h.last(buyer)).toMatch(/\[🔔 Send reminder\] \[💸 Refund me\] \[Wait a bit\]/);
    const before = h.transcript.length;
    await h.app.deals.sweep({ nudgeAfterHours: 9999 });
    expect(h.transcript.slice(before).filter((t) => t.phone === seller || t.phone === buyer)).toHaveLength(0);
  });
});
