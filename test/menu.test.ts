import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { automationPayload, COMMANDS, ICE_BREAKERS, syncAutomation } from '../src/whatsapp/automation.js';
import { checkLimits, toPayload } from '../src/whatsapp/client.js';
import { parseInbound } from '../src/whatsapp/inbound.js';
import { BUYER_MENU, msg, SELLER_MENU } from '../src/whatsapp/messages.js';

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
  await h.sell(seller);
  await h.say(seller, item);
  await h.say(seller, '10000');
  await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone');
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
    expect(() => checkLimits(msg.menu('Ada Obi', 'seller', msg.switchedTo('seller')))).not.toThrow();
    expect(() => checkLimits(msg.welcome('Ada Obi'))).not.toThrow();
    expect(() => checkLimits(msg.help())).not.toThrow();
    expect(() => checkLimits(msg.setupIntro('Ada'))).not.toThrow();
    expect(() => checkLimits(msg.setupDone('card', false))).not.toThrow();
    expect(m.kind).toBe('list');
    for (const menu of [BUYER_MENU, SELLER_MENU]) expect(menu.flatMap((s) => s.rows).length).toBe(8);
    expect(BUYER_MENU.flatMap((s) => s.rows.map((r) => r.id))).toEqual(['menu:buy', 'menu:pay', 'menu:orders', 'menu:check', 'menu:problem', 'menu:how', 'menu:human', 'menu:tosell']);
    expect(SELLER_MENU.flatMap((s) => s.rows.map((r) => r.id))).toEqual(['menu:sell', 'menu:orders', 'menu:card', 'menu:account', 'menu:problem', 'menu:how', 'menu:human', 'menu:tobuy']);
  });

  it('builds the WhatsApp list payload', () => {
    const p = toPayload('2348000000000', msg.menu(null)) as any;
    expect(p.type).toBe('interactive');
    expect(p.interactive.type).toBe('list');
    expect(p.interactive.action.button).toBe('Open menu');
    expect(p.interactive.action.sections[0].rows[0]).toEqual({ id: 'menu:buy', title: '🛒 Buy something', description: expect.any(String) });
    expect(p.interactive.header).toEqual({ type: 'text', text: '🛒 Buying' });
    const w = toPayload('2348000000000', msg.welcome(null)) as any;
    expect(w.interactive.type).toBe('button');
    expect(w.interactive.body.text).toMatch(/Welcome to Hoolam/);
    expect(w.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['menu:tobuy', 'menu:sell', 'menu:how']);
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
  it('first contact tells the story once; after that "hi" is short', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Ada Obi');
    const first = await lastBody(p);
    expect(first.kind).toBe('buttons');
    expect(h.last(p)).toMatch(/Hi Ada 👋 \*Welcome to Hoolam\*/);
    expect(h.last(p)).toMatch(/Hoolam holds the money/);
    expect(h.last(p)).toMatch(/\[🛒 I’m buying\] \[🏷️ I’m selling\] \[💡 How it works\]/);
    await h.say(p, 'hi');
    const again = await lastBody(p);
    expect(again.kind).toBe('list');
    expect(again.header).toBe('🛒 Buying');
    expect(h.last(p)).toMatch(/What would you like to do/);

    const q = phone();
    await h.app.chat.handle({ id: `wel-${q}`, phone: q, name: 'Bayo', type: 'welcome', text: '', buttonId: null, mediaId: null });
    expect(h.last(q)).toMatch(/Welcome to Hoolam/);
  });

  it('someone new who already knows what they want skips the welcome', async () => {
    const p = phone();
    await h.say(p, 'I want to sell something safely'); // ice breaker: straight to the one-time seller setup
    expect(h.last(p)).toMatch(/Set up as a seller/);
    const q = phone();
    await h.say(q, '/fees');
    expect(h.last(q)).toMatch(/Fees/);
  });

  it('every ice breaker and command leads somewhere', async () => {
    for (const t of ICE_BREAKERS) {
      const p = phone();
      await h.say(p, t);
        expect(h.last(p)).not.toMatch(/Welcome to Hoolam/); // not the generic welcome
    }
    for (const c of COMMANDS) {
      const p = phone();
      await h.say(p, 'hi');
      await h.say(p, '/' + c.name);
      expect(h.last(p)).not.toMatch(/didn't get that/);
    }
  });

  it('unknown text shows the menu instead of a dead end', async () => {
    const p = phone();
    await h.say(p, 'hi');
    await h.say(p, 'abeg wetin dey happen');
    expect((await lastBody(p)).kind).toBe('list');
  });

  it('slash commands and ice-breaker phrases work', async () => {
    const p = phone();
    await h.say(p, '/fees');
    expect(h.last(p)).toMatch(/2\.5%\* of the price/);
    expect(h.last(p)).toMatch(/₦15,000 item → fee ₦400/);
    expect(h.last(p)).toMatch(/\[Main menu\]/);
    await h.say(p, '/help');
    expect(h.last(p)).toMatch(/One payment, start to finish/);
    await h.say(p, 'I want to sell something safely');
    expect(h.last(p)).toMatch(/Set up as a seller/);
    await h.say(p, '/menu'); // leaves the setup
    expect(await state(p)).toBe('IDLE');
    await h.say(p, 'How does Hoolam protect my money?');
    expect(h.last(p)).toMatch(/One payment, start to finish/);
    await h.tap(p, 'menu:help'); // the old button id still works
    expect(h.last(p)).toMatch(/One payment, start to finish/);
  });

  it('"Pay for a deal" asks for the code, then opens the deal', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi'); await h.sell(seller); await h.say(seller, 'Shoes'); await h.say(seller, '8000');
    await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone');
    await h.say(seller, '0123456789 Opay'); await h.tap(seller, 'bank:yes'); await h.tap(seller, 'sell:confirm');
    const code = h.last(seller).match(/HL-[A-Z2-9]{5}/)![0];

    await h.tap(buyer, 'menu:pay');
    expect(h.last(buyer)).toMatch(/Send the order code/);
    await h.say(buyer, 'not a code');
    expect(h.last(buyer)).toMatch(/doesn't look like an order code/);
    await h.say(buyer, code.toLowerCase().replace('-', ''));
    expect(h.last(buyer)).toMatch(new RegExp(`Order ${code}`));
    expect(h.last(buyer)).toMatch(/Pay now\]/);
  });

  it('"Report a problem" with no paid deals offers a person instead', async () => {
    const p = phone();
    await h.tap(p, 'menu:problem');
    expect(h.last(p)).toMatch(/no money to freeze/);
    expect(h.last(p)).toMatch(/\[🙋 Talk to a rep\]/);
  });

  it('"Report a problem" with one paid deal freezes it straight away', async () => {
    const seller = phone(), buyer = phone();
    const code = await paidDeal(seller, buyer);
    await h.tap(buyer, 'menu:problem');
    expect(h.last(buyer)).toMatch(new RegExp(`what's wrong with order ${code}`));
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
    expect(h.last(p)).toMatch(/Saved\. New orders pay into .*••••6789/);

    await h.tap(p, 'menu:account');
    expect(h.last(p)).toMatch(/We send your money here/);
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
    await h.say(p, 'I want to talk to a person');
    expect(h.last(p)).toMatch(/Type your message/);
    await h.say(p, 'Can I use Hoolam for a car?');
    expect(h.last(p)).toMatch(/Ref S-\d+/);
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
    expect(h.last(p)).toMatch(/You haven’t bought anything with Hoolam yet.*\[🛒 Buy something\] \[Main menu\]/s);
    await h.tap(p, 'menu:open');
    expect((await lastBody(p)).kind).toBe('list');
  });
});

describe('buying and selling menus', () => {
  const header = async (p: string) => (await lastBody(p)).header;
  const user = async (p: string) => (await h.db.query('SELECT seller_since, menu_mode, business_name, city FROM users WHERE phone=$1', [p])).rows[0];

  it('everyone starts on the buying menu; "I\'m buying" from the welcome opens it', async () => {
    const p = phone();
    await h.say(p, 'hello there', 'Chidi Okafor');
    await h.tap(p, 'menu:tobuy');
    expect(await header(p)).toBe('🛒 Buying');
    expect(h.last(p)).not.toMatch(/menu now/); // nothing switched
    expect((await user(p)).seller_since).toBeNull();
  });

  it('"I\'m selling": two quick questions create the trust card, then straight into the first sale', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Ngozi Eze');
    await h.tap(p, 'menu:sell');
    expect(h.last(p)).toMatch(/Set up as a seller/);
    expect(h.last(p)).toMatch(/Or keep the name from your WhatsApp: \*Ngozi\*/);
    await h.say(p, 'Ngozi Bags');
    expect(h.last(p)).toMatch(/Which city/);
    await h.say(p, 'Port Harcourt');
    const t = h.transcript.filter((x) => x.phone === p).map((x) => x.text);
    expect(t.at(-2)).toMatch(/Your trust card is ready[\s\S]*Ngozi Bags\* · Port Harcourt[\s\S]*your first sale/);
    expect(h.last(p)).toMatch(/What are you selling/);
    expect(await user(p)).toMatchObject({ menu_mode: 'seller', business_name: 'Ngozi Bags', city: 'Port Harcourt' });
    expect((await user(p)).seller_since).not.toBeNull();

    await h.say(p, 'menu');
    expect(await header(p)).toBe('🏷️ Selling');
    await h.tap(p, 'menu:sell'); // no setup the second time
    expect(h.last(p)).toMatch(/What are you selling/);
  });

  it('"Use this name" and Skip keep setup to two taps', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Tunde Bakare');
    await h.tap(p, 'menu:tosell');
    await h.tap(p, 'setup:wname');
    await h.tap(p, 'setup:nocity');
    expect(h.last(p)).toMatch(/Your trust card is ready[\s\S]*Tunde/);
    expect(h.last(p)).toMatch(/\[🏷️ Sell something\] \[Main menu\]/);
    expect((await user(p)).business_name).toBeNull(); // keeps showing the WhatsApp name
  });

  it('switching moves between the menus; a seller keeps their card', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Ada');
    await h.sell(p);
    await h.say(p, '/menu');
    expect(await header(p)).toBe('🏷️ Selling');
    await h.tap(p, 'menu:tobuy');
    expect(await header(p)).toBe('🛒 Buying');
    expect(h.last(p)).toMatch(/buying\* menu now/);
    await h.say(p, 'hi');
    expect(await header(p)).toBe('🛒 Buying'); // remembered
    await h.tap(p, 'menu:tosell');
    expect(await header(p)).toBe('🏷️ Selling'); // no setup again
    expect(h.last(p)).toMatch(/selling\* menu now/);
    await h.say(p, '/switch');
    expect(await header(p)).toBe('🛒 Buying');
  });

  it('the menu follows the last order: paying with a code puts you on buying, accepting an order on selling', async () => {
    const seller = phone(), buyer = phone();
    const code = await paidDeal(seller, buyer);
    await h.say(buyer, 'hi');
    expect(await header(buyer)).toBe('🛒 Buying');
    await h.say(seller, 'hi');
    expect(await header(seller)).toBe('🏷️ Selling');
    expect(code).toMatch(/^HL-/);

    // a buyer starts an order and names a seller who has never used Hoolam: accepting makes them a seller, no setup
    const b2 = phone(), s2 = phone();
    await h.say(b2, 'hi', 'Kemi');
    await h.tap(b2, 'menu:buy'); await h.say(b2, 'Wig'); await h.say(b2, 'Brand new, in the box'); await h.tap(b2, 'cat:other'); await h.say(b2, '20000'); await h.tap(b2, 'dlv:free');
    await h.tap(b2, 'buy:nophotos'); await h.say(b2, s2); await h.tap(b2, 'buy:send');
    const c2 = (await h.db.query("SELECT code FROM deals d JOIN users u ON u.id=d.buyer_id WHERE u.phone=$1", [b2])).rows[0].code;
    await h.tap(s2, `sview:${c2}`);
    await h.tap(s2, `saccept:${c2}`);
    if (/account number and bank/.test(h.last(s2))) { await h.say(s2, '0123456789 GTBank'); await h.tap(s2, 'bank:yes'); }
    expect((await user(s2)).seller_since).not.toBeNull();
    await h.say(s2, 'menu');
    expect(await header(s2)).toBe('🏷️ Selling');
  });

  it('"My orders" shows what you bought on buying, and what you sold on selling', async () => {
    const seller = phone(), buyer = phone();
    const code = await paidDeal(seller, buyer, 'Green kaftan');
    await h.tap(buyer, 'menu:orders');
    expect(h.last(buyer)).toMatch(new RegExp(`Your orders:[\\s\\S]*${code}\\* · Green kaftan\\n₦10,\\d{3} · paid, money held`));
    await h.tap(seller, 'menu:orders');
    expect(h.last(seller)).toMatch(new RegExp(`Orders you’re selling:[\\s\\S]*${code}\\* · Green kaftan\\n₦9,\\d{3} · paid, money held`));
    await h.tap(seller, 'menu:tobuy');
    await h.tap(seller, 'menu:orders');
    expect(h.last(seller)).toMatch(/haven’t bought anything/);
  });

  it('a seller\'s "Report a problem" goes to a rep, tagged with the order', async () => {
    const seller = phone(), buyer = phone();
    const code = await paidDeal(seller, buyer, 'Speaker');
    await h.tap(seller, 'menu:problem');
    expect(h.last(seller)).toMatch(new RegExp(`What's wrong with order ${code}`));
    await h.say(seller, 'Buyer is not picking up the delivery calls');
    expect(h.last(seller)).toMatch(/Ref S-\d+/);
    const r = await h.db.query('SELECT message FROM support_requests WHERE phone=$1', [seller]);
    expect(r.rows[0].message).toBe(`[Order ${code}] Buyer is not picking up the delivery calls`);
    expect((await h.db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0].status).toBe('FUNDED'); // nothing frozen by the seller
  });

  it('"My trust card" for someone who has never sold starts the setup, then shows the card', async () => {
    const p = phone();
    await h.say(p, 'hi', 'Femi');
    await h.say(p, '/card');
    expect(h.last(p)).toMatch(/Set up as a seller/);
    await h.tap(p, 'setup:wname'); await h.tap(p, 'setup:nocity');
    expect(h.last(p)).toMatch(/This is what buyers see before they pay/);
  });
});
