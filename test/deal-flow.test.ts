import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';

let h: Harness;
let seq = 0;

beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });

const people = () => {
  seq++;
  return { seller: `+23480100000${String(seq).padStart(2, '0')}`, buyer: `+23480200000${String(seq).padStart(2, '0')}` };
};

/** Seller creates a ₦15,000 deal through the chat, buyer opens it and asks to pay. Returns the deal code. */
async function dealUpToPayment(seller: string, buyer: string): Promise<{ code: string; ref: string }> {
  await h.say(seller, 'hi', 'Mama Bella');
  await h.tap(seller, 'menu:sell');
  await h.say(seller, 'Sneakers size 42');
  await h.say(seller, '15,000');
  await h.tap(seller, 'sell:nophotos');
  await h.tap(seller, 'sell:nophone');
  if (/account number and bank/.test(h.last(seller))) {
    await h.say(seller, '0123456789 GTBank');
    await h.tap(seller, 'bank:yes');
  }
  await h.tap(seller, 'sell:confirm');
  const code = h.last(seller).match(/HL-[A-Z2-9]{5}/)![0];
  await h.say(buyer, `Pay ${code}`, 'Koffi');
  await h.tap(buyer, `pay:${code}`);
  const r = await h.db.query('SELECT pi.provider_reference FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id WHERE d.code=$1', [code]);
  return { code, ref: r.rows[0].provider_reference };
}

const status = async (code: string) => (await h.db.query('SELECT status FROM deals WHERE code=$1', [code])).rows[0].status;
const ledger = async (code: string) => {
  const r = await h.db.query(
    `SELECT account, SUM(amount_minor)::bigint AS b FROM ledger_entries WHERE deal_id=(SELECT id FROM deals WHERE code=$1) GROUP BY account`, [code]);
  return Object.fromEntries(r.rows.map((x) => [x.account, Number(x.b)]));
};

beforeEach(() => { h.provider.payoutOutcome = 'SUCCESS'; });

describe('the full deal', () => {
  it('seller creates, buyer pays, seller ships, buyer is happy, seller is paid', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    expect(h.last(buyer)).toMatch(/Transfer exactly ₦15,000/); // the seller started the deal, so the seller pays the fee
    expect(await status(code)).toBe('AWAITING_PAYMENT');

    h.provider.pay(ref);
    expect(await h.app.deals.handleCollection(ref)).toBe('funded');
    expect(await status(code)).toBe('FUNDED');
    expect(h.last(seller)).toMatch(/Your ₦14,600 is held safely/);

    await h.tap(seller, `shipped:${code}`);
    expect(h.last(buyer)).toMatch(/on the way/);
    await h.tap(buyer, `happy:${code}`);

    expect(await status(code)).toBe('COMPLETED');
    expect(h.last(seller)).toMatch(/₦14,600 has been sent to your/);
    // Everything held for the deal has been paid out; only Hoolam's ₦400 fee remains as cash.
    expect(await ledger(code)).toEqual({ 'cash:fake': 40_000, 'held:deal': 0, 'payable:seller': 0, 'revenue:fees': -40_000 });
  }, 30_000);

  it('the same payment notification twice only counts once', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref);
    expect(await h.app.deals.handleCollection(ref)).toBe('funded');
    expect(await h.app.deals.handleCollection(ref)).toBe('duplicate');
    expect((await ledger(code))['cash:fake']).toBe(1_500_000);
  }, 30_000);

  it('a webhook before the money actually lands does nothing', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    expect(await h.app.deals.handleCollection(ref)).toBe('pending');
    expect(await status(code)).toBe('AWAITING_PAYMENT');
  }, 30_000);

  it('a short payment is held for refund and the deal is not funded', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref, 1_000_000);
    expect(await h.app.deals.handleCollection(ref)).toBe('partial');
    expect(await status(code)).toBe('AWAITING_PAYMENT');
    expect(h.last(buyer)).toMatch(/We received ₦10,000, but the total is ₦15,000/);
    expect(await ledger(code)).toEqual({ 'cash:fake': 1_000_000, 'payable:buyer': -1_000_000 });
  }, 30_000);

  it('an overpayment funds the deal and keeps the extra owed back to the buyer', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref, 1_600_000);
    expect(await h.app.deals.handleCollection(ref)).toBe('funded');
    expect(await ledger(code)).toEqual({ 'cash:fake': 1_600_000, 'held:deal': -1_500_000, 'payable:buyer': -100_000 });
  }, 30_000);
});

describe('problems and refunds', () => {
  it('buyer reports a problem, gives a refund account, admin refunds everything', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref);
    await h.app.deals.handleCollection(ref);
    await h.tap(seller, `shipped:${code}`);

    await h.tap(buyer, `problem:${code}`);
    expect(await status(code)).toBe('DISPUTED');
    expect(h.last(seller)).toMatch(/reported a problem/);
    await h.say(buyer, 'Wrong size, they sent 40 not 42');
    expect(h.last(buyer)).toMatch(/where should the money go/);
    await h.say(buyer, '8012345678 Opay');
    await h.tap(buyer, 'bank:yes');
    expect(h.last(buyer)).toMatch(/Case C-[A-Z0-9]{6} is open/);

    const dispute = await h.db.query(`SELECT reason, status FROM disputes WHERE deal_id=(SELECT id FROM deals WHERE code=$1)`, [code]);
    expect(dispute.rows[0]).toMatchObject({ reason: 'Wrong size, they sent 40 not 42', status: 'OPEN' });

    await h.app.deals.adminRefund(code, 'Seller sent the wrong size');
    expect(await status(code)).toBe('REFUNDED');
    expect(h.last(buyer)).toMatch(/refund of ₦15,000/);
    expect(await ledger(code)).toEqual({ 'cash:fake': 0, 'held:deal': 0, 'payable:buyer': 0 });
  }, 30_000);

  it('the money cannot move while a problem is open, except by an admin', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref);
    await h.app.deals.handleCollection(ref);
    await h.tap(buyer, `problem:${code}`);
    await h.tap(buyer, `happy:${code}`);
    expect(await status(code)).toBe('DISPUTED');
    expect(h.last(buyer)).toMatch(/isn't available/);
    await h.app.deals.adminRelease(code, 'Buyer confirmed by phone it was fine');
    expect(await status(code)).toBe('COMPLETED');
  }, 30_000);
});

describe('payouts that need a human', () => {
  it('a payout waiting for an OTP parks the deal until an admin approves it', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref);
    await h.app.deals.handleCollection(ref);
    h.provider.payoutOutcome = 'NEEDS_AUTHORIZATION';
    await h.tap(buyer, `happy:${code}`);
    expect(await status(code)).toBe('PAYOUT_PENDING');
    expect(h.last(seller)).toMatch(/payout is being processed/);
    const p = await h.db.query(`SELECT reference FROM payouts WHERE deal_id=(SELECT id FROM deals WHERE code=$1)`, [code]);
    await h.app.deals.authorizePayout(p.rows[0].reference, '123456');
    expect(await status(code)).toBe('COMPLETED');
  }, 30_000);

  it('a failed payout can be retried and only pays once', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    h.provider.pay(ref);
    await h.app.deals.handleCollection(ref);
    h.provider.payoutOutcome = 'FAILED';
    await h.tap(buyer, `happy:${code}`);
    expect(await status(code)).toBe('PAYOUT_PENDING');
    expect((await ledger(code))['payable:seller']).toBe(-1_460_000); // still owed (₦15,000 minus the seller's ₦400 fee)
    h.provider.payoutOutcome = 'SUCCESS';
    const p = await h.db.query(`SELECT reference FROM payouts WHERE deal_id=(SELECT id FROM deals WHERE code=$1)`, [code]);
    await h.app.deals.retryPayout(p.rows[0].reference);
    await h.app.deals.retryPayout(p.rows[0].reference); // second retry is a no-op
    expect(await status(code)).toBe('COMPLETED');
    expect((await ledger(code))['payable:seller']).toBe(0);
  }, 30_000);
});

describe('who can do what', () => {
  it('the seller cannot pay or confirm their own deal; the buyer cannot mark it shipped', async () => {
    const { seller, buyer } = people();
    const { code, ref } = await dealUpToPayment(seller, buyer);
    await h.say(seller, `Pay ${code}`);
    expect(h.last(seller)).toMatch(/your own deal/);
    h.provider.pay(ref);
    await h.app.deals.handleCollection(ref);
    await h.tap(buyer, `shipped:${code}`);
    expect(await status(code)).toBe('FUNDED');
    await h.tap(seller, `happy:${code}`);
    expect(await status(code)).toBe('FUNDED');
  }, 30_000);

  it('a second buyer cannot take over a deal', async () => {
    const { seller, buyer } = people();
    const { code } = await dealUpToPayment(seller, buyer);
    await h.say('+2348099999999', `Pay ${code}`);
    expect(h.last('+2348099999999')).toMatch(/Someone else is already paying/);
  }, 30_000);

  it('the buyer can back out before paying; nothing moves', async () => {
    const { seller, buyer } = people();
    const { code } = await dealUpToPayment(seller, buyer);
    await h.tap(buyer, `cancel:${code}`);
    expect(await status(code)).toBe('CANCELLED');
    expect(h.last(seller)).toMatch(/cancelled/);
    expect(await ledger(code)).toEqual({});
  }, 30_000);

  it('prices above the Phase 1 limit are refused', async () => {
    const { seller } = people();
    await h.tap(seller, 'menu:sell');
    await h.say(seller, 'Laptop');
    await h.say(seller, '2m');
    expect(h.last(seller)).toMatch(/up to ₦50,000/);
  }, 30_000);
});

describe('safety nets', () => {
  it('the database refuses an unbalanced ledger entry', async () => {
    await expect((async () => {
      const c = await h.db.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO ledger_entries (txn_id, account, amount_minor, currency, memo) VALUES (gen_random_uuid(), 'cash:x', 100, 'NGN', 'oops')`);
        await c.query('COMMIT');
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    })()).rejects.toThrow(/does not balance/);
  });

  it('every deal in the system nets to zero across all accounts', async () => {
    const r = await h.db.query('SELECT deal_id, SUM(amount_minor)::bigint AS s FROM ledger_entries GROUP BY deal_id HAVING SUM(amount_minor) <> 0');
    expect(r.rows).toEqual([]);
  });

  it('the WhatsApp webhook answers 200 and ignores a repeated message', async () => {
    const body = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.dup1', from: '2348077777777', type: 'text', text: { body: 'hi' } }] } }] }] };
    const send = () => h.app.app.inject({ method: 'POST', url: '/webhook/whatsapp', payload: body });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const n = await h.db.query(`SELECT count(*)::int AS n FROM webhook_events WHERE event_key='wamid.dup1'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('admin routes need the token', async () => {
    expect((await h.app.app.inject({ method: 'GET', url: '/admin/deals' })).statusCode).toBe(401);
    expect((await h.app.app.inject({ method: 'GET', url: '/admin/deals', headers: { authorization: 'Bearer test-admin-token-123456' } })).statusCode).toBe(200);
  });

  it('messages outside the 24-hour window are held for a template instead of sent', async () => {
    await h.db.query(`INSERT INTO chat_sessions (phone, last_inbound_at) VALUES ('+2348066666666', now() - interval '2 days') ON CONFLICT (phone) DO UPDATE SET last_inbound_at = now() - interval '2 days'`);
    await h.app.messenger.send('+2348066666666', { kind: 'text', text: 'hello' });
    const r = await h.db.query(`SELECT status FROM outbound_messages WHERE phone='+2348066666666' ORDER BY id DESC LIMIT 1`);
    expect(r.rows[0].status).toBe('NEEDS_TEMPLATE');
  });

  it('outside the window, a deal update goes out as its template once Meta has approved it', async () => {
    const { dealTemplate, DEAL_TEMPLATES } = await import('../src/whatsapp/automation.js');
    const phone = '+2348066666667';
    await h.db.query(`INSERT INTO chat_sessions (phone, last_inbound_at) VALUES ($1, now() - interval '3 days') ON CONFLICT (phone) DO UPDATE SET last_inbound_at = now() - interval '3 days'`, [phone]);
    const t = dealTemplate('itemOnTheWay', ['HL-ABCDE'], ['happy:HL-ABCDE', 'problem:HL-ABCDE']);
    expect(t.preview).toMatch(/^Your item for deal HL-ABCDE is on the way/);
    expect(t.buttonPayloads).toEqual(['happy:HL-ABCDE', 'problem:HL-ABCDE']);
    const last = async () => (await h.db.query(`SELECT status, kind, error FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1`, [phone])).rows[0];

    h.app.messenger.setTemplateStatus(t.name, 'PENDING');
    await h.app.messenger.send(phone, { kind: 'text', text: 'on the way' }, t);
    expect(await last()).toMatchObject({ status: 'NEEDS_TEMPLATE', error: expect.stringMatching(/pending/) });

    h.app.messenger.setTemplateStatus(t.name, 'APPROVED');
    await h.app.messenger.send(phone, { kind: 'text', text: 'on the way' }, t);
    expect(await last()).toMatchObject({ status: 'DRY_RUN', kind: 'template' });

    // Meta's rules: no template body starts or ends with a variable; button labels fit in 25 characters
    for (const d of Object.values(DEAL_TEMPLATES) as { body: string; buttons?: string[] }[]) {
      expect(d.body).not.toMatch(/^\{\{|\}\}$/);
      for (const b of d.buttons ?? []) expect(b.length).toBeLessThanOrEqual(25);
    }
  });
});
