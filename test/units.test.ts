import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DealStatus, TRANSITIONS, canMove } from '../src/deals/states.js';
import { formatMoney, parseAmount } from '../src/money.js';
import { FakeProvider } from '../src/payments/fake.js';
import { MonnifyProvider } from '../src/payments/monnify.js';
import { quote } from '../src/pricing.js';
import { matchBank, parseBankInput } from '../src/whatsapp/flow.js';
import { normalizePhone, parseInbound, verifyMetaSignature } from '../src/whatsapp/inbound.js';

const naira = (n: number) => n * 100;

describe('pricing (naira, 2.5%, min ₦300, cap ₦5,000, nearest ₦100)', () => {
  it.each([
    [10_000, 300, 10_300],   // 250 → 300
    [15_000, 400, 15_400],   // 375 → 400
    [5_000, 300, 5_300],     // 125 → minimum
    [40_000, 1_000, 41_000], // exact
    [300_000, 5_000, 305_000], // 7,500 → cap
  ])('₦%i → fee ₦%i, buyer pays ₦%i', (price, fee, total) => {
    const q = quote(naira(price), 'NGN');
    expect(q.feeMinor).toBe(naira(fee));
    expect(q.buyerPaysMinor).toBe(naira(total));
    expect(q.sellerGetsMinor).toBe(naira(price));
  });
  it('seller pays when buyerShare = 0', () => {
    const q = quote(naira(10_000), 'NGN', { ratePercent: 2.5, min: 300, max: 5000, roundTo: 100, buyerShare: 0 });
    expect(q.buyerPaysMinor).toBe(naira(10_000));
    expect(q.sellerGetsMinor).toBe(naira(9_700));
  });
  it('split keeps both parts in round hundreds and adding up to the fee', () => {
    const q = quote(naira(15_000), 'NGN', { ratePercent: 2.5, min: 300, max: 5000, roundTo: 100, buyerShare: 0.5 });
    expect(q.feeMinor).toBe(naira(400));
    expect(q.buyerPaysMinor - q.priceMinor + (q.priceMinor - q.sellerGetsMinor)).toBe(q.feeMinor);
  });
  it('rejects non-integer or zero prices', () => {
    expect(() => quote(0, 'NGN')).toThrow();
    expect(() => quote(10.5, 'NGN')).toThrow();
  });
});

describe('money', () => {
  it.each([['15000', 15000], ['15,000', 15000], ['15k', 15000], ['₦15 000', 15000], ['N15000', 15000], ['1.5m', 1_500_000], ['15000 naira', 15000]])('parses %s', (t, v) => {
    expect(parseAmount(t)).toBe(v);
  });
  it.each(['', 'abc', '-5', '0', 'fifteen'])('rejects "%s"', (t) => expect(parseAmount(t)).toBeNull());
  it('formats naira and CFA', () => {
    expect(formatMoney(1_540_000, 'NGN')).toBe('₦15,400');
    expect(formatMoney(1_540_050, 'NGN')).toBe('₦15,400.50');
    expect(formatMoney(10_300, 'XOF')).toBe('10 300 CFA');
  });
});

describe('deal states', () => {
  it('closed deals can never move again', () => {
    for (const s of ['COMPLETED', 'REFUNDED', 'CANCELLED'] as const) expect(TRANSITIONS[s]).toEqual([]);
  });
  it('money can only reach the seller after the buyer or an admin releases it', () => {
    const into = (to: DealStatus) => (Object.keys(TRANSITIONS) as DealStatus[]).filter((f) => canMove(f, to));
    expect(into('RELEASING').sort()).toEqual(['DISPUTED', 'PAYOUT_PENDING', 'SHIPPED']);
    expect(into('COMPLETED').sort()).toEqual(['PAYOUT_PENDING', 'RELEASING']);
  });
  it('a funded deal cannot be cancelled', () => expect(canMove('FUNDED', 'CANCELLED')).toBe(false));
});

describe('WhatsApp inbound', () => {
  it('verifies the Meta signature over the raw body', () => {
    const body = '{"a":1}';
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(body).digest('hex');
    expect(verifyMetaSignature(body, sig, 'shh')).toBe(true);
    expect(verifyMetaSignature(body + ' ', sig, 'shh')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'shh')).toBe(false);
  });
  it('parses text and button replies, ignores status updates', () => {
    const msgs = parseInbound({ entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '2348011111111', profile: { name: 'Ada' } }],
      messages: [
        { id: 'w1', from: '2348011111111', type: 'text', text: { body: 'hi' } },
        { id: 'w2', from: '2348011111111', type: 'interactive', interactive: { button_reply: { id: 'pay:HL-ABCDE', title: 'Pay now' } } },
      ],
      statuses: [{ id: 'x', status: 'read' }],
    } }] }] });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ phone: '+2348011111111', name: 'Ada', type: 'text', text: 'hi' });
    expect(msgs[1]).toMatchObject({ type: 'button', buttonId: 'pay:HL-ABCDE' });
  });
  it.each([['08012345678', '+2348012345678'], ['2348012345678', '+2348012345678'], ['+234 801 234 5678', '+2348012345678'], ['12345', null]])('normalises %s', (i, o) => {
    expect(normalizePhone(i)).toBe(o);
  });
});

describe('bank input', () => {
  const banks = [
    { code: '058', name: 'Guaranty Trust Bank' }, { code: '999992', name: 'Paycom (OPay)' }, { code: '50211', name: 'Kuda Microfinance Bank' },
    { code: '033', name: 'United Bank for Africa' }, { code: '011', name: 'First Bank of Nigeria' }, { code: '50515', name: 'Moniepoint Microfinance Bank' },
  ];
  it.each([['GTBank', '058'], ['gtb', '058'], ['opay', '999992'], ['Kuda', '50211'], ['UBA', '033'], ['first bank', '011'], ['moniepoint mfb', '50515']])('%s → %s', (input, code) => {
    expect(matchBank(input, banks)?.code).toBe(code);
  });
  it('returns null for unknown banks', () => expect(matchBank('Bank of Mars', banks)).toBeNull());
  it('reads Send your account number|account number in either order', () => {
    expect(parseBankInput('0123456789 GTBank')).toEqual({ accountNumber: '0123456789', bankText: 'GTBank' });
    expect(parseBankInput('Opay - 8012345678')).toEqual({ accountNumber: '8012345678', bankText: 'Opay' });
    expect(parseBankInput('GTBank')).toBeNull();
  });
});

describe('Monnify provider', () => {
  const mk = (handler: (url: string, init: RequestInit) => unknown, requireSignature = false) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(handler(url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const p = new MonnifyProvider({ baseUrl: 'https://sandbox.monnify.com', apiKey: 'k', secretKey: 'secret', contractCode: 'C1', walletAccountNumber: 'W1', requireSignature, fetchImpl });
    return { p, calls };
  };
  const ok = (body: unknown) => ({ requestSuccessful: true, responseMessage: 'success', responseCode: '0', responseBody: body });

  it('logs in once, creates a transfer account, and sends amounts in naira', async () => {
    const { p, calls } = mk((url) => {
      if (url.endsWith('/auth/login')) return ok({ accessToken: 'T', expiresIn: 3600 });
      if (url.includes('init-transaction')) return ok({ transactionReference: 'MNFY|1' });
      return ok({ accountNumber: '7727632865', accountName: 'Hoolam', bankName: 'Moniepoint Microfinance Bank', accountDurationSeconds: 2400 });
    });
    const r = await p.createCollection({ paymentReference: 'HL-1', amountMinor: 1_540_000, currency: 'NGN', description: 'x', customerName: 'Ada', customerEmail: 'a@b.c' });
    expect(r).toMatchObject({ providerReference: 'MNFY|1', accountNumber: '7727632865' });
    expect(calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(1);
    const init = JSON.parse(String(calls[1]!.init.body));
    expect(init).toMatchObject({ amount: 15400, contractCode: 'C1', currencyCode: 'NGN', paymentMethods: ['ACCOUNT_TRANSFER'] });
    expect(calls[1]!.init.headers).toMatchObject({ Authorization: 'Bearer T' });
  });

  it('maps transaction status and converts amountPaid to kobo', async () => {
    const { p } = mk((url) => (url.endsWith('/auth/login') ? ok({ accessToken: 'T' }) : ok({ paymentStatus: 'PARTIALLY_PAID', amountPaid: 5000.5, transactionReference: 'MNFY|1', paymentReference: 'HL-1' })));
    expect(await p.checkCollection('MNFY|1')).toEqual({ status: 'PARTIAL', amountPaidMinor: 500_050, providerReference: 'MNFY|1', paymentReference: 'HL-1' });
  });

  it('maps payout statuses including OTP authorisation', async () => {
    const { p } = mk((url) => (url.endsWith('/auth/login') ? ok({ accessToken: 'T' }) : ok({ status: 'PENDING_AUTHORIZATION', reference: 'R1' })));
    expect((await p.sendPayout({ reference: 'R1', amountMinor: 100_00, currency: 'NGN', bankCode: '058', accountNumber: '0123456789', accountName: 'A', narration: 'n' })).status).toBe('NEEDS_AUTHORIZATION');
  });

  it('accepts only correctly signed webhooks when a signature is present', () => {
    const { p } = mk(() => ({}));
    const body = JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { transactionReference: 'MNFY|9', paymentReference: 'HL-9' } });
    const good = createHmac('sha512', 'secret').update(body).digest('hex');
    expect(p.parseWebhook(body, { 'monnify-signature': good })).toMatchObject({ kind: 'collection', providerReference: 'MNFY|9' });
    expect(p.parseWebhook(body, { 'monnify-signature': 'bad' })).toBeNull();
    expect(p.parseWebhook(body, {})).not.toBeNull(); // sandbox sends no signature
    expect(mk(() => ({}), true).p.parseWebhook(body, {})).toBeNull(); // production requires it
  });
});

describe('fake provider', () => {
  it('reports partial and overpaid transfers', async () => {
    const f = new FakeProvider();
    const c = await f.createCollection({ paymentReference: 'r', amountMinor: 1000, currency: 'NGN', description: '', customerName: 'x', customerEmail: 'x@y.z' });
    f.pay(c.providerReference, 400);
    expect((await f.checkCollection(c.providerReference)).status).toBe('PARTIAL');
    f.pay(c.providerReference, 700);
    expect((await f.checkCollection(c.providerReference)).status).toBe('OVERPAID');
  });
});
