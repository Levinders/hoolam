import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { ensureBuyFlow } from '../src/whatsapp/automation.js';
import { FormRegistry, metaReason } from '../src/whatsapp/forms.js';

const REFUSAL = 'HTTP 400: {"error":{"message":"(#131009) Parameter value is not valid","code":131009,"error_data":{"messaging_product":"whatsapp","details":"The flow is not in a draft state, but the mode is set to \'draft\'."}}}';

describe('forms are sent the way Meta has them', () => {
  const meta = (status: string) => (async (url: string) => {
    if (url.includes('/flows?')) return new Response(JSON.stringify({ data: [{ id: 'f1', name: (await import('../src/whatsapp/buy-flow.js')).buyFlowName(), status, validation_errors: [] }] }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const base = { token: 't', phoneNumberId: '1', graphVersion: 'v26.0', wabaId: '9' };

  it('a published form is sent as published, even with WHATSAPP_FORM_MODE=draft', async () => {
    const got: any[] = [];
    expect(await ensureBuyFlow({ ...base, formMode: 'draft', fetchImpl: meta('PUBLISHED'), report: (r) => got.push(r) })).toBe('f1');
    expect(got[0]).toMatchObject({ id: 'f1', status: 'PUBLISHED', error: null });
    const forms = new FormRegistry();
    forms.ready('buy', { flowId: 'f1', name: got[0].name, status: got[0].status });
    expect(forms.use('buy')).toEqual({ flowId: 'f1', mode: 'published' });
  });

  it('a draft form is published, and sent as published', async () => {
    const got: any[] = [];
    await ensureBuyFlow({ ...base, fetchImpl: meta('DRAFT'), report: (r) => got.push(r) });
    expect(got[0].status).toBe('PUBLISHED');
  });

  it('if Meta won\'t publish it yet, it\'s still sent, as a draft', async () => {
    const got: any[] = [];
    const noPublish = (async (url: string) => {
      if (url.includes('/flows?')) return new Response(JSON.stringify({ data: [{ id: 'f1', name: (await import('../src/whatsapp/buy-flow.js')).buyFlowName(), status: 'DRAFT', validation_errors: [] }] }), { status: 200 });
      return new Response('{"error":{"message":"Business not verified"}}', { status: 400 });
    }) as unknown as typeof fetch;
    expect(await ensureBuyFlow({ ...base, fetchImpl: noPublish, report: (r) => got.push(r) })).toBe('f1');
    expect(got[0].status).toBe('DRAFT');
    expect(got[0].error).toMatch(/wouldn't publish it yet[\s\S]*Business not verified/);
    const forms = new FormRegistry();
    forms.ready('buy', { flowId: 'f1', name: got[0].name, status: got[0].status, note: got[0].error });
    expect(forms.get('buy')).toMatchObject({ state: 'ready', mode: 'draft', reason: expect.stringMatching(/wouldn't publish/) });
  });

  it('a blocked form is not sent, with the reason', async () => {
    const got: any[] = [];
    expect(await ensureBuyFlow({ ...base, formMode: 'draft', fetchImpl: meta('BLOCKED'), report: (r) => got.push(r) })).toBeNull();
    expect(got[0]).toMatchObject({ id: null, error: 'The form is blocked on Meta' });
  });
});

describe('a refused form rests, then comes back', () => {
  it('only that form rests for 30 minutes, with Meta\'s reason; "Try again now" wakes it', () => {
    let now = Date.UTC(2026, 9, 13, 9, 0);
    const forms = new FormRegistry(30, () => now);
    forms.ready('buy', { flowId: 'b', name: 'hoolam_buy_x', status: 'PUBLISHED' });
    forms.ready('sell', { flowId: 's', name: 'hoolam_sell_x', status: 'PUBLISHED' });
    forms.refused('buy', REFUSAL);
    expect(forms.use('buy')).toBeNull();
    expect(forms.use('sell')).toEqual({ flowId: 's', mode: 'published' }); // the others carry on
    expect(forms.get('buy')).toMatchObject({ state: 'resting', reason: 'The flow is not in a draft state, but the mode is set to \'draft\'.' });
    now += 29 * 60_000;
    expect(forms.use('buy')).toBeNull();
    now += 2 * 60_000;
    expect(forms.use('buy')).toEqual({ flowId: 'b', mode: 'published' });
    forms.refused('buy', 'whatever');
    forms.wake();
    expect(forms.get('buy').state).toBe('ready');
    expect(metaReason('not json at all')).toBe('not json at all');
  });
});

describe('in the chat', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
  afterAll(async () => { await h?.stop(); });

  it('a refused buyer form: the chat asks instead, only the buyer form rests, the seller form still goes', async () => {
    h.app.setBuyForm({ flowId: 'b1', mode: 'draft' });
    h.app.setSellForm({ flowId: 's1', mode: 'published' });
    const m = h.app.messenger as any;
    const real = m.send.bind(m);
    m.send = async (phone: string, out: any, fb?: any) => {
      if (out.kind === 'form' && out.flowId === 'b1') {
        await h.db.query(`INSERT INTO outbound_messages (phone, kind, body, status, error) VALUES ($1,'form',$2,'FAILED',$3)`, [phone, JSON.stringify(out), REFUSAL]);
        return 'FAILED';
      }
      return real(phone, out, fb);
    };
    try {
      const p = '+2348090000001';
      await h.say(p, 'hi', 'Ada');
      await h.tap(p, 'menu:buy');
      expect(h.last(p)).toMatch(/What are you buying\?/);
      expect(h.app.forms.get('buy')).toMatchObject({ state: 'resting', reason: expect.stringMatching(/not in a draft state/) });
      expect(h.app.forms.get('sell').state).toBe('ready');
      await h.sell(p);
      expect(h.last(p)).toMatch(/\[form s1\]|Sell safely|Start my order/);
    } finally { m.send = real; }
  });
});
