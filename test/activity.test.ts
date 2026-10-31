import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { Activity, describeInbound, maskNumbers } from '../src/activity.js';

let h: Harness;
let a: Activity;
beforeAll(async () => { h = await startHarness({ quiet: true }); a = new Activity(h.db); }, 120_000);
afterAll(async () => { await h?.stop(); });
const idOf = async (p: string) => (await h.db.query('SELECT id FROM users WHERE phone=$1', [p])).rows[0].id as string;

describe('activity', () => {
  it('keeps what people do in plain words, without sensitive numbers', () => {
    expect(maskNumbers('Pay into 0123456789 GTBank, call 08031234567')).toBe('Pay into ••••6789 GTBank, call ••••4567');
    expect(maskNumbers('I paid 15000 for 2 bags')).toBe('I paid 15000 for 2 bags');
    const tap = describeInbound({ id: 'w1', phone: '+2348000000001', name: null, type: 'button', text: '🛡️ Buy safely', buttonId: 'mk:buy:12', mediaId: null }, 'IDLE');
    expect(tap).toMatchObject({ kind: 'tap', title: 'Tapped “🛡️ Buy safely”', detail: { listing: 12 } });
    const bvn = describeInbound({ id: 'w2', phone: '+2348000000001', name: null, type: 'text', text: '22212345678', buttonId: null, mediaId: null }, 'KYC_NUMBER');
    expect(bvn?.title).toBe('Typed their ID details');
    expect(JSON.stringify(bvn)).not.toContain('22212345678');
    const kyc = describeInbound({ id: 'w3', phone: '+2348000000001', name: null, type: 'form', text: '', buttonId: null, mediaId: null, form: { flow_token: 'kyc:v1', number: '22212345678', dob: '1990-01-01' } }, 'IDLE');
    expect(JSON.stringify(kyc)).not.toMatch(/22212345678|1990/);
    expect(describeInbound({ id: 'kyc-1', phone: '+2348000000001', name: null, type: 'button', text: '', buttonId: 'x', mediaId: null }, 'IDLE')).toBeNull();
  });

  it('a seller\'s order shows their taps, messages, the order steps and what Hoolam sent, newest first', async () => {
    const seller = '+2348070000001', buyer = '+2348070000002';
    await h.say(seller, 'hi', 'Ada');
    await h.say(buyer, 'hi', 'Tolu');
    const code = await h.sellOrder(seller, buyer, { item: 'Green bag', price: '10000' });
    const r = (await a.list(await idOf(seller)))!;
    const titles = r.items.map((i) => i.title);
    expect(titles).toContain('Sent a message');
    expect(titles.some((t) => /^Tapped “/.test(t))).toBe(true);
    expect(titles).toContain('Tapped “📨 Send to buyer”'); // the button's title, from the message it was on
    expect(r.items.some((i) => i.kind === 'order' && i.detail.code === code)).toBe(true);
    expect(r.items.some((i) => i.kind === 'sent')).toBe(true);
    for (let i = 1; i < r.items.length; i++) expect(+new Date(r.items[i - 1]!.at)).toBeGreaterThanOrEqual(+new Date(r.items[i]!.at));
    expect(r.summary!.today).toBeGreaterThan(3);
    // the account number they typed keeps only its last 4 digits
    expect(JSON.stringify(r.items.filter((i) => i.kind === 'message'))).not.toContain('0123456789');
    // filters
    const taps = (await a.list(await idOf(seller), { filter: 'taps' }))!;
    expect(taps.items.every((i) => i.kind === 'tap' || i.kind === 'screen')).toBe(true);
    const orders = (await a.list(await idOf(seller), { filter: 'orders' }))!;
    expect(orders.items.every((i) => i.kind === 'order')).toBe(true);
    // a repeat delivery of the same WhatsApp message is kept once
    const before = (await h.db.query('SELECT count(*)::int AS n FROM user_activity')).rows[0].n;
    await a.inbound({ id: 'same-1', phone: seller, name: null, type: 'text', text: 'hello', buttonId: null, mediaId: null }, await idOf(seller), 'IDLE');
    await a.inbound({ id: 'same-1', phone: seller, name: null, type: 'text', text: 'hello', buttonId: null, mediaId: null }, await idOf(seller), 'IDLE');
    expect((await h.db.query('SELECT count(*)::int AS n FROM user_activity')).rows[0].n).toBe(before + 1);
  });

  it('the console page asks for it by person, and only owners and admins see it', async () => {
    const { can } = await import('../src/console/staff.js');
    expect(can('OWNER', 'user.activity')).toBe(true);
    expect(can('ADMIN', 'user.activity')).toBe(true);
    expect(can('FINANCE', 'user.activity')).toBe(false);
  });
});
