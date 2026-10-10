import { createHash } from 'node:crypto';
import { buyFlowJson, buyFlowName, sellFlowJson, sellFlowName } from './buy-flow.js';
import { ordersFlowJson } from './orders-flow.js';
import type { Template } from './client.js';

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
export type MenuItem = 'open' | 'sell' | 'buy' | 'orders' | 'deals' | 'account' | 'pay' | 'problem' | 'how' | 'fees' | 'human' | 'card' | 'check' | 'tosell' | 'tobuy' | 'switch';

/**
 * Shown in a brand-new chat. Each one is a first line a real person would say, and where it leads.
 * WhatsApp rules: 4 max, 80 characters max, no emoji. The chat understands these exact words (flow.ts).
 */
export const ICE_BREAKER_STEPS: { text: string; goTo: MenuItem }[] = [
  { text: 'I want to buy something safely', goTo: 'buy' },
  { text: 'A seller sent me an order code', goTo: 'pay' },
  { text: 'I want to sell something safely', goTo: 'sell' },
  { text: 'How does Hoolam protect my money?', goTo: 'how' },
];
export const ICE_BREAKERS = ICE_BREAKER_STEPS.map((i) => i.text);

/** Typed with "/" at any time. Short hints: they show up in a small pop-up list. */
export const COMMANDS: { name: string; hint: string; goTo: MenuItem }[] = [
  { name: 'menu', hint: 'Everything you can do', goTo: 'open' },
  { name: 'buy', hint: 'Start a safe order with a seller', goTo: 'buy' },
  { name: 'sell', hint: 'Get a safe-pay link for your buyer', goTo: 'sell' },
  { name: 'pay', hint: 'Pay with an order code from a seller', goTo: 'pay' },
  { name: 'orders', hint: 'Your orders, and where your money is', goTo: 'orders' },
  { name: 'check', hint: 'See a seller\'s record before you buy', goTo: 'check' },
  { name: 'card', hint: 'Your trust card and share link', goTo: 'card' },
  { name: 'account', hint: 'Where we send your money', goTo: 'account' },
  { name: 'problem', hint: 'Report a problem with an order', goTo: 'problem' },
  { name: 'switch', hint: 'Switch between buying and selling', goTo: 'switch' },
  { name: 'fees', hint: 'What it costs and who pays', goTo: 'fees' },
  { name: 'help', hint: 'How Hoolam keeps you safe', goTo: 'how' },
  { name: 'rep', hint: 'Talk to a real person', goTo: 'human' },
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

/**
 * The seller alert. Utility template: strictly about the order, nothing promotional.
 * `replaces`: the earlier version's name. Until Meta approves the new one, the old one is used if it was approved,
 * so alerts never stop while wording changes are reviewed. Variables and buttons must stay in the same places.
 */
export const SELLER_ALERT = {
  name: 'hoolam_new_order_request', replaces: 'hoolam_order_request',
  body:
    '🛒 New order request on Hoolam\n\n{{1}} wants to buy {{2}} from you for {{3}}.\n\n' +
    'They pay Hoolam first. You ship once the money is held, and you get paid when they are happy.\n\n' +
    'Order {{4}}. Tap below to see the photos and accept.',
  example: ['Ada', 'Black sneakers, size 42', '₦15,000', 'HL-7K2QF'],
  footer: 'Not expecting this? Tap Not me.',
  buttons: ['View order', 'Not me'],
};

/** The buyer alert (a seller started the order and typed the buyer's number). */
export const BUYER_ALERT = {
  name: 'hoolam_order_payment_request', replaces: 'hoolam_payment_request',
  body:
    '💳 Payment request on Hoolam\n\n{{1}} is selling you {{2}} for {{3}}.\n\n' +
    'You pay Hoolam, not the seller. We hold the money until you receive the item and are happy.\n\n' +
    'Order {{4}}. Tap below to see the photos and pay.',
  example: ['Bayo', 'Black sneakers, size 42', '₦15,000', 'HL-7K2QF'],
  footer: 'Not expecting this? Tap Not me.',
  buttons: ['View order', 'Not me'],
};

export interface TemplateDef { name: string; body: string; example: string[]; footer?: string; buttons?: string[]; replaces?: string }

/**
 * Order updates Hoolam starts when the other person last wrote more than 24 hours ago (WhatsApp then only
 * allows pre-approved templates). Each mirrors a chat message in messages.ts. All are UTILITY: about one
 * order, nothing promotional. The server submits them to Meta on start and uses each once Meta approves it.
 * Rules Meta enforces: the body can't start or end with a variable; button labels max 25 characters.
 */
export const DEAL_TEMPLATES = {
  sellerAccepted: {
    name: 'hoolam_order_accepted', replaces: 'hoolam_seller_accepted', label: 'Seller accepted (to the buyer)',
    body: 'Good news: the seller accepted your order {{1}}.\n\nPay {{2}} to Hoolam to start. We hold the money until you have your item and are happy.',
    example: ['HL-7K2QF', '₦15,300'], buttons: ['Pay now'],
  },
  counterOffer: {
    name: 'hoolam_order_new_price', replaces: 'hoolam_counter_offer', label: 'New price from the seller (to the buyer)',
    body: 'The seller replied to your order {{1}} with a new price. You would pay {{2}} in total.\n\nYou only pay if you accept.',
    example: ['HL-7K2QF', '₦18,400'], buttons: ['Accept new price', 'Cancel order'],
  },
  paymentReceived: {
    name: 'hoolam_order_paid', replaces: 'hoolam_payment_received', label: 'Buyer paid (to the seller)',
    body: 'The buyer has paid for order {{1}}. Your {{2}} is held safely by Hoolam.\n\nSend the item now, then tap below.',
    example: ['HL-7K2QF', '₦15,000'], buttons: ['I have sent it'],
  },
  itemOnTheWay: {
    name: 'hoolam_order_on_the_way', replaces: 'hoolam_item_on_the_way', label: 'Item on the way (to the buyer)',
    body: 'Your item for order {{1}} is on the way.\n\nWhen it arrives, open it and check it. Your money stays held by Hoolam until you tell us.',
    example: ['HL-7K2QF'], buttons: ["I'm happy", 'Problem'],
  },
  confirmReminder: {
    name: 'hoolam_order_arrived_check', replaces: 'hoolam_confirm_reminder', label: 'Has it arrived? (to the buyer)',
    body: 'Has your item for order {{1}} arrived? Your {{2}} is still held safely by Hoolam.\n\nCheck it, then tell us below.',
    example: ['HL-7K2QF', '₦15,300'], buttons: ["I'm happy", 'Problem'],
  },
  sellerPaid: {
    name: 'hoolam_order_payout_sent', replaces: 'hoolam_seller_paid', label: 'You have been paid (to the seller)',
    body: "You've been paid for order {{1}}. {{2}} has been sent to your {{3}} account.\n\nThank you for selling safely with Hoolam.",
    example: ['HL-7K2QF', '₦15,000', 'GTBank'],
  },
  refundSent: {
    name: 'hoolam_order_refund_sent', replaces: 'hoolam_refund_sent', label: 'Refund sent (to the buyer)',
    body: 'Your refund for order {{1}} has been sent. {{2}} is on its way to your {{3}} account.\n\nThank you for your patience.',
    example: ['HL-7K2QF', '₦15,300', 'Opay'],
  },
  problemReported: {
    name: 'hoolam_order_problem', replaces: 'hoolam_problem_reported', label: 'Buyer reported a problem (to the seller)',
    body: 'The buyer reported a problem with order {{1}}. The money stays held while the Hoolam team looks into it.\n\nTap below to send us your side.',
    example: ['HL-7K2QF'], buttons: ['Talk to a rep'],
  },
  sellerNoReply: {
    name: 'hoolam_order_closed', replaces: 'hoolam_deal_closed', label: 'Seller did not answer in time (to the buyer)',
    body: "Order {{1}} has closed because the seller didn't respond in time. No money was taken.\n\nYou can start a new order any time.",
    example: ['HL-7K2QF'], buttons: ['Start another'],
  },
  sellerDeclined: {
    name: 'hoolam_order_declined', replaces: 'hoolam_seller_declined', label: 'Seller declined (to the buyer)',
    body: 'The seller declined order {{1}}. No money was taken.\n\nYou can start a new order any time.',
    example: ['HL-7K2QF'], buttons: ['Start another'],
  },
  paidDispatch: {
    name: 'hoolam_order_paid_dispatch', label: 'Buyer paid, dispatch now (to the seller)',
    body: 'The buyer has paid for order {{1}}. Your {{2}} is held safely by Hoolam.\n\nDispatch it now: tell us if it is a pickup, a rider or a waybill.',
    example: ['HL-7K2QF', '₦15,000'], buttons: ['Dispatch now'],
  },
  orderDispatched: {
    // No code in the template itself: Meta rejects utility templates that carry codes. "Show my code" brings it up in the chat.
    name: 'hoolam_order_dispatched_update', replaces: 'hoolam_order_dispatched', label: 'Order dispatched (to the buyer)',
    body: 'Order {{1}} has been dispatched. Tap below to see the delivery details and your handover code.\n\nGive the code only when the item is in your hands. Your money stays with Hoolam until you are happy.',
    example: ['HL-7K2QF'], buttons: ['Show my code', 'Problem'],
  },
  handedOver: {
    name: 'hoolam_order_handed_over', label: 'Handed over, check it now (to the buyer)',
    body: 'Order {{1}} has been handed over to you. Check it now, then tell us below.\n\nIf we do not hear from you within {{2}}, the seller is paid.',
    example: ['HL-7K2QF', '24 hours'], buttons: ["I'm happy", 'Problem'],
  },
  dispatchReminder: {
    name: 'hoolam_dispatch_reminder', label: 'Waiting to be dispatched (to the seller)',
    body: 'Order {{1}} is paid and waiting to be dispatched. The buyer is expecting it.\n\nTap below to dispatch it.',
    example: ['HL-7K2QF'], buttons: ['Dispatch now'],
  },
  overdue: {
    name: 'hoolam_order_overdue', label: 'Not dispatched by the expected date (to the buyer)',
    body: 'Order {{1}} has not been dispatched yet, and the date you expected it has passed. Your money is still held by Hoolam.\n\nWhat would you like to do?',
    example: ['HL-7K2QF'], buttons: ['Send reminder', 'Refund me'],
  },
} satisfies Record<string, TemplateDef & { label: string }>;
export type DealTemplateKey = keyof typeof DEAL_TEMPLATES;

/** Every template the server keeps on Meta, with a plain label for the console. */
export const ALL_TEMPLATES: (TemplateDef & { label: string })[] = [
  { ...SELLER_ALERT, label: 'New order request (to a seller)' },
  { ...BUYER_ALERT, label: 'Payment request (to a buyer)' },
  ...Object.values(DEAL_TEMPLATES),
];

/** A ready-to-send deal update: the template, the values for {{1}}…, and what each button sends back. */
export function dealTemplate(key: DealTemplateKey, params: string[], buttonPayloads: string[] = []): Template {
  const t: TemplateDef = DEAL_TEMPLATES[key];
  return {
    name: t.name, language: 'en', params,
    buttonPayloads: t.buttons?.length ? buttonPayloads.slice(0, t.buttons.length) : undefined,
    buttonTitles: t.buttons,
    preview: t.body.replace(/\{\{(\d+)\}\}/g, (_m, i) => params[Number(i) - 1] ?? ''),
  };
}

/** The current status of every template on the account (APPROVED, PENDING, REJECTED, PAUSED…), by name. */
export async function fetchTemplateStatuses(o: MetaSetupOptions): Promise<Record<string, string> | null> {
  const r = await graph(o, 'GET', `${o.wabaId}/message_templates?fields=name,status&limit=200`);
  if (!r.ok) { o.log?.(`templates: can't list them (HTTP ${r.status}): ${r.text}`); return null; }
  return Object.fromEntries((r.json?.data ?? []).map((x: { name: string; status: string }) => [x.name, x.status]));
}

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
      ...(t.footer ? [{ type: 'FOOTER', text: t.footer }] : []),
      ...(t.buttons?.length ? [{ type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }] : []),
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

/** The live "My orders" form: talks to our encrypted endpoint. */
export async function ensureOrdersFlow(o: MetaSetupOptions, endpointUri: string, json = ordersFlowJson()): Promise<string | null> {
  const name = 'hoolam_orders_' + createHash('sha256').update(JSON.stringify(json) + endpointUri).digest('hex').slice(0, 8);
  return ensureFlow(o, json, name, 'orders form', endpointUri);
}

/** Tells Meta the public half of our forms key (needed before live forms can be published). Never throws. */
export async function registerFlowsKey(o: AutomationOptions, publicKeyPem: string): Promise<boolean> {
  const f = o.fetchImpl ?? fetch;
  try {
    const current = await graph(o, 'GET', `${o.phoneNumberId}/whatsapp_business_encryption`);
    const have = current.json?.data?.[0]?.business_public_key as string | undefined;
    const norm = (k: string) => k.replace(/\s+/g, '');
    if (have && norm(have) === norm(publicKeyPem) && current.json?.data?.[0]?.business_public_key_signature_status === 'VALID') {
      o.log?.('forms key: already registered with Meta');
      return true;
    }
    const res = await f(`https://graph.facebook.com/${o.graphVersion}/${o.phoneNumberId}/whatsapp_business_encryption`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ business_public_key: publicKeyPem }).toString(),
    });
    const text = (await res.text()).slice(0, 300);
    o.log?.(res.ok ? 'forms key: registered with Meta' : `forms key FAILED to register (HTTP ${res.status}): ${text}`);
    return res.ok;
  } catch (e) {
    o.log?.(`forms key FAILED to register: ${(e as Error).message}`);
    return false;
  }
}

async function ensureFlow(o: MetaSetupOptions, json: object, name: string, label: string, endpointUri?: string): Promise<string | null> {
  const list = await graph(o, 'GET', `${o.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
  if (!list.ok) { o.log?.(`${label}: can't list forms (HTTP ${list.status}): ${list.text}`); return null; }
  const existing = (list.json?.data ?? []).find((x: { name: string }) => x.name === name);
  if (existing) {
    const errs: { message?: string }[] = existing.validation_errors ?? [];
    if (errs.length) {
      o.log?.(`${label} FAILED: ${name} has ${errs.length} problem(s): ${errs.map((e) => e.message).join(' | ').slice(0, 600)}`);
      return null;
    }
    // switched to published after the form was first made as a draft: publish it now (published forms can't change, so this is one-way)
    if (o.formMode === 'published' && existing.status === 'DRAFT') {
      const pub = await graph(o, 'POST', `${existing.id}/publish`);
      if (!pub.ok) {
        // a draft form only opens for testers, so people answer in the chat instead until it's published
        o.log?.(`${label}: couldn't publish ${name} (HTTP ${pub.status}): ${pub.text}. People answer in the chat until it's fixed.`);
        return null;
      }
      o.log?.(`${label} published: ${name}`);
    }
    o.log?.(`${label} ready: ${name} (${o.formMode === 'published' ? 'PUBLISHED' : existing.status}, sending as ${o.formMode})`);
    return existing.id;
  }
  const created = await graph(o, 'POST', `${o.wabaId}/flows`, {
    name, categories: ['OTHER'], flow_json: JSON.stringify(json), publish: o.formMode === 'published',
    ...(endpointUri ? { endpoint_uri: endpointUri } : {}),
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
