import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode } from '../src/console/crypto.js';
import { bandFee, checkBands, DEFAULT_TXN_BANDS, PRICING, quote } from '../src/pricing.js';
import { bankChoices, nubanFits } from '../src/whatsapp/banks.js';
import { checkLimits, Messenger, withMenuOption, type Outbound } from '../src/whatsapp/client.js';
import { ordersFlowJson } from '../src/whatsapp/orders-flow.js';
import { FakeProvider } from '../src/payments/fake.js';
import { viewKey } from '../src/deals/service.js';
import { localPhone } from '../src/phone.js';

let h: Harness;
let owner = '';
let n = 0;
const ADMIN = 'test-admin-token-123456';
const txn = { seller: DEFAULT_TXN_BANDS, buyer: DEFAULT_TXN_BANDS };

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) {
  const r = await h.app.app.inject({
    method: method as 'GET', url,
    headers: { 'x-hoolam-console': '1', ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    payload: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null; try { json = r.json(); } catch { /* not JSON */ }
  return { status: r.statusCode, json, text: r.body };
}
const cookieOf = (x: Record<string, unknown>) => String(x['set-cookie']).split(';')[0]!;
const phone = () => `+23480${String(7_100_000 + ++n).padStart(8, '0')}`;

beforeAll(async () => {
  h = await startHarness({ quiet: true });
  const s = await call('POST', '/console/api/auth/setup', { body: { setupToken: ADMIN, name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' } });
  const e = await h.app.app.inject({ method: 'POST', url: '/console/api/auth/enroll', headers: { 'x-hoolam-console': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ ticket: s.json.ticket, code: totpCode(s.json.secret) }) });
  owner = cookieOf(e.headers);
}, 60_000);
afterAll(async () => { await h?.stop(); });

describe('who pays what', () => {
  it('buyer starts: the buyer pays Hoolam\'s fee, the seller\'s transaction fee comes out of their payout', () => {
    const q = quote(2_000_000, 'NGN', PRICING.NGN, 'buyer', txn);
    expect(q).toMatchObject({ feeMinor: 50_000, txnFeeMinor: 50_000, txnPayer: 'seller', buyerPaysMinor: 2_050_000, sellerGetsMinor: 1_950_000 });
  });

  it('seller starts: the seller pays Hoolam\'s fee, the buyer pays a transaction fee on top', () => {
    const q = quote(2_000_000, 'NGN', PRICING.NGN, 'seller', txn);
    expect(q).toMatchObject({ feeMinor: 50_000, txnFeeMinor: 50_000, txnPayer: 'buyer', buyerPaysMinor: 2_050_000, sellerGetsMinor: 1_950_000 });
  });

  it('the bands: ₦500 up to ₦100,000, then ₦1,000, ₦1,500, ₦2,000, and ₦2,500 above ₦400,000', () => {
    expect([1_000, 100_000, 100_001, 200_000, 250_000, 400_000, 400_001, 5_000_000].map((p) => bandFee(DEFAULT_TXN_BANDS, p)))
      .toEqual([500, 500, 1_000, 1_000, 1_500, 2_000, 2_500, 2_500]);
    expect(quote(15_000_000, 'NGN', PRICING.NGN, 'buyer', txn).sellerGetsMinor).toBe(15_000_000 - 100_000); // ₦150,000 is in the ₦1,000 band
  });

  it('the website calculator (no starter given) has no transaction fee', () => {
    expect(quote(2_000_000, 'NGN').txnFeeMinor).toBe(0);
  });

  it('a tiny order never leaves the seller with nothing', () => {
    const q = quote(30_000, 'NGN', PRICING.NGN, 'buyer', txn);
    expect(q.sellerGetsMinor).toBeGreaterThan(0);
  });

  it('band tables from the console are checked', () => {
    expect(checkBands(DEFAULT_TXN_BANDS)).toBeNull();
    expect(checkBands([{ upTo: 100_000, fee: 500 }, { upTo: 50_000, fee: 1_000 }, { upTo: null, fee: 2_000 }])).toMatch(/bigger than the band before/);
    expect(checkBands([{ upTo: 100_000, fee: 500 }, { upTo: 200_000, fee: 1_000 }])).toMatch(/last band covers everything above/);
    expect(checkBands([{ upTo: null, fee: -1 }])).toMatch(/fee must be a number/);
    expect(checkBands('500')).toMatch(/between 1 and 10/);
  });
});

describe('the console sets both band tables', () => {
  it('an owner changes the seller\'s bands; new orders use them, and only the seller sees it', async () => {
    const before = await call('GET', '/console/api/settings', { cookie: owner });
    expect(before.json.values.seller_txn_fee).toEqual(DEFAULT_TXN_BANDS);
    expect(before.json.defs.find((d: any) => d.key === 'buyer_txn_fee')).toMatchObject({ group: 'Fees', label: 'Buyer transaction fee', type: 'bands' });

    const bad = await call('PUT', '/console/api/settings', { cookie: owner, body: { changes: { seller_txn_fee: [{ upTo: 100_000, fee: 700 }, { upTo: 90_000, fee: 900 }, { upTo: null, fee: 1_000 }] }, reason: 'test' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Seller transaction fee/);

    const bands = [{ upTo: 50_000, fee: 300 }, { upTo: 100_000, fee: 700 }, { upTo: 200_000, fee: 1_000 }, { upTo: 400_000, fee: 2_000 }, { upTo: null, fee: 3_000 }];
    const ok = await call('PUT', '/console/api/settings', { cookie: owner, body: { changes: { seller_txn_fee: bands }, reason: 'Pilot pricing' } });
    expect(ok.status).toBe(200);
    expect(h.app.deals.txnFees().seller).toEqual(bands);
    const q = h.app.deals.previewDeal(4_000_000, 'buyer');
    expect(q).toMatchObject({ txnFeeMinor: 30_000, sellerGetsMinor: 3_970_000 });

    await call('PUT', '/console/api/settings', { cookie: owner, body: { changes: { seller_txn_fee: DEFAULT_TXN_BANDS }, reason: 'back' } });
  });
});

describe('the private order page shows each side their own fee', () => {
  it('buyer link: Hoolam fee and You pay; seller link: transaction fee and You receive; old link: neither fee', async () => {
    const d = (await h.db.query(`SELECT code, view_token FROM deals WHERE view_token IS NOT NULL AND started_by='BUYER' LIMIT 1`)).rows[0];
    let deal = d;
    if (!deal) {
      const buyer = phone(), seller = phone();
      await h.say(buyer, 'hi', 'Ada Obi');
      await h.app.chat.handle({ id: `f${++n}`, phone: buyer, name: 'Ada Obi', type: 'form', text: '', buttonId: null, mediaId: null,
        form: { flow_token: 'buy:v1', item: 'Wig', description: 'Bone straight', category: 'beauty', price: '20000', address: 'GRA', arrive_by: '2099-12-31', other_phone: seller, photos: [{ id: 'w1' }] } });
      await h.tap(buyer, 'buy:send');
      deal = (await h.db.query(`SELECT code, view_token FROM deals WHERE buyer_id=(SELECT id FROM users WHERE phone=$1)`, [buyer])).rows[0];
    }
    const page = async (k: string) => (await call('GET', `/o/${deal.code}?k=${encodeURIComponent(k)}`)).text;
    const b = await page(viewKey(deal.view_token, 'buyer'));
    expect(b).toMatch(/Hoolam fee/); expect(b).toMatch(/You pay/); expect(b).not.toMatch(/Transaction fee|You receive/);
    const s = await page(viewKey(deal.view_token, 'seller'));
    expect(s).toMatch(/Transaction fee/); expect(s).toMatch(/You receive/); expect(s).not.toMatch(/Hoolam fee|You pay/);
    const neutral = await page(deal.view_token);
    expect(neutral).not.toMatch(/Hoolam fee|Transaction fee/);
    expect((await call('GET', `/o/${deal.code}?k=wrong-key-123`)).text).not.toMatch(/You pay|You receive/);
  });
});

describe('Main menu on every message with room for it', () => {
  const ids = (m: Outbound) => (m.kind === 'buttons' ? m.buttons.map((b) => b.id) : m.kind === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.id)) : []);
  it('plain messages get it; 1 or 2 buttons get it last; lists get a last row', () => {
    expect(ids(withMenuOption({ kind: 'text', text: 'Hi' }))).toEqual(['menu:open']);
    expect(ids(withMenuOption({ kind: 'buttons', text: 'x', buttons: [{ id: 'a:1', title: 'A' }] }))).toEqual(['a:1', 'menu:open']);
    expect(ids(withMenuOption({ kind: 'buttons', text: 'x', buttons: [{ id: 'a:1', title: 'A' }, { id: 'b:1', title: 'B' }] }))).toEqual(['a:1', 'b:1', 'menu:open']);
    const list = withMenuOption({ kind: 'list', text: 'x', button: 'Choose', sections: [{ title: 'S', rows: [{ id: 'cat:a', title: 'A' }] }] });
    expect(ids(list)).toEqual(['cat:a', 'menu:open']);
    expect(() => checkLimits(list)).not.toThrow();
  });
  it('left alone: 3 buttons, already there, the menu itself, a full list, forwardable text, forms', () => {
    const three: Outbound = { kind: 'buttons', text: 'x', buttons: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }] };
    expect(withMenuOption(three)).toEqual(three);
    const has: Outbound = { kind: 'buttons', text: 'x', buttons: [{ id: 'menu:open', title: 'Main menu' }] };
    expect(withMenuOption(has)).toEqual(has);
    const menu: Outbound = { kind: 'list', text: 'x', button: 'Open menu', sections: [{ title: 'Buying', rows: [{ id: 'menu:buy', title: 'Buy' }] }] };
    expect(withMenuOption(menu)).toEqual(menu);
    const fwd: Outbound = { kind: 'text', text: 'Buy safely: link', noMenu: true };
    expect(withMenuOption(fwd)).toEqual(fwd);
    const long: Outbound = { kind: 'text', text: 'x'.repeat(1100) };
    expect(withMenuOption(long)).toEqual(long);
  });
  it('in the chat: a question that waits for typing still has the way out', async () => {
    const p = phone();
    await h.say(p, 'hi'); await h.tap(p, 'menu:pay');
    expect(h.last(p)).toMatch(/Send the order code[\s\S]*\[Main menu\]/);
  });
});

describe('picking a bank', () => {
  it('NUBAN: matches the CBN worked example and rules banks out', () => {
    expect(nubanFits('011', '0000014579')).toBe(true);
    expect(nubanFits('011', '0000014578')).toBe(false);
    expect(nubanFits('ABC', '0000014579')).toBeNull();
  });
  it('the list: OPay, Moniepoint, PalmPay and Kuda first, then the banks the number fits', () => {
    const list = bankChoices('0000014579', FakeProvider.BANKS).map((b) => b.name);
    expect(list.slice(0, 4)).toEqual(['OPay', 'Moniepoint MFB', 'PalmPay', 'Kuda']);
    expect(list).toContain('First Bank');
    expect(list).not.toContain('GTBank');
  });
  it('in the chat: send only the number, tap the bank', async () => {
    const p = phone();
    await h.say(p, 'hi'); await h.tap(p, 'menu:account');
    expect(h.last(p)).toMatch(/Send your account number/);
    await h.say(p, '0000014579');
    expect(h.last(p)).toMatch(/Which bank is \*0000014579\* with\?/);
    expect(h.last(p)).toMatch(/First Bank/);
    expect(h.last(p)).not.toMatch(/GTBank/);
    await h.tap(p, 'bpick:011');
    expect(h.last(p)).toMatch(/Is this your account\?[\s\S]*First Bank ••••4579/);
    await h.tap(p, 'bank:yes');
    expect(h.last(p)).toMatch(/Saved\. New orders pay into First Bank ••••4579/);
  });
  it('in the chat: "Other bank", then the name', async () => {
    const p = phone();
    await h.say(p, 'hi'); await h.tap(p, 'menu:account');
    await h.say(p, '0000014579');
    await h.tap(p, 'bpick:other');
    expect(h.last(p)).toMatch(/Type the bank name/);
    await h.say(p, 'Wema');
    expect(h.last(p)).toMatch(/Wema Bank ••••4579/);
  });
});

describe('the dispatch form', () => {
  it('pickup address and rider\'s name are required when they apply; the waybill number is the driver\'s', () => {
    const json = ordersFlowJson('ORDER') as any;
    const field = (screen: string, name: string) => json.screens.find((x: any) => x.id === screen).layout.children.find((c: any) => c.name === name);
    expect(field('DISPATCH', 'pickup_address').required).toBe('${data.show_pickup}');
    expect(field('COURIER', 'name').required).toBe('${data.is_rider}');
    expect(field('COURIER', 'phone').label).toBe('${data.phone_label}');
    expect(field('COURIER', 'bank')).toMatchObject({ type: 'Dropdown', 'data-source': '${data.banks}' });
    // the plain fallback, if Meta refuses switchable fields
    const safe = ordersFlowJson('ORDER', true) as any;
    const sf = (screen: string, name: string) => safe.screens.find((x: any) => x.id === screen).layout.children.find((c: any) => c.name === name);
    expect(sf('DISPATCH', 'pickup_address').required).toBe(false);
    expect(sf('COURIER', 'phone').label).toBe('Phone number');
  });
});

describe('templates', () => {
  it('a newer version with more values falls back to the approved older one, sending it only what it takes', async () => {
    const sent: any[] = [];
    const m = new Messenger(h.db, { dryRun: false, token: 't', phoneNumberId: '1', graphVersion: 'v1', fetchImpl: (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('{"messages":[{"id":"x"}]}'); }) as any });
    m.setTemplateReplaces('new_price_v2', 'new_price', { params: [0, 4], buttons: 1 });
    m.setTemplateStatus('new_price', 'APPROVED');
    m.setTemplateStatus('new_price_v2', 'PENDING');
    await m.sendTemplate('+2348000000001', { name: 'new_price_v2', language: 'en', params: ['HL-1', '₦18,000', 'reason', '₦450', '₦18,450'], buttonPayloads: ['cyes:HL-1', 'cancel:HL-1'], buttonTitles: ['Accept', 'Cancel'], preview: '' });
    expect(sent[0].template.name).toBe('new_price');
    expect(sent[0].template.components[0].parameters.map((p: any) => p.text)).toEqual(['HL-1', '₦18,450']);
    expect(sent[0].template.components.filter((c: any) => c.type === 'button')).toHaveLength(1);
  });
});

describe('phone numbers', () => {
  it('shown the way people write them', () => {
    expect(localPhone('+2348031234567')).toBe('08031234567');
    expect(localPhone('2348031234567')).toBe('08031234567');
    expect(localPhone('08031234567')).toBe('08031234567');
    expect(localPhone('+15551380045')).toBe('+15551380045');
    expect(localPhone(null)).toBe('');
  });
});
