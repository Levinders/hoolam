import { renderBrandCard } from '../receipt.js';
import { kycFlowJson, kycFlowName } from './kyc-flow.js';
import { createHash } from 'node:crypto';
import { buyEditFlowJson, buyEditFlowName, buyFlowJson, buyFlowName, sellEditFlowJson, sellEditFlowName, sellFlowJson, sellFlowName } from './buy-flow.js';
import { ordersFlowJson } from './orders-flow.js';
import { ambApplyFlowJson, ambApplyFlowName, ambDetailsFlowJson } from './amb-flow.js';
import type { Template } from './client.js';
import type { Art } from '../chat-art/index.js';

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
export type MenuItem = 'open' | 'sell' | 'buy' | 'orders' | 'deals' | 'account' | 'pay' | 'problem' | 'how' | 'fees' | 'human' | 'card' | 'check' | 'tosell' | 'tobuy' | 'switch' | 'me' | 'market' | 'items';

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

export interface MetaSetupOptions extends AutomationOptions {
  wabaId: string;
  /** No longer used: every form is published on Meta at start and sent in the state Meta reports. (Accepted so older callers still work.) */
  formMode?: 'draft' | 'published';
  /** Told what happened to each form: its id and Meta's state (PUBLISHED / DRAFT), or why it can't be used. */
  report?: (r: { name: string; id: string | null; status: string | null; error: string | null }) => void;
}

/**
 * The seller alert. Utility template: strictly about the order, nothing promotional.
 * `replaces`: the earlier version's name. Until Meta approves the new one, the old one is used if it was approved,
 * so alerts never stop while wording changes are reviewed. Variables and buttons must stay in the same places.
 */
export const SELLER_ALERT: TemplateDef = {
  // v3: the item's first photo at the top (or the Hoolam card when there's none). Until approved, v2 (no picture) is used.
  name: 'hoolam_new_order_request_v3', replaces: 'hoolam_new_order_request_v2', headerImage: true,
  body:
    '🛒 *New order request* on *Hoolam*\n\n👤 Buyer: *{{1}}*\n📦 Item: *{{2}}*\n💰 Total price: *{{3}}*\n\n' +
    'They pay Hoolam first. You dispatch once the money is held, and you get paid when they are happy.\n\n' +
    'Order *{{4}}*. Tap below to see the photos and accept.',
  example: ['Ada', 'Black sneakers, size 42', '₦15,000', 'HL-7K2QF'],
  footer: 'Not expecting this? Tap Not me.',
  buttons: ['View order', 'Not me'],
};

/**
 * The buyer alert (a seller started the order and typed the buyer's number): the mirror of the seller alert.
 * While Meta reviews it, the older approved version is used with the values it takes (seller, item, what they pay, order).
 */
export const BUYER_ALERT: TemplateDef = {
  // v2: the item's first photo at the top (or the Hoolam card). Until approved, v1 (no picture) is used.
  name: 'hoolam_new_order_for_buyer_v2', replaces: 'hoolam_new_order_for_buyer', headerImage: true,
  body:
    '🛍️ *New order for you* on *Hoolam*\n\n🏷️ Seller: *{{1}}*\n📦 Item: *{{2}}*\n💰 Total price: *{{3}}*\n💳 You pay: *{{4}}*\n\n' +
    'You pay Hoolam, not the seller. We hold your money until you have your item and are happy.\n\n' +
    'Order *{{5}}*. Tap below to see the photos and accept.',
  example: ['Bayo Kicks', 'Black sneakers, size 42', '₦15,000', '₦15,500', 'HL-7K2QF'],
  footer: 'Not expecting this? Tap Not me.',
  buttons: ['View order', 'Not me'],
};

export interface TemplateDef {
  name: string; body: string; example: string[]; footer?: string; buttons?: string[]; replaces?: string;
  /** When the replaced version has different variables: which of the new values it takes, in its order (0-based). */
  replacesParams?: number[];
  /** When the replaced version has fewer buttons: how many it has. */
  replacesButtons?: number;
  /** A picture at the top (the item's photo, or a Hoolam card from src/chat-art). The replaced version has none. */
  headerImage?: boolean;
}

/**
 * Order updates Hoolam starts when the other person last wrote more than 24 hours ago (WhatsApp then only
 * allows pre-approved templates). Each mirrors a chat message in messages.ts. All are UTILITY: about one
 * order, nothing promotional. The server submits them to Meta on start and uses each once Meta approves it.
 * Rules Meta enforces: the body can't start or end with a variable; button labels max 25 characters.
 */
export const DEAL_TEMPLATES = {
  sellerAccepted: {
    name: 'hoolam_order_accepted_pay_v2', replaces: 'hoolam_order_accepted_pay', headerImage: true, label: 'Seller accepted, pay now (to the buyer)',
    body: 'Good news: the seller *accepted your order!* Order *{{1}}*.\n\nPay *{{2}}* to Hoolam to start. *Your money stays with Hoolam until you have your item and you are happy.*',
    example: ['HL-7K2QF', '₦15,300'], buttons: ['Pay now', 'Cancel order'],
  },
  counterOffer: {
    name: 'hoolam_order_new_price_breakdown', replaces: 'hoolam_order_new_price', replacesParams: [0, 4], label: 'New price from the seller, with the reason (to the buyer)',
    body: 'The seller replied to your order *{{1}}* with a new price of *{{2}}*.\n\nTheir reason: {{3}}\n\nHoolam fee: {{4}}\nYou would pay: *{{5}}*\n\nYou only pay if you accept.',
    example: ['HL-7K2QF', '₦18,000', 'The price went up at the market', '₦450', '₦18,450'], buttons: ['Accept new price', 'Cancel order'],
  },
  paymentReceived: {
    name: 'hoolam_order_paid_v3', replaces: 'hoolam_order_paid_v2', headerImage: true, label: 'Buyer paid (to the seller)',
    body: 'The buyer has paid for order *{{1}}*. Your *{{2}}* is held safely by Hoolam.\n\nSend the item now, then tap below.',
    example: ['HL-7K2QF', '₦15,000'], buttons: ['I have sent it'],
  },
  itemOnTheWay: {
    name: 'hoolam_order_on_the_way_v2', replaces: 'hoolam_order_on_the_way', headerImage: true, label: 'Item on the way (to the buyer)',
    body: 'Your item for order {{1}} is on the way.\n\nWhen it arrives, open it and check it. Your money stays held by Hoolam until you tell us.',
    example: ['HL-7K2QF'], buttons: ["I'm happy", 'Problem'],
  },
  confirmReminder: {
    name: 'hoolam_order_arrived_check_v2', replaces: 'hoolam_order_arrived_check', headerImage: true, label: 'Has it arrived? (to the buyer)',
    body: 'Has your item for order {{1}} arrived? Your {{2}} is still held safely by Hoolam.\n\nCheck it, then tell us below.',
    example: ['HL-7K2QF', '₦15,300'], buttons: ["I'm happy", 'Problem'],
  },
  sellerPaid: {
    name: 'hoolam_order_payout_sent_v2', replaces: 'hoolam_order_payout_sent', headerImage: true, label: 'You have been paid (to the seller)',
    body: "You've been paid for order {{1}}. {{2}} has been sent to your {{3}} account.\n\nThank you for selling safely with Hoolam.",
    example: ['HL-7K2QF', '₦15,000', 'GTBank'],
  },
  refundSent: {
    name: 'hoolam_order_refund_sent_v2', replaces: 'hoolam_order_refund_sent', headerImage: true, label: 'Refund sent (to the buyer)',
    body: 'Your refund for order {{1}} has been sent. {{2}} is on its way to your {{3}} account.\n\nThank you for your patience.',
    example: ['HL-7K2QF', '₦15,300', 'Opay'],
  },
  problemReported: {
    name: 'hoolam_order_problem_v2', replaces: 'hoolam_order_problem', headerImage: true, label: 'Buyer reported a problem (to the seller)',
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
    name: 'hoolam_order_paid_dispatch_v3', replaces: 'hoolam_order_paid_dispatch_v2', headerImage: true, label: 'Buyer paid, dispatch now (to the seller)',
    body: 'The buyer has paid for order *{{1}}*. Your *{{2}}* is held safely by Hoolam.\n\nDispatch it now: tell us if it is a pickup, a rider or a waybill.',
    example: ['HL-7K2QF', '₦15,000'], buttons: ['Dispatch now'],
  },
  orderDispatched: {
    // No mention of the handover code at all: Meta reads any "code" in a utility template as a login/OTP message and
    // rejects it (it did, twice). The button brings up the delivery details and the code in the chat instead.
    name: 'hoolam_order_dispatched_notice_v2', replaces: 'hoolam_order_dispatched_notice', headerImage: true, label: 'Order dispatched (to the buyer)',
    body: 'Good news: your order {{1}} has been dispatched and is on its way to you.\n\nTap below to see the delivery details. Your money stays with Hoolam until you have your item and are happy.',
    example: ['HL-7K2QF'], buttons: ['Delivery details', 'Problem'],
  },
  handedOver: {
    name: 'hoolam_order_handed_over_v2', replaces: 'hoolam_order_handed_over', headerImage: true, label: 'Handed over, check it now (to the buyer)',
    body: 'Order {{1}} has been handed over to you. Check it now, then tell us below.\n\nIf we do not hear from you within {{2}}, the seller is paid.',
    example: ['HL-7K2QF', '24 hours'], buttons: ["I'm happy", 'Problem'],
  },
  dispatchReminder: {
    name: 'hoolam_dispatch_reminder', label: 'Waiting to be dispatched (to the seller)',
    body: 'Order {{1}} is paid and waiting to be dispatched. The buyer is expecting it.\n\nTap below to dispatch it.',
    example: ['HL-7K2QF'], buttons: ['Dispatch now'],
  },
  supportMessage: {
    // Whatever the team types in the console, as an order update (utility). Line breaks become spaces (Meta's rule).
    name: 'hoolam_support_update', label: 'A message from Hoolam support (to a buyer or seller)',
    body: '🙋 *Hoolam support:* an update about your order *{{1}}*.\n\n{{2}}\n\nReply here if you have any questions.',
    example: ['HL-7K2QF', 'Your rider is on the way and will call you in about 10 minutes.'],
  },
  liveChatReply: {
    // A rep answered a website live chat after the visitor left the page. Sent once until they come back.
    name: 'hoolam_live_chat_reply', label: 'A rep replied to your website chat (to a visitor)',
    body: 'Hi {{1}}, a Hoolam rep replied to your chat on our website:\n\n"{{2}}"\n\nOpen the chat to read and reply: {{3}}\n\nThis message is only about the chat you started.',
    example: ['Ivana', 'Yes, your money is held safely until the item arrives.', 'https://hoolam.com/contact/?chat=Ab3dE5fG7h'],
  },
  buyerAccepted: {
    name: 'hoolam_buyer_accepted', label: 'The buyer accepted (to the seller)',
    body: '✅ Good news: *{{1}}* accepted your order *{{2}}* on Hoolam.\n\nWe have asked them to pay. *Do not send the item until we tell you the money is held.*',
    example: ['Ada', 'HL-7K2QF'],
  },
  buyerDeclined: {
    name: 'hoolam_buyer_declined', label: 'The buyer declined (to the seller)',
    body: 'Update on Hoolam: *{{1}}* declined your order *{{2}}*. No money moved.\n\nYou can start a new order any time.',
    example: ['Ada', 'HL-7K2QF'], buttons: ['Sell something'],
  },
  buyerNoReply: {
    name: 'hoolam_buyer_no_reply', label: 'The buyer did not accept in time (to the seller)',
    body: 'Your order *{{1}}* on Hoolam has closed because the buyer did not accept it in time. No money moved.\n\nYou can start a new order any time.',
    example: ['HL-7K2QF'], buttons: ['Sell something'],
  },
  courierJob: {
    // To the rider or waybill driver at dispatch. No "code" anywhere (Meta rejects it in utility templates):
    // the button opens the chat, which then asks for the 4-digit code from the receiver.
    name: 'hoolam_delivery_for_rider_v2', replaces: 'hoolam_delivery_for_rider', headerImage: true, label: 'Delivery details and fee (to the rider or driver)',
    body: '🛵 *Delivery on Hoolam* from {{1}}\n\n👤 Receiver: *{{2}}*\n📞 {{3}}\n📍 Deliver to: {{4}}\n\n💸 Your delivery fee: *{{5}}*\n🏦 Paid to: {{6}}\n\n' +
      'When you hand over the item, tap Confirm delivery. Your fee is paid as soon as the receiver is confirmed.',
    example: ['Bayo Kicks', 'Ada', '08031234567', '12 Woji Road, Port Harcourt', '₦2,000', 'Musa Ibrahim, OPay 9876543210'],
    footer: 'Not expecting this? You can ignore it.',
    buttons: ['Confirm delivery'],
  },
  overdue: {
    name: 'hoolam_order_overdue', label: 'Not dispatched by the expected date (to the buyer)',
    body: 'Order {{1}} has not been dispatched yet, and the date you expected it has passed. Your money is still held by Hoolam.\n\nWhat would you like to do?',
    example: ['HL-7K2QF'], buttons: ['Send reminder', 'Refund me'],
  },
} satisfies Record<string, TemplateDef & { label: string }>;
export type DealTemplateKey = keyof typeof DEAL_TEMPLATES;

/**
 * Ambassador updates sent when they last wrote more than 24 hours ago. UTILITY: about their own ambassador account.
 * Each mirrors a chat message in ambassadors.ts (amsg).
 */
export const AMB_TEMPLATES = {
  approved: {
    name: 'hoolam_ambassador_approved_v2', replaces: 'hoolam_ambassador_approved', headerImage: true, label: 'Ambassador application approved',
    body: 'Good news, {{1}}: your application to be a *Hoolam ambassador* is approved.\n\nTap Get started to finish setting up. It takes a few minutes.',
    example: ['Tobi'], buttons: ['Get started'],
  },
  invited: {
    name: 'hoolam_ambassador_added_v2', replaces: 'hoolam_ambassador_added', headerImage: true, label: 'Added as an ambassador by the team',
    body: 'Hello {{1}}, the Hoolam team has added you as a *Hoolam ambassador*. You earn a share of what Hoolam makes on orders from the sellers and buyers you bring.\n\nTap Get started to set up.',
    example: ['Tobi'], buttons: ['Get started'],
  },
  update: {
    name: 'hoolam_ambassador_update', label: 'Ambassador update (someone joined, a bonus, the month)',
    body: 'Update on your Hoolam ambassador account: {{1}}\n\nTap below to see your earnings.',
    example: ['someone new joined Hoolam with your link.'], buttons: ['Ambassador'],
  },
  paid: {
    name: 'hoolam_ambassador_paid_v2', replaces: 'hoolam_ambassador_paid', headerImage: true, label: 'Ambassador payout sent',
    body: 'We have paid *{{1}}* to your {{2}} account for your Hoolam ambassador earnings in {{3}}. Reference: {{4}}.\n\nThank you for growing Hoolam.',
    example: ['₦12,400', 'GTBank', 'October 2026', 'HLA-7K2QF'], buttons: ['Ambassador'],
  },
  term: {
    name: 'hoolam_ambassador_term', label: 'Ambassador term ends soon',
    body: 'Your Hoolam ambassador term of {{1}} months ends on {{2}}. If you do nothing, it renews on the same term.\n\nWhatever term you choose, your share grows when you bring more active sellers and buyers.',
    example: ['6', '14 Feb 2027'], buttons: ['Renew', 'Switch term', 'End'],
  },
  signIn: {
    name: 'hoolam_ambassador_sign_in', label: 'Ambassador dashboard: signed in on a new device',
    body: 'You signed in to your Hoolam ambassador dashboard on {{1}}. Not you? Tap Sign everyone out.',
    example: ['Chrome on Android'], buttons: ['Sign everyone out'],
  },
} satisfies Record<string, TemplateDef & { label: string }>;
export type AmbTemplateKey = keyof typeof AMB_TEMPLATES;

export function ambTemplate(key: AmbTemplateKey, params: string[], buttonPayloads: string[] = [], art?: Art): Template {
  const t: TemplateDef = AMB_TEMPLATES[key];
  return {
    ...(art ? { art } : {}),
    name: t.name, language: 'en', params,
    buttonPayloads: t.buttons?.length ? buttonPayloads.slice(0, t.buttons.length) : undefined,
    buttonTitles: t.buttons,
    preview: t.body.replace(/\{\{(\d+)\}\}/g, (_m, i) => params[Number(i) - 1] ?? ''),
  };
}

/** Every template the server keeps on Meta, with a plain label for the console. */
export const ALL_TEMPLATES: (TemplateDef & { label: string })[] = [
  { ...SELLER_ALERT, label: 'New order request (to a seller)' },
  { ...BUYER_ALERT, label: 'New order for you (to a buyer)' },
  ...Object.values(DEAL_TEMPLATES),
  ...Object.values(AMB_TEMPLATES),
];

/**
 * The sign-in code for an ambassador's web dashboard: an AUTHENTICATION template (Meta's own wording,
 * with a "Copy code" button). Used when they haven't written to Hoolam in the last 24 hours.
 */
export const SIGN_IN_CODE = { name: 'hoolam_sign_in_code', label: 'Sign-in code (ambassador dashboard)' };
export async function ensureSignInTemplate(o: MetaSetupOptions): Promise<string | null> {
  const found = await graph(o, 'GET', `${o.wabaId}/message_templates?name=${SIGN_IN_CODE.name}&fields=name,status`);
  const existing = found.ok ? (found.json?.data ?? []).find((x: { name: string }) => x.name === SIGN_IN_CODE.name) : null;
  if (existing) return existing.status;
  const created = await graph(o, 'POST', `${o.wabaId}/message_templates`, {
    name: SIGN_IN_CODE.name, language: 'en', category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ],
  });
  if (!created.ok) { o.log?.(`sign-in code template FAILED to create (HTTP ${created.status}): ${created.text}`); return null; }
  o.log?.(`sign-in code template submitted to Meta: ${created.json?.status ?? 'PENDING'}`);
  return created.json?.status ?? 'PENDING';
}

/** A ready-to-send deal update: the template, the values for {{1}}…, and what each button sends back. */
export function dealTemplate(key: DealTemplateKey, params: string[], buttonPayloads: string[] = [], art?: Art): Template {
  const t: TemplateDef = DEAL_TEMPLATES[key];
  return {
    ...(art ? { art } : {}),
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
  // a picture at the top needs a sample picture uploaded to Meta first (the Hoolam card)
  let headerHandle: string | null = null;
  if (t.headerImage) {
    headerHandle = await uploadSample(o, await renderBrandCard(), 'image/jpeg');
    if (!headerHandle) { o.log?.(`${label} template: couldn't upload its sample picture; trying again on the next start`); return null; }
  }
  const created = await graph(o, 'POST', `${o.wabaId}/message_templates`, {
    name: t.name, language: 'en', category: 'UTILITY', parameter_format: 'positional',
    components: [
      ...(headerHandle ? [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: [headerHandle] } }] : []),
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

/**
 * Uploads a sample file to Meta (needed for templates with a picture). Returns the handle, or null.
 * Meta's resumable upload: find the app from the token, open an upload session, send the bytes.
 */
async function uploadSample(o: MetaSetupOptions, bytes: Buffer, type: string): Promise<string | null> {
  try {
    const app = await graph(o, 'GET', 'app');
    const appId = app.json?.id;
    if (!appId) { o.log?.(`sample upload: can't find the Meta app (HTTP ${app.status}): ${app.text}`); return null; }
    const session = await graph(o, 'POST', `${appId}/uploads?file_name=hoolam-sample.jpg&file_length=${bytes.length}&file_type=${encodeURIComponent(type)}`);
    const sid = session.json?.id;
    if (!sid) { o.log?.(`sample upload: no session (HTTP ${session.status}): ${session.text}`); return null; }
    const f = o.fetchImpl ?? fetch;
    const res = await f(`https://graph.facebook.com/${o.graphVersion}/${sid}`, { method: 'POST', headers: { Authorization: `OAuth ${o.token}`, file_offset: '0' }, body: new Uint8Array(bytes) });
    const j = (await res.json().catch(() => null)) as { h?: string } | null;
    if (!res.ok || !j?.h) { o.log?.(`sample upload failed (HTTP ${res.status})`); return null; }
    return j.h;
  } catch (e) {
    o.log?.(`sample upload failed: ${(e as Error).message}`);
    return null;
  }
}

/** Makes sure the buyer's form exists on Meta. Returns its id, or null (then the chat questions are used). */
export async function ensureBuyFlow(o: MetaSetupOptions, json = buyFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, buyFlowName(json), 'buyer form');
}

/** The buyer's form filled in with their answers, for "Edit order". */
export async function ensureBuyEditFlow(o: MetaSetupOptions, json = buyEditFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, buyEditFlowName(json), 'buyer edit form');
}

/** Makes sure the seller's form exists on Meta. */
export async function ensureSellFlow(o: MetaSetupOptions, json = sellFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, sellFlowName(json), 'seller form');
}

/** The ID check form (BVN or NIN, number, date of birth). */
export async function ensureKycFlow(o: MetaSetupOptions, json = kycFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, kycFlowName(json), 'ID check form');
}

/** The seller's form filled in with their answers, for "Edit order". */
export async function ensureSellEditFlow(o: MetaSetupOptions, json = sellEditFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, sellEditFlowName(json), 'seller edit form');
}

/** A live form (talks to our endpoint) by its own name: the payout account form. */
export async function ensureLiveFlow(o: MetaSetupOptions, json: object, name: string, label: string, endpointUri: string): Promise<string | null> {
  return ensureFlow(o, json, name, label, endpointUri);
}
/** A static form (no endpoint) by its own name: used for the market's forms. */
export async function ensureStaticFlow(o: MetaSetupOptions, json: object, name: string, label: string): Promise<string | null> {
  return ensureFlow(o, json, name, label);
}

/** The ambassador application (4 short screens). */
export async function ensureAmbApplyFlow(o: MetaSetupOptions, json = ambApplyFlowJson()): Promise<string | null> {
  return ensureFlow(o, json, ambApplyFlowName(json), 'ambassador application form');
}
/** The ambassador's Details (live: any month's earnings, their people, their account). */
export async function ensureAmbDetailsFlow(o: MetaSetupOptions, endpointUri: string, json: object = ambDetailsFlowJson()): Promise<string | null> {
  const name = 'hoolam_amb_details_' + createHash('sha256').update(JSON.stringify(json) + endpointUri).digest('hex').slice(0, 8);
  return ensureFlow(o, json, name, 'ambassador details form', endpointUri);
}

/** The live "My orders" form: talks to our encrypted endpoint. */
export async function ensureOrdersFlow(o: MetaSetupOptions, endpointUri: string, json: object = ordersFlowJson()): Promise<string | null> {
  const name = 'hoolam_orders_' + createHash('sha256').update(JSON.stringify(json) + endpointUri).digest('hex').slice(0, 8);
  return ensureFlow(o, json, name, 'orders form', endpointUri);
}

/** The live single-order form (opened from alerts: a new order, dispatch now, enter the code). */
export async function ensureOrderFlow(o: MetaSetupOptions, endpointUri: string, json: object = ordersFlowJson('ORDER')): Promise<string | null> {
  const name = 'hoolam_order_' + createHash('sha256').update(JSON.stringify(json) + endpointUri).digest('hex').slice(0, 8);
  return ensureFlow(o, json, name, 'order form', endpointUri);
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
  const fail = (error: string): null => { o.report?.({ name, id: null, status: null, error: error.slice(0, 400) }); return null; };
  const ok = (id: string, status: string, note: string | null = null): string => { o.report?.({ name, id, status, error: note }); return id; };
  const list = await graph(o, 'GET', `${o.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
  if (!list.ok) { o.log?.(`${label}: can't list forms (HTTP ${list.status}): ${list.text}`); return fail(`Can't list forms on Meta (HTTP ${list.status}): ${list.text}`); }
  const existing = (list.json?.data ?? []).find((x: { name: string }) => x.name === name);
  if (existing) {
    const errs: { message?: string }[] = existing.validation_errors ?? [];
    if (errs.length) {
      o.log?.(`${label} FAILED: ${name} has ${errs.length} problem(s): ${errs.map((e) => e.message).join(' | ').slice(0, 600)}`);
      return fail(`Meta found ${errs.length} problem(s): ${errs.map((e) => e.message).join(' | ')}`);
    }
    if (['BLOCKED', 'DEPRECATED', 'THROTTLED'].includes(existing.status)) {
      o.log?.(`${label} FAILED: ${name} is ${existing.status} on Meta`);
      return fail(`The form is ${String(existing.status).toLowerCase()} on Meta`);
    }
    // switched to published after the form was first made as a draft: publish it now (published forms can't change, so this is one-way)
    // every form is published, so everyone can open it (published forms can't change: a changed form gets a new name)
    if (existing.status === 'DRAFT') {
      const pub = await graph(o, 'POST', `${existing.id}/publish`);
      if (!pub.ok) {
        // a draft form only opens for testers, so people answer in the chat instead until it's published
        // still usable as a draft (it opens for testers); the console shows why it isn't published
        o.log?.(`${label}: couldn't publish ${name} (HTTP ${pub.status}): ${pub.text}. Sending it as a draft.`);
        return ok(existing.id, 'DRAFT', `Meta wouldn't publish it yet, so it's sent as a draft (only Meta testers can open it): ${pub.text}`);
      }
      o.log?.(`${label} published: ${name}`);
      return ok(existing.id, 'PUBLISHED');
    }
    o.log?.(`${label} ready: ${name} (${existing.status}, sending as ${existing.status === 'PUBLISHED' ? 'published' : 'draft'})`);
    return ok(existing.id, existing.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT');
  }
  const created = await graph(o, 'POST', `${o.wabaId}/flows`, {
    name, categories: ['OTHER'], flow_json: JSON.stringify(json), publish: true,
    ...(endpointUri ? { endpoint_uri: endpointUri } : {}),
  });
  if (!created.ok || !created.json?.id) {
    o.log?.(`${label} FAILED to create (HTTP ${created.status}): ${created.text}`);
    return fail(`Couldn't create it on Meta (HTTP ${created.status}): ${created.text}`);
  }
  const errors: { message?: string }[] = created.json.validation_errors ?? [];
  if (errors.length) {
    // Never send a broken form: buyers answer in the chat until it's fixed.
    o.log?.(`${label} FAILED: Meta found ${errors.length} problem(s): ${errors.map((e) => e.message).join(' | ').slice(0, 600)}`);
    return fail(`Meta found ${errors.length} problem(s): ${errors.map((e) => e.message).join(' | ')}`);
  }
  // Meta says whether publishing worked; if it didn't say, read it back rather than guess
  let status: string = created.json.status ?? '';
  if (!status) {
    const r = await graph(o, 'GET', `${created.json.id}?fields=status`);
    status = r.ok && r.json?.status ? r.json.status : 'DRAFT';
  }
  o.log?.(`${label} created: ${name} (${status}, sending as ${status === 'PUBLISHED' ? 'published' : 'draft'})`);
  return ok(created.json.id, status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT');
}
