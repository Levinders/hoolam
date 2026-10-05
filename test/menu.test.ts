import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { automationPayload, COMMANDS, ICE_BREAKERS, syncAutomation } from '../src/whatsapp/automation.js';
import { checkLimits, toPayload } from '../src/whatsapp/client.js';
import { parseInbound } from '../src/whatsapp/inbound.js';
import { msg, MENU } from '../src/whatsapp/messages.js';

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const phone = () => `+2348030000${String(++seq).padStart(3, '0')}`;

const lastBody = async (p: string) =>
  (await h.db.query('SELECT body FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [p])).rows[0]?.body;
const state = async (p: string) => (await h.db.query('SELECT state FROM chat_sessions WHERE phone=$1', [p])).rows[0]?.state;

/** A seller makes a deal and the buyer pays it (test provider). Returns the code. */
async function paidDeal(seller: string, buyer: string, item = 'Blue handbag'): Promise<string> {
  await h.say(seller, 'hi', 'Ada');
  await h.tap(seller, 'menu:sell');
  await h.say(seller, item);
  await h.say(seller, '10000');
  if (/account number and bank/.test(h.last(seller))) { await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes'); }
  await h.tap(seller, 'sell:confirm');
  const code = h.last(seller).match(/HL-[A-Z2-9]{5}/)![0];
  await h.say(buyer, `Pay ${code}`, 'Tolu');
  await h.tap(buyer, `pay:${code}`);
  const r = await h.db.query('SELECT pi.provider_reference FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id WHERE d.code=$1', [code]);
  h.provider.pay(r.rows[0].provider_reference);
  await h.app.deals.handleCollection(r.rows[0].provider_reference);
  return code;
}

describe('message shapes', () => {
  it('the main menu fits WhatsApp limits', () => {
    const m = msg.menu('Ada Obi');
    expect(() => checkLimits(m)).not.toThrow();
    expect(m.kind).toBe('list');
    expect(MENU.flatMap((s) => s.rows).length).toBeLessThanOrEqual(10);
  });

  it('builds the WhatsApp list payload', () => {
    const p = toPayload('2348000000000', msg.menu(null)) as any;
    expect(p.type).toBe('interactive');
    expect(p.interactive.type).toBe('list');
    expect(p.interactive.action.button).toBe('Open menu');
    expect(p.interactive.action.sections[0].rows[0]).toEqual({ id: 'menu:sell', title: 'Sell something', description: expect.any(String) });
  });

  it('rejects lists WhatsApp would refuse', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
    expect(() => checkLimits({ kind: 'list', text: 'x', button: 'Go', sections: [{ title: 'A', rows }] })).toThrow(/10 rows/);
    expect(() => checkLimits({ kind: 'list', text: 'x', button: 'Go', sections: [{ title: 'A', rows: [{ id: 'a', title: 'x'.repeat(25) }] }] })).toThrow(/too long/);
  });

  it('reads list taps and first-open events from the webhook', () => {
    const body = { entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '2348011111111', profile: { name: 'Ada' } }],
      messages: [
        { from: '2348011111111', id: 'w1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'menu:fees', title: 'Fees' } } },
        { from: '2348011111111', id: 'w2', type: 'request_welcome' },
      ],
    } }] }] };
    const [a, b] = parseInbound(body);
    expect(a).toMatchObject({ type: 'button', buttonId: 'menu:fees', text: 'Fees' });
    expect(b).toMatchObject({ type: 'welcome', phone: '+2348011111111' });
  });

  it('ice breakers and commands fit Meta limits', () => {
    expect(ICE_BREAKERS.length).toBeLessThanOrEqual(4);
    for (const t of ICE_BREAKERS) { expect(t.length).toBeLessThanOrEqual(80); expect(t).not.toMatch(/\p{Extended_Pictographic}/u); }
    expect(COMMANDS.length).toBeLessThanOrEqual(30);
    for (const c of COMMANDS) { expect(c.name.length).toBeLessThanOrEqual(32); expect(c.hint.length).toBeLessThanOrEqual(256); }
    expect(automationPayload().commands[0]).toEqual({ command_name: 'menu', command_description: expect.any(String) });
  });

  it('menu sync reports what Meta said and never throws', async () => {
    const lines: string[] = [];
    const calls: { url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{"error":{"message":"nope"}}', { status: 400 });
    }) as unknown as typeof fetch;
    const r = await syncAutomation({ token: 't', phoneNumberId: '123', graphVersion: 'v26.0', fetchImpl: fakeFetch, log: (l) => lines.push(l) });
    expect(r.ok).toBe(false);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v26.0/123/conversational_automation');
    expect(calls[0]!.body.prompts).toEqual(ICE_BREAKERS);
    expect(lines[0]).toMatch(/menu sync FAILED \(HTTP 400\)/);
  });
});

describe('the menu in the chat', () => {
  it('"hi" and opening the chat for the first time both show the menu list', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Ada Obi');
    expect((await lastBody(p)).kind).toBe('list');
    expect(h.last(p)).toMatch(/Hi Ada, welcome to Hoolam/);
    const q = phone();
    await h.app.chat.handle({ id: `wel-${q}`, phone: q, name: 'Bayo', type: 'welcome', text: '', buttonId: null, mediaId: null });
    expect((await lastBody(q)).kind).toBe('list');
  });

  it('unknown text shows the menu instead of a dead end', async () => {
    const p = phone();
    await h.say(p, 'abeg wetin dey happen');
    expect((await lastBody(p)).kind).toBe('list');
  });

  it('slash commands and ice-breaker phrases work', async () => {
    const p = phone();
    await h.say(p, '/fees');
    expect(h.last(p)).toMatch(/2\.5% of the price/);
    expect(h.last(p)).toMatch(/₦15,000 item: fee ₦400, buyer pays ₦15,400/);
    expect(h.last(p)).toMatch(/\[Main menu\]/);
    await h.say(p, '/help');
    expect(h.last(p)).toMatch(/How Hoolam works/);
    await h.say(p, 'I want to sell something');
    expect(h.last(p)).toMatch(/What are you selling/);
    await h.say(p, '/menu'); // leaves the sell flow
    expect(await state(p)).toBe('IDLE');
    await h.say(p, 'How does Hoolam work?');
    expect(h.last(p)).toMatch(/How Hoolam works/);
    await h.tap(p, 'menu:help'); // the old button id still works
    expect(h.last(p)).toMatch(/How Hoolam works/);
  });

  it('"Pay for a deal" asks for the code, then opens the deal', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi'); await h.tap(seller, 'menu:sell'); await h.say(seller, 'Shoes'); await h.say(seller, '8000');
    await h.say(seller, '0123456789 Opay'); await h.tap(seller, 'bank:yes'); await h.tap(seller, 'sell:confirm');
    const code = h.last(seller).match(/HL-[A-Z2-9]{5}/)![0];

    await h.tap(buyer, 'menu:pay');
    expect(h.last(buyer)).toMatch(/Send the deal code/);
    await h.say(buyer, 'not a code');
    expect(h.last(buyer)).toMatch(/doesn't look like a deal code/);
    await h.say(buyer, code.toLowerCase().replace('-', ''));
    expect(h.last(buyer)).toMatch(new RegExp(`Deal ${code}`));
    expect(h.last(buyer)).toMatch(/\[Pay now\]/);
  });

  it('"Report a problem" with no paid deals offers a person instead', async () => {
    const p = phone();
    await h.tap(p, 'menu:problem');
    expect(h.last(p)).toMatch(/nothing to freeze/);
    expect(h.last(p)).toMatch(/\[Talk to a person\]/);
  });

  it('"Report a problem" with one paid deal freezes it straight away', async () => {
    const seller = phone(), buyer = phone();
    const code = await paidDeal(seller, buyer);
    await h.tap(buyer, 'menu:problem');
    expect(h.last(buyer)).toMatch(new RegExp(`what's wrong with deal ${code}`));
    expect((await h.db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0].status).toBe('DISPUTED');
  });

  it('"Report a problem" with several paid deals lets the buyer pick one', async () => {
    const s1 = phone(), s2 = phone(), buyer = phone();
    const a = await paidDeal(s1, buyer, 'Red dress');
    const b = await paidDeal(s2, buyer, 'Phone case');
    await h.say(buyer, '/problem');
    const body = await lastBody(buyer);
    expect(body.kind).toBe('list');
    const ids = body.sections[0].rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([`problem:${a}`, `problem:${b}`]));
    await h.tap(buyer, `problem:${b}`);
    expect((await h.db.query('SELECT status FROM deals WHERE code=$1', [b])).rows[0].status).toBe('DISPUTED');
    expect((await h.db.query('SELECT status FROM deals WHERE code=$1', [a])).rows[0].status).toBe('FUNDED');
  });

  it('"My payout account" shows and changes where the seller is paid', async () => {
    const p = phone();
    await h.tap(p, 'menu:account');
    expect(h.last(p)).toMatch(/account number and bank/); // none yet: asks for one
    await h.say(p, '0123456789 GTBank');
    await h.tap(p, 'bank:yes');
    expect(h.last(p)).toMatch(/Saved\. New deals will be paid to .*••••6789/);

    await h.tap(p, 'menu:account');
    expect(h.last(p)).toMatch(/We pay you here/);
    await h.tap(p, 'account:change');
    await h.say(p, '9876543210 Kuda');
    await h.tap(p, 'bank:yes');
    expect(h.last(p)).toMatch(/Kuda.*••••3210/);
    const user = await h.db.query('SELECT id FROM users WHERE phone=$1', [p]);
    const acct = await h.app.deals.defaultBankAccount(user.rows[0].id);
    expect(acct?.account_number).toBe('9876543210');
  });

  it('"Talk to a person" saves the message for the team', async () => {
    const p = phone();
    await h.say(p, 'I need to talk to a person');
    expect(h.last(p)).toMatch(/Type your message/);
    await h.say(p, 'Can I use Hoolam for a car?');
    expect(h.last(p)).toMatch(/ref S-\d+/);
    const r = await h.db.query(`SELECT message, status FROM support_requests WHERE phone=$1`, [p]);
    expect(r.rows[0]).toEqual({ message: 'Can I use Hoolam for a car?', status: 'OPEN' });

    const auth = { authorization: 'Bearer test-admin-token-123456' };
    const list = await h.app.app.inject({ method: 'GET', url: '/admin/support', headers: auth });
    expect(list.json().some((x: { phone: string }) => x.phone === p)).toBe(true);
    const id = list.json().find((x: { phone: string }) => x.phone === p).id;
    const sent = await h.app.app.inject({ method: 'POST', url: '/admin/messages/send', headers: auth, payload: { phone: p, text: 'Yes, up to ₦50,000 for now.' } });
    expect(sent.json().status).toBe('DRY_RUN');
    expect(h.last(p)).toMatch(/up to ₦50,000/);
    const closed = await h.app.app.inject({ method: 'POST', url: `/admin/support/${id}/close`, headers: auth });
    expect(closed.json()).toEqual({ ok: true });
  });

  it('finished steps end with a Main menu button', async () => {
    const p = phone();
    await h.tap(p, 'menu:deals');
    expect(h.last(p)).toMatch(/You have no deals yet.*\[Sell something\] \[Main menu\]/s);
    await h.tap(p, 'menu:open');
    expect((await lastBody(p)).kind).toBe('list');
  });
});
