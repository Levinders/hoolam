import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { pageFormJson, payoutFormJson, problemFormJson, rateFormJson } from '../src/whatsapp/more-forms.js';

let h: Harness;
let seq = 0;
let n = 0;
const phone = () => `+2348060000${String(++seq).padStart(3, '0')}`;
const KEYS = ['payout', 'problem', 'page', 'rate'] as const;
beforeAll(async () => {
  h = await startHarness({ quiet: true });
  for (const k of KEYS) h.app.forms.set(k, { flowId: `f-${k}`, mode: 'published' });
}, 120_000);
afterAll(async () => { await h?.stop(); });

const submit = (p: string, token: string, form: Record<string, unknown>) =>
  h.app.chat.handle({ id: `f${++n}`, phone: p, name: null, type: 'form', text: '', buttonId: null, mediaId: null, form: { flow_token: token, ...form } });
const lastOut = async (p: string) => (await h.db.query('SELECT kind, body FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [p])).rows[0];
const state = async (p: string) => (await h.db.query('SELECT state, data FROM chat_sessions WHERE phone=$1', [p])).rows[0];
const ask = (token: string, action: string, data: Record<string, unknown> = {}) => h.app.chat.payoutFormRequest({ action, flow_token: token, data }) as Promise<any>;

/** A seller's order (seller set up in the chat, forms off for that part), paid by the buyer. */
async function paid(seller: string, buyer: string, item = 'Blue handbag') {
  for (const k of KEYS) h.app.forms.set(k, null);
  await h.say(seller, 'hi', 'Ada');
  await h.say(buyer, 'hi', 'Tolu Bello');
  const code = await h.sellOrder(seller, buyer, { item, price: '10000' });
  await h.acceptOrder(buyer, code);
  const r = await h.db.query('SELECT pi.provider_reference FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id WHERE d.code=$1', [code]);
  h.provider.pay(r.rows[0].provider_reference);
  await h.app.deals.handleCollection(r.rows[0].provider_reference);
  for (const k of KEYS) h.app.forms.set(k, { flowId: `f-${k}`, mode: 'published' });
  return code;
}

describe('the four forms', () => {
  it('are sound: every ${data.x} declared, every ${form.x} a field, one photo picker at most', () => {
    const flat = (cs: any[]): any[] => cs.flatMap((c) => (c.type === 'Form' ? flat(c.children) : [c]));
    for (const json of [payoutFormJson(), problemFormJson(), pageFormJson(), rateFormJson()] as any[]) {
      for (const sc of json.screens) {
        const parts = flat(sc.layout.children);
        const fields = new Set(parts.map((c) => c.name).filter(Boolean));
        const text = JSON.stringify(sc.layout);
        for (const [, k] of text.matchAll(/\$\{data\.(\w+)\}/g)) expect(Object.keys(sc.data ?? {}), `${sc.id}: data.${k}`).toContain(k);
        for (const [, k] of text.matchAll(/\$\{form\.(\w+)\}/g)) expect([...fields], `${sc.id}: form.${k}`).toContain(k);
        expect(parts.filter((c) => c.type === 'PhotoPicker').length).toBeLessThanOrEqual(1);
        expect(parts.some((c) => c.type === 'TextCaption' || c.type === 'TextBody')).toBe(true); // a line of reassurance on every screen
      }
    }
  });

  it('report a problem: frozen at once, one form with a reason, details and photos; then the refund account form', async () => {
    const s = phone(), b = phone();
    const code = await paid(s, b);
    await h.tap(b, `problem:${code}`);
    expect((await h.db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0].status).toBe('DISPUTED');
    const out = await lastOut(b);
    expect(out.kind).toBe('form');
    expect(out.body.flowToken).toBe(`problem:${code}`);
    expect(out.body.data.frozen).toMatch(/is frozen with Hoolam/);
    await submit(b, `problem:${code}`, { reason: 'damaged', details: 'The strap is torn.', photos: [{ id: 'p1' }, { id: 'p2' }] });
    const d = (await h.db.query(`SELECT x.reason FROM disputes x JOIN deals d ON d.id=x.deal_id WHERE d.code=$1`, [code])).rows[0];
    expect(d.reason).toMatch(/It came damaged: The strap is torn\./);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM deal_photos p JOIN deals d ON d.id=p.deal_id WHERE d.code=$1 AND p.kind='PROBLEM'`, [code])).rows[0].n).toBe(2);

    // no refund account yet: the payout form (live)
    expect((await state(b)).state).toBe('REFUND_BANK');
    const pay = await lastOut(b);
    expect(pay.kind).toBe('form');
    expect(pay.body.live).toBe(true);
    const token = pay.body.flowToken as string;
    expect((await ask(token, 'INIT')).data.heading).toBe('Where should a refund go?');
    expect((await ask(token, 'data_exchange', { op: 'number', account_number: '12345' })).data.has_error).toBe(true);
    const banks = await ask(token, 'data_exchange', { op: 'number', account_number: '0123456789' });
    expect(banks.screen).toBe('BANK');
    const bank = banks.data.banks[0].id;
    const confirm = await ask(token, 'data_exchange', { op: 'bank', account_number: '0123456789', bank });
    expect(confirm.screen).toBe('CONFIRM');
    expect(confirm.data.confirm_text).toMatch(/TEST ACCOUNT HOLDER/);
    await submit(b, token, { account_number: '0123456789', bank });
    expect((await state(b)).state).toBe('IDLE');
    expect(h.last(b)).toMatch(/Case \*/);
    expect((await h.db.query('SELECT count(*)::int AS n FROM bank_accounts WHERE user_id=(SELECT id FROM users WHERE phone=$1)', [b])).rows[0].n).toBe(1);
    // typing still works (the chat is the backup): a second photo sent in the chat is kept as proof too
  });

  it('the payout form refuses an account in someone else\'s name for a checked seller', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Musa Ibrahim');
    await h.db.query(`UPDATE users SET kyc_status='VERIFIED', kyc_verified_at=now(), kyc_name='MUSA IBRAHIM', seller_since=now() WHERE phone=$1`, [p]);
    await h.tap(p, 'menu:account');
    const st = await state(p);
    expect(st.state).toBe('ACCOUNT_BANK');
    const token = (await lastOut(p)).body.flowToken as string;
    expect((await ask(token, 'INIT')).data.intro).toMatch(/MUSA IBRAHIM/);
    const r = await ask(token, 'data_exchange', { op: 'bank', account_number: '0123456789', bank: (await ask(token, 'data_exchange', { op: 'number', account_number: '0123456789' })).data.banks[0].id });
    expect(r.screen).toBe('BANK');
    expect(r.data.error).toMatch(/only go to an account in your own name/);
    // an expired or forged token is turned away
    expect((await ask('pb1.2348000000000.1.xxxx', 'INIT')).data.error).toMatch(/expired/);
  });

  it('my page: the one-time setup in one form, then editing it filled in', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Kemi Okafor');
    await h.tap(p, 'menu:sell');
    let out = await lastOut(p);
    expect(out.kind).toBe('form');
    expect(out.body.flowToken).toBe('page:setup:sell');
    expect(out.body.data.name).toMatch(/^Kemi/); // the name from their WhatsApp, to keep or change
    await submit(p, 'page:setup:sell', { name: 'Kemi Wigs', city: 'Lagos', instagram: '@kemiwigs', tiktok: '', facebook: '', website: '' });
    const u = (await h.db.query('SELECT business_name, city, seller_since FROM users WHERE phone=$1', [p])).rows[0];
    expect(u).toMatchObject({ business_name: 'Kemi Wigs', city: 'Lagos' });
    expect(u.seller_since).not.toBeNull();
    // then straight on to the first sale
    expect(['BUY_FORM', 'BUY_ITEM']).toContain((await state(p)).state);

    await h.tap(p, 'card:edit');
    expect(h.last(p)).toMatch(/Name, photo and links/);
    await h.tap(p, 'card:form');
    out = await lastOut(p);
    expect(out.body.flowToken).toBe('page:edit');
    expect(out.body.data).toMatchObject({ name: 'Kemi Wigs', city: 'Lagos' });
    expect(out.body.data.instagram).toMatch(/kemiwigs/);
    await submit(p, 'page:edit', { name: 'Kemi Wigs & Hair', city: 'Ikeja', instagram: '', tiktok: '@kemi.hair', facebook: '', website: 'not a link at all' });
    const t = await h.app.trust.seller((await h.db.query('SELECT id FROM users WHERE phone=$1', [p])).rows[0].id);
    expect(t!.name).toBe('Kemi Wigs & Hair');
    expect(t!.socials.map((x) => x.kind)).toEqual(['tiktok']);
  });

  it('rating: a few words with a tick to show them (👍), what went wrong (👎)', async () => {
    const s = phone(), b = phone();
    const code = await paid(s, b);
    await h.handOver(s, code);
    await h.tap(b, `happy:${code}`);
    await h.tap(b, `rateup:${code}`);
    let out = (await h.db.query(`SELECT kind, body FROM outbound_messages WHERE phone=$1 AND kind='form' ORDER BY id DESC LIMIT 1`, [b])).rows[0];
    expect(out.kind).toBe('form');
    expect(out.body.data).toMatchObject({ happy: true, unhappy: false });
    await submit(b, `rate:${code}`, { words: 'Fast delivery, exactly like the pictures', show: true, note: '' });
    const r = (await h.db.query('SELECT text, public FROM seller_reviews WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code])).rows[0];
    expect(r).toEqual({ text: 'Fast delivery, exactly like the pictures', public: true });
    expect(h.last(b)).toMatch(/on \*.*\*'s page now/);

    const s2 = phone(), b2 = phone();
    const code2 = await paid(s2, b2, 'Red shoes');
    await h.handOver(s2, code2);
    await h.tap(b2, `happy:${code2}`);
    await h.tap(b2, `ratedown:${code2}`);
    out = await lastOut(b2);
    expect(out.body.data).toMatchObject({ happy: false, unhappy: true });
    await submit(b2, `rate:${code2}`, { words: '', show: false, note: 'Took 2 weeks to arrive' });
    expect((await h.db.query('SELECT comment FROM deal_ratings WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code2])).rows[0].comment).toBe('Took 2 weeks to arrive');
  });

  it('when a form is off, the chat asks the same questions', async () => {
    for (const k of KEYS) h.app.forms.set(k, null);
    const p = phone();
    await h.say(p, 'hi', 'Femi');
    await h.tap(p, 'menu:sell');
    expect(h.last(p)).toMatch(/Set up as a seller/);
    for (const k of KEYS) h.app.forms.set(k, { flowId: `f-${k}`, mode: 'published' });
  });
});
