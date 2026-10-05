import { buyFlowJson, buyFlowName, sellFlowJson, sellFlowName } from './buy-flow.js';

/**
 * The things WhatsApp shows before anyone types:
 *  - Ice breakers: up to 4 tappable suggestions in a brand-new chat (max 80 characters, no emoji).
 *  - Commands: the list that pops up when someone types "/" (max 30; name up to 32 characters, hint up to 256).
 *  - Welcome message: WhatsApp tells us when someone opens the chat for the first time,
 *    and we answer with the main menu (see the 'welcome' case in flow.ts).
 *
 * Sent to Meta with POST /{phone-number-id}/conversational_automation every time the server starts.
 * If Meta refuses, the reason is logged and you can set the same things by hand in
 * WhatsApp Manager > Phone numbers > (your number) > Automations.
 *
 * Every ice breaker and command here must also be understood in flow.ts (PHRASES and SLASH).
 */
export type MenuItem = 'open' | 'sell' | 'buy' | 'deals' | 'account' | 'pay' | 'problem' | 'how' | 'fees' | 'human';

/**
 * Shown in a brand-new chat. Each one is a first line a real person would say, and where it leads.
 * WhatsApp rules: 4 max, 80 characters max, no emoji. The chat understands these exact words (flow.ts).
 */
export const ICE_BREAKER_STEPS: { text: string; goTo: MenuItem }[] = [
  { text: 'I want to buy something safely', goTo: 'buy' },
  { text: 'A seller sent me a deal code', goTo: 'pay' },
  { text: 'I want to sell something safely', goTo: 'sell' },
  { text: 'How does Hoolam protect my money?', goTo: 'how' },
];
export const ICE_BREAKERS = ICE_BREAKER_STEPS.map((i) => i.text);

/** Typed with "/" at any time. Short hints: they show up in a small pop-up list. */
export const COMMANDS: { name: string; hint: string; goTo: MenuItem }[] = [
  { name: 'menu', hint: 'Everything you can do', goTo: 'open' },
  { name: 'buy', hint: 'Start a safe deal with a seller', goTo: 'buy' },
  { name: 'sell', hint: 'Get a safe-pay link for your buyer', goTo: 'sell' },
  { name: 'pay', hint: 'Pay with a code from a seller', goTo: 'pay' },
  { name: 'deals', hint: 'Where your deals and money are', goTo: 'deals' },
  { name: 'problem', hint: 'Freeze the money on a bad delivery', goTo: 'problem' },
  { name: 'account', hint: 'Where we send your money', goTo: 'account' },
  { name: 'fees', hint: 'What it costs and who pays', goTo: 'fees' },
  { name: 'help', hint: 'How Hoolam keeps you safe', goTo: 'how' },
  { name: 'human', hint: 'Talk to a real person', goTo: 'human' },
];

export interface AutomationOptions {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export function automationPayload() {
  return {
    enable_welcome_message: true,
    prompts: ICE_BREAKERS,
    commands: COMMANDS.map((c) => ({ command_name: c.name, command_description: c.hint })),
  };
}

/** Pushes the ice breakers, commands and welcome setting to Meta. Never throws: returns ok + Meta's answer. */
export async function syncAutomation(o: AutomationOptions): Promise<{ ok: boolean; status: number; body: string }> {
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(`https://graph.facebook.com/${o.graphVersion}/${o.phoneNumberId}/conversational_automation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(automationPayload()),
    });
    const body = (await res.text()).slice(0, 400);
    o.log?.(res.ok
      ? `whatsapp menu sync OK: ${ICE_BREAKERS.length} ice breakers, ${COMMANDS.length} commands, welcome message on`
      : `whatsapp menu sync FAILED (HTTP ${res.status}): ${body}. You can set them by hand in WhatsApp Manager > Automations.`);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    o.log?.(`whatsapp menu sync FAILED: ${(e as Error).message}`);
    return { ok: false, status: 0, body: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------------------------
// The buyer's form and the seller alert also live on Meta. Both are created automatically on start
// (needs WHATSAPP_WABA_ID). If anything fails, the chat questions and the forwarded link still work.
// ---------------------------------------------------------------------------------------------

export interface MetaSetupOptions extends AutomationOptions { wabaId: string; formMode: 'draft' | 'published' }

/** The seller alert. Utility template: strictly about the order, nothing promotional. */
export const SELLER_ALERT = {
  name: 'hoolam_order_request',
  body:
    '🛒 New order request on Hoolam\n\n{{1}} wants to buy {{2}} from you for {{3}}.\n\n' +
    'They pay Hoolam first. You ship once the money is held, and you get paid when they are happy.\n\n' +
    'Deal {{4}}. Tap below to see the photos and accept.',
  example: ['Ada', 'Black sneakers, size 42', '₦15,000', 'HL-7K2QF'],
  footer: 'Not expecting this? Tap Not me.',
  buttons: ['View deal', 'Not me'],
};

/** The buyer alert (a seller started the deal and typed the buyer's number). */
export const BUYER_ALERT = {
  name: 'hoolam_payment_request',
  body:
    '💳 Payment request on Hoolam\n\n{{1}} is selling you {{2}} for {{3}}.\n\n' +
    'You pay Hoolam, not the seller. We hold the money until you receive the item and are happy.\n\n' +
    'Deal {{4}}. Tap below to see the photos and pay.',
  example: ['Bayo', 'Black sneakers, size 42', '₦15,000', 'HL-7K2QF'],
  footer: 'Not expecting this? Tap Not me.',
  buttons: ['View deal', 'Not me'],
};

export type TemplateDef = typeof SELLER_ALERT;

async function graph(o: AutomationOptions, method: 'GET' | 'POST', path: string, body?: unknown) {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`https://graph.facebook.com/${o.graphVersion}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${o.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 400) };
}

/** Makes sure the seller-alert template exists. Returns its status (APPROVED, PENDING, REJECTED) or null. */
export async function ensureSellerAlertTemplate(o: MetaSetupOptions): Promise<string | null> {
  return ensureTemplate(o, SELLER_ALERT, 'seller alert');
}

/** Makes sure an alert template exists on Meta. Returns its status (APPROVED, PENDING, REJECTED) or null. */
export async function ensureTemplate(o: MetaSetupOptions, t: TemplateDef, label: string): Promise<string | null> {
  const found = await graph(o, 'GET', `${o.wabaId}/message_templates?name=${t.name}&fields=name,status,category,language`);
  const existing = found.ok ? (found.json?.data ?? []).find((x: { name: string }) => x.name === t.name) : null;
  if (existing) {
    o.log?.(`${label} template: ${existing.status}${existing.status === 'APPROVED' ? '' : ' (alerts start once Meta approves it)'}`);
    return existing.status;
  }
  const created = await graph(o, 'POST', `${o.wabaId}/message_templates`, {
    name: t.name, language: 'en', category: 'UTILITY', parameter_format: 'positional',
    components: [
      { type: 'BODY', text: t.body, example: { body_text: [t.example] } },
      { type: 'FOOTER', text: t.footer },
      { type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  });
  if (!created.ok) {
    o.log?.(`${label} template FAILED to create (HTTP ${created.status}): ${created.text}`);
    return null;
  }
  o.log?.(`${label} template submitted to Meta: ${created.json?.status ?? 'PENDING'} (category ${created.json?.category ?? '?'})`);
  return created.json?.status ?? 'PENDING';
}

/** Makes sure the buyer's form exists on Meta. Returns its id, or null (then the chat questions are used). */
export async function ensureBuyFlow(o: MetaSetupOptions, json = buyFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, buyFlowName(json), 'buyer form');
}

/** Makes sure the seller's form exists on Meta. */
export async function ensureSellFlow(o: MetaSetupOptions, json = sellFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, sellFlowName(json), 'seller form');
}

async function ensureFlow(o: MetaSetupOptions, json: object, name: string, label: string): Promise<string | null> {
  const list = await graph(o, 'GET', `${o.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
  if (!list.ok) { o.log?.(`${label}: can't list forms (HTTP ${list.status}): ${list.text}`); return null; }
  const existing = (list.json?.data ?? []).find((x: { name: string }) => x.name === name);
  if (existing) {
    const errs: { message?: string }[] = existing.validation_errors ?? [];
    if (errs.length) {
      o.log?.(`${label} FAILED: ${name} has ${errs.length} problem(s): ${errs.map((e) => e.message).join(' | ').slice(0, 600)}`);
      return null;
    }
    o.log?.(`${label} ready: ${name} (${existing.status}, sending as ${o.formMode})`);
    return existing.id;
  }
  const created = await graph(o, 'POST', `${o.wabaId}/flows`, {
    name, categories: ['OTHER'], flow_json: JSON.stringify(json), publish: o.formMode === 'published',
  });
  if (!created.ok || !created.json?.id) {
    o.log?.(`${label} FAILED to create (HTTP ${created.status}): ${created.text}`);
    return null;
  }
  const errors: { message?: string }[] = created.json.validation_errors ?? [];
  if (errors.length) {
    // Never send a broken form: buyers answer in the chat until it's fixed.
    o.log?.(`${label} FAILED: Meta found ${errors.length} problem(s): ${errors.map((e) => e.message).join(' | ').slice(0, 600)}`);
    return null;
  }
  o.log?.(`${label} created: ${name} (${o.formMode})`);
  return created.json.id;
}
