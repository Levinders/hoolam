import { createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import type { Db } from '../db.js';
import { formatMoney, parseAmount, toMinor, type Currency } from '../money.js';
import { categoryTitle } from '../deals/categories.js';
import { dayText, DealError, isVerified, type Deal, type DealService, type User } from '../deals/service.js';
import type { KycNext } from './flow.js';
import type { KycWhy } from './messages.js';
import type { Bank, PaymentProvider } from '../payments/provider.js';
import { bankChoices, matchBank } from './banks.js';
import { normalizePhone } from './inbound.js';
import { msg, STATUS_WORDS } from './messages.js';
import { localPhone } from '../phone.js';
import { ART, stepOf } from '../chat-art/build.js';
import type { Art } from '../chat-art/index.js';

/**
 * "MY ORDERS": a WhatsApp form that loads live data from our server (the encrypted endpoint in app.ts).
 * Screens:  FILTER → ORDERS (20 a page, newest first) → ORDER (details, photos, the next step)
 *           ORDER → DISPATCH (pickup / rider / waybill) → COURIER (rider or driver details, account check) → DONE
 *           ORDER → CODE (the handover code) → DONE
 * Every action does exactly what the matching chat button does; the chat gets the usual messages.
 */

export type Entry = 'orders' | 'order' | 'dispatch' | 'code' | 'preview'; // preview: the buyer's order before it's sent
type Mode = 'buyer' | 'seller';
const PAGE = 20;

// ---------------------------------------------------------------------------------------------
// The flow token: who opened the form and where it starts. Signed, so nobody can open someone else's orders.
// ---------------------------------------------------------------------------------------------
export function signToken(secret: string, phone: string, mode: Mode, entry: Entry, code = '-', ttlHours = 72): string {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const body = `o1.${phone.replace(/\D/g, '')}.${mode}.${entry}.${code}.${exp}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22)}`;
}

export function readToken(secret: string, token: string): { phone: string; mode: Mode; entry: Entry; code: string | null } | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 7 || parts[0] !== 'o1') return null;
  const body = parts.slice(0, 6).join('.');
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22));
  const got = Buffer.from(parts[6]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(parts[5]) * 1000 < Date.now()) return null;
  const mode = parts[2] === 'seller' ? 'seller' : 'buyer';
  return { phone: '+' + parts[1], mode, entry: parts[3] as Entry, code: parts[4] === '-' ? null : parts[4]! };
}

// ---------------------------------------------------------------------------------------------
// The form itself
// ---------------------------------------------------------------------------------------------
const ex = (v: unknown) => ({ type: typeof v === 'boolean' ? 'boolean' : 'string', __example__: v });
const exList = (v: Record<string, string>[]) => ({
  type: 'array', items: { type: 'object', properties: Object.fromEntries(Object.keys(v[0]!).map((k) => [k, { type: 'string' }])) }, __example__: v,
});
/** Form text is shown as plain text: drop WhatsApp-style *bold* and _italic_ marks. */
const plain = (t: string) => t.replace(/\*([^*\n]+)\*/g, '$1').replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,])/g, '$1$2');
/** The bank dropdown: the shortlist, then "My bank isn't listed" (then they type it). */
const OTHER_BANK = 'other';
const bankOptions = (banks: Bank[]) => [...banks.map((b) => ({ id: b.code, title: b.name.slice(0, 30) })), { id: OTHER_BANK, title: 'My bank isn\'t listed' }].slice(0, 200);

/** A small, light copy of a photo for a form (Meta allows ~300 KB per image; we keep each well under). */
async function thumb(bytes: Buffer): Promise<string | null> {
  try { return (await sharp(bytes).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString('base64'); }
  catch { return null; }
}
/** A coloured dot for an order's status in My orders: 🟡 waiting, 🔵 money held, 🟢 done, 🔴 problem, ⚪ closed. */
export function statusDot(d: Pick<Deal, 'status'>): string {
  return ({ AWAITING_SELLER: '🟡', AWAITING_BUYER: '🟡', AWAITING_PAYMENT: '🟡', FUNDED: '🔵', SHIPPED: '🔵', RELEASING: '🟢', PAYOUT_PENDING: '🟢', COMPLETED: '🟢',
    DISPUTED: '🔴', REFUNDING: '🔵', REFUNDED: '🟢', CANCELLED: '⚪', EXPIRED: '⚪' } as Record<string, string>)[d.status] ?? '⚪';
}
const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase());

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Two forms from one definition. WhatsApp only lets a form open on a screen nothing routes into, so:
 *  - 'FILTER': My orders (FILTER → ORDERS → ORDER → …)
 *  - 'ORDER':  one order on its own (opened from an alert: new order, dispatch now, enter code)
 */
export type FormStart = 'FILTER' | 'ORDER';
/** "Ada · HL-7K2QF · ₦20,000" in at most 30 characters (WhatsApp's limit): the name gives way first. */
export function rowTitle(name: string | null, phone: string | null, mode: 'buyer' | 'seller', code: string, amount: string): string {
  const who = name?.trim().split(/\s+/)[0] || (phone ? localPhone(phone) : mode === 'seller' ? 'Buyer' : 'Seller');
  const rest = ` · ${code} · ${amount}`;
  const room = 30 - rest.length;
  if (room < 3) return `${code} · ${amount}`.slice(0, 30);
  return (who.length <= room ? who : who.slice(0, room - 1) + '…') + rest;
}

/** `example`: Hoolam's number as people write it, shown as the example in phone hints (a new number makes a new form). */
export function ordersFlowJson(start: FormStart = 'FILTER', safe = false, example = '08012345678') {
  if (safe) return safeOrdersFlowJson(start, example);
  const full = fullOrdersFlowJson(example);
  if (start === 'FILTER') return full;
  const drop = new Set(['FILTER', 'ORDERS']);
  return {
    ...full,
    routing_model: Object.fromEntries(Object.entries(full.routing_model).filter(([k]) => !drop.has(k))),
    screens: full.screens.filter((x) => !drop.has(x.id)),
  };
}

function fullOrdersFlowJson(example = '08012345678') {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: <Record<string, string[]>>{
      FILTER: ['ORDERS', 'DONE'],
      ORDERS: ['ORDER'],
      ORDER: ['DISPATCH', 'CODE', 'DONE'],
      DISPATCH: ['COURIER', 'DONE'],
      COURIER: ['DONE'],
      CODE: ['DONE'],
    },
    screens: [
      {
        id: 'FILTER', title: 'My orders',
        data: { heading: ex('Orders you\'re buying'), filters: exList([{ id: 'pending', title: 'Pending', description: '3 orders still going' }]) },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            {
              type: 'RadioButtonsGroup', name: 'filter', label: 'Which orders?', required: true, 'data-source': '${data.filters}',
              'on-select-action': { name: 'data_exchange', payload: { op: 'filter', filter: '${form.filter}' } },
            },
            { type: 'Footer', label: 'Show orders', 'on-click-action': { name: 'data_exchange', payload: { op: 'filter', filter: '${form.filter}' } } },
          ],
        },
      },
      {
        id: 'ORDERS', title: 'My orders',
        data: {
          summary: ex('Pending · 1–20 of 34'), filter: ex('pending'), page: ex('1'),
          orders: exList([{ id: 'HL-7K2QF', title: 'Ada · HL-7K2QF · ₦20,500', description: 'Leather bag\n👉 Dispatch it now' }]),
          nav: exList([{ id: 'next', title: '➡️ Next 20', description: 'Older orders' }]),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.summary}' },
            {
              type: 'RadioButtonsGroup', name: 'order', label: 'Tap an order to open it', required: false, 'data-source': '${data.orders}',
              'on-select-action': { name: 'data_exchange', payload: { op: 'open', code: '${form.order}', filter: '${data.filter}', page: '${data.page}' } },
            },
            {
              type: 'RadioButtonsGroup', name: 'nav', label: 'More', required: false, 'data-source': '${data.nav}',
              'on-select-action': { name: 'data_exchange', payload: { op: 'nav', to: '${form.nav}', filter: '${data.filter}', page: '${data.page}' } },
            },
            { type: 'Footer', label: 'Open order', 'on-click-action': { name: 'data_exchange', payload: { op: 'open', code: '${form.order}', filter: '${data.filter}', page: '${data.page}' } } },
          ],
        },
      },
      {
        id: 'ORDER', title: 'Order summary',
        data: {
          code: ex('HL-7K2QF'), heading: ex('HL-7K2QF · Paid, money held'), item: ex('Leather bag'), about: ex('Brown, medium size'), has_about: ex(true),
          key: ex('💰 Total price ₦20,000'), info: ex('🛵 Rider Musa'), has_info: ex(false), hint: ex('👉 Dispatch it now'), warn: ex(''), has_warn: ex(false),
          photo1: ex(PIXEL), photo2: ex(PIXEL), photo3: ex(PIXEL), has_photo1: ex(true), has_photo2: ex(false), has_photo3: ex(false),
          primary: ex('dispatch'), primary_label: ex('Dispatch now'), secondary: ex('cantfulfil'), secondary_label: ex('Can\'t fulfil'), has_secondary: ex(true),
          tertiary: ex('decline'), tertiary_label: ex('Decline order'), has_tertiary: ex(false), show_price: ex(false), show_address: ex(false),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            { type: 'Image', src: '${data.photo1}', height: 180, 'scale-type': 'contain', visible: '${data.has_photo1}', 'alt-text': 'Photo of the item' },
            { type: 'Image', src: '${data.photo2}', height: 180, 'scale-type': 'contain', visible: '${data.has_photo2}', 'alt-text': 'Photo of the item' },
            { type: 'Image', src: '${data.photo3}', height: 420, 'scale-type': 'contain', visible: '${data.has_photo3}', 'alt-text': 'Photo of the item, or the receipt' },
            { type: 'TextBody', text: '${data.item}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.about}', visible: '${data.has_about}' },
            { type: 'TextBody', text: '${data.key}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.info}', visible: '${data.has_info}' },
            { type: 'TextBody', text: '${data.warn}', 'font-weight': 'bold', visible: '${data.has_warn}' },
            { type: 'TextCaption', text: '${data.hint}' },
            { type: 'TextInput', name: 'new_price', label: 'Your price (₦)', 'input-type': 'text', required: false, visible: '${data.show_price}', 'max-chars': 20, 'helper-text': 'Total, delivery included. e.g. 18000 or 18k' },
            { type: 'TextArea', name: 'reason', label: 'Why the new price?', required: false, visible: '${data.show_price}', 'max-length': 150, 'helper-text': 'The buyer sees this. Max 150 characters' },
            { type: 'TextArea', name: 'address', label: 'Delivery address', required: false, visible: '${data.show_address}', 'max-length': 300, 'helper-text': 'Street, area and city. Empty = the one above' },
            { type: 'EmbeddedLink', text: '${data.secondary_label}', visible: '${data.has_secondary}', 'on-click-action': { name: 'data_exchange', payload: { op: '${data.secondary}', code: '${data.code}' } } },
            { type: 'EmbeddedLink', text: '${data.tertiary_label}', visible: '${data.has_tertiary}', 'on-click-action': { name: 'data_exchange', payload: { op: '${data.tertiary}', code: '${data.code}' } } },
            { type: 'Footer', label: '${data.primary_label}', 'on-click-action': { name: 'data_exchange', payload: { op: '${data.primary}', code: '${data.code}', new_price: '${form.new_price}', reason: '${form.reason}', address: '${form.address}' } } },
          ],
        },
      },
      {
        id: 'DISPATCH', title: 'Dispatch',
        data: { code: ex('HL-7K2QF'), heading: ex('HL-7K2QF · Leather bag'), method: ex('rider'), show_pickup: ex(false), pickup_address: ex(''), error: ex(''), has_error: ex(false) },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            {
              type: 'RadioButtonsGroup', name: 'method', label: 'How is it getting to the buyer?', required: true, 'init-value': '${data.method}',
              'data-source': [
                { id: 'pickup', title: '📍 Pickup', description: 'The buyer collects it from you' },
                { id: 'rider', title: '🛵 Dispatch rider', description: 'A rider delivers it' },
                { id: 'waybill', title: '🚌 Waybill', description: 'A driver takes it to another city' },
              ],
              'on-select-action': { name: 'data_exchange', payload: { op: 'method', code: '${data.code}', method: '${form.method}' } },
            },
            { type: 'TextArea', name: 'pickup_address', label: 'Pickup address', required: '${data.show_pickup}', 'max-length': 300, visible: '${data.show_pickup}', 'init-value': '${data.pickup_address}', 'helper-text': 'Where the buyer collects it' },
            { type: 'TextBody', text: '${data.error}', 'font-weight': 'bold', visible: '${data.has_error}' },
            {
              type: 'Footer', label: 'Continue',
              'on-click-action': { name: 'data_exchange', payload: { op: 'dispatch_submit', code: '${data.code}', method: '${form.method}', pickup_address: '${form.pickup_address}' } },
            },
          ],
        },
      },
      {
        id: 'COURIER', title: 'Delivery details',
        data: {
          code: ex('HL-7K2QF'), method: ex('rider'), heading: ex('🛵 Ada · HL-7K2QF'), is_rider: ex(true), phone_label: ex('Rider\'s number'),
          name: ex(''), phone: ex(''), fee: ex(''), location: ex('12 Woji Road'), account_number: ex(''),
          banks: exList([{ id: '999992', title: 'OPay' }]), show_banks: ex(false), bank: ex(''), listed_for: ex(''),
          confirm_text: ex(''), show_confirm: ex(false), error: ex(''), has_error: ex(false), footer_label: ex('Continue'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            { type: 'TextInput', name: 'name', label: 'Rider\'s name', 'input-type': 'text', required: '${data.is_rider}', visible: '${data.is_rider}', 'init-value': '${data.name}', 'max-chars': 80 },
            { type: 'TextInput', name: 'phone', label: '${data.phone_label}', 'input-type': 'phone', required: true, 'init-value': '${data.phone}', 'helper-text': `e.g. ${example}` },
            { type: 'TextInput', name: 'fee', label: 'Delivery fee (₦)', 'input-type': 'text', required: true, 'init-value': '${data.fee}', 'max-chars': 20, 'helper-text': 'Paid to them from the order money when the code is right' },
            { type: 'TextArea', name: 'location', label: 'Delivering to', required: true, 'init-value': '${data.location}', 'max-length': 300 },
            { type: 'TextInput', name: 'account_number', label: 'Account number', 'input-type': 'number', required: true, 'init-value': '${data.account_number}', 'max-chars': 10, 'helper-text': '10 digits' },
            { type: 'Dropdown', name: 'bank', label: 'Bank', required: '${data.show_banks}', visible: '${data.show_banks}', 'data-source': '${data.banks}' },
            { type: 'TextInput', name: 'bank_other', label: 'Not listed? Type it', 'input-type': 'text', required: false, visible: '${data.show_banks}', 'max-chars': 40, 'helper-text': 'Only if you picked "My bank isn\'t listed"' },
            { type: 'TextCaption', text: '⚠️ We pay exactly the account you give. Hoolam can\'t recover money sent to a wrong account.' },
            { type: 'TextBody', text: '${data.confirm_text}', 'font-weight': 'bold', visible: '${data.show_confirm}' },
            { type: 'OptIn', name: 'confirm', label: 'Yes, this is the right account', required: '${data.show_confirm}', visible: '${data.show_confirm}' },
            { type: 'TextBody', text: '${data.error}', 'font-weight': 'bold', visible: '${data.has_error}' },
            {
              type: 'Footer', label: '${data.footer_label}',
              'on-click-action': {
                name: 'data_exchange',
                payload: {
                  op: 'courier', code: '${data.code}', method: '${data.method}', name: '${form.name}', phone: '${form.phone}', fee: '${form.fee}',
                  location: '${form.location}', account_number: '${form.account_number}', bank: '${form.bank}', bank_other: '${form.bank_other}',
                  chosen_bank: '${data.bank}', listed_for: '${data.listed_for}', confirm: '${form.confirm}',
                },
              },
            },
          ],
        },
      },
      {
        id: 'CODE', title: 'Handover code',
        data: { code: ex('HL-7K2QF'), heading: ex('🔑 HL-7K2QF'), error: ex(''), has_error: ex(false) },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            { type: 'TextBody', text: 'Type the 4-digit code the receiver gives you.' },
            { type: 'TextBody', text: 'Only hand over the item to the person with the right code.', 'font-weight': 'bold' },
            { type: 'TextInput', name: 'digits', label: 'Handover code', 'input-type': 'passcode', required: true, 'max-chars': 4, 'min-chars': 4 },
            { type: 'TextBody', text: '${data.error}', 'font-weight': 'bold', visible: '${data.has_error}' },
            { type: 'Footer', label: 'Confirm handover', 'on-click-action': { name: 'data_exchange', payload: { op: 'code', code: '${data.code}', digits: '${form.digits}' } } },
          ],
        },
      },
      {
        id: 'DONE', title: 'Hoolam', terminal: true,
        data: { title: ex('✅ Done'), message: ex('We\'ve sent the details in the chat.'), important: ex(''), has_important: ex(false) },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.title}' },
            { type: 'TextBody', text: '${data.message}' },
            { type: 'TextBody', text: '${data.important}', 'font-weight': 'bold', visible: '${data.has_important}' },
            { type: 'Footer', label: 'Back to the chat', 'on-click-action': { name: 'complete', payload: { done: 'yes' } } },
          ],
        },
      },
    ],
  };
}

/**
 * THE BACKUP FORMS, used only if Meta refuses fields that switch between required and optional. Here every field is
 * plainly required (WhatsApp shows "(optional)" on any field that isn't), so each step gets its own screen.
 * Meta allows 10 connections per form, so:
 *  - single order (dispatch alerts): ORDER → DISPATCH → PICKUP | COURIER (rider) | WAYBILL → BANK → CONFIRM → DONE.
 *    The handover code is entered in the chat.
 *  - My orders: FILTER → ORDERS → ORDER → CODE → DONE. "Dispatch now" sends the single-order form to the chat.
 */
function safeOrdersFlowJson(start: FormStart, example = '08012345678') {
  const main = fullOrdersFlowJson(example);
  const pick = (id: string) => main.screens.find((x) => x.id === id)!;
  const details = { code: ex('HL-7K2QF'), method: ex('rider'), heading: ex('🛵 Ada · HL-7K2QF'), name: ex(''), phone: ex(''), fee: ex(''), location: ex('12 Woji Road'), account_number: ex(''), error: ex(''), has_error: ex(false) };
  const carry = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `\${data.${k}}`]));
  const dKeys = ['code', 'method', 'name', 'phone', 'fee', 'location', 'account_number'];
  const err = { type: 'TextBody', text: '${data.error}', 'font-weight': 'bold', visible: '${data.has_error}' };
  const head = { type: 'TextSubheading', text: '${data.heading}' };
  const courierFields = (rider: boolean) => [
    ...(rider ? [{ type: 'TextInput', name: 'name', label: 'Rider\'s name', 'input-type': 'text', required: true, 'init-value': '${data.name}', 'max-chars': 80 }] : []),
    { type: 'TextInput', name: 'phone', label: rider ? 'Rider\'s number' : 'Driver\'s number', 'input-type': 'phone', required: true, 'init-value': '${data.phone}', 'helper-text': `e.g. ${example}` },
    { type: 'TextInput', name: 'fee', label: 'Delivery fee (₦)', 'input-type': 'text', required: true, 'init-value': '${data.fee}', 'max-chars': 20, 'helper-text': 'Paid to them from the order money when the code is right' },
    { type: 'TextArea', name: 'location', label: 'Delivering to', required: true, 'init-value': '${data.location}', 'max-length': 300 },
    { type: 'TextInput', name: 'account_number', label: 'Account number', 'input-type': 'number', required: true, 'init-value': '${data.account_number}', 'max-chars': 10, 'helper-text': '10 digits' },
    err,
    {
      type: 'Footer', label: 'Continue', 'on-click-action': {
        name: 'data_exchange',
        payload: { op: 'courier', v: 'safe', code: '${data.code}', method: rider ? 'rider' : 'waybill', name: rider ? '${form.name}' : '', phone: '${form.phone}', fee: '${form.fee}', location: '${form.location}', account_number: '${form.account_number}' },
      },
    },
  ];
  const screens = {
    DISPATCH: {
      id: 'DISPATCH', title: 'Dispatch', data: { code: ex('HL-7K2QF'), heading: ex('Ada · HL-7K2QF · Leather bag'), error: ex(''), has_error: ex(false) },
      layout: { type: 'SingleColumnLayout', children: [head,
        { type: 'RadioButtonsGroup', name: 'method', label: 'How is it getting to the buyer?', required: true, 'data-source': [
          { id: 'pickup', title: '📍 Pickup', description: 'The buyer collects it from you' },
          { id: 'rider', title: '🛵 Dispatch rider', description: 'A rider delivers it' },
          { id: 'waybill', title: '🚌 Waybill', description: 'A driver takes it to another city' },
        ] },
        err,
        { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { op: 'dispatch_submit', v: 'safe', code: '${data.code}', method: '${form.method}' } } },
      ] },
    },
    PICKUP: {
      id: 'PICKUP', title: 'Pickup', data: { code: ex('HL-7K2QF'), heading: ex('📍 Ada · HL-7K2QF'), pickup_address: ex(''), error: ex(''), has_error: ex(false) },
      layout: { type: 'SingleColumnLayout', children: [head,
        { type: 'TextArea', name: 'pickup_address', label: 'Pickup address', required: true, 'max-length': 300, 'init-value': '${data.pickup_address}', 'helper-text': 'Where the buyer collects it' },
        err,
        { type: 'Footer', label: 'Ready for pickup', 'on-click-action': { name: 'data_exchange', payload: { op: 'dispatch_submit', v: 'safe', code: '${data.code}', method: 'pickup', pickup_address: '${form.pickup_address}' } } },
      ] },
    },
    COURIER: { id: 'COURIER', title: 'Rider', data: details, layout: { type: 'SingleColumnLayout', children: [head, ...courierFields(true)] } },
    WAYBILL: { id: 'WAYBILL', title: 'Waybill', data: details, layout: { type: 'SingleColumnLayout', children: [head, ...courierFields(false)] } },
    BANK: {
      id: 'BANK', title: 'Their bank', data: { ...details, banks: exList([{ id: '999992', title: 'OPay' }]) },
      layout: { type: 'SingleColumnLayout', children: [head,
        { type: 'TextBody', text: 'Which bank is account ${data.account_number} with?' },
        { type: 'Dropdown', name: 'bank', label: 'Bank', required: true, 'data-source': '${data.banks}' },
        { type: 'TextInput', name: 'bank_other', label: 'Not listed? Type it', 'input-type': 'text', required: false, 'max-chars': 40, 'helper-text': 'Only if you picked "My bank isn\'t listed"' },
        err,
        { type: 'Footer', label: 'Check account', 'on-click-action': { name: 'data_exchange', payload: { op: 'courier', v: 'safe', ...carry(dKeys), listed_for: '${data.account_number}', bank: '${form.bank}', bank_other: '${form.bank_other}' } } },
      ] },
    },
    CONFIRM: {
      id: 'CONFIRM', title: 'Check the account', data: { ...details, bank: ex('999992'), confirm_text: ex('This account belongs to MUSA IBRAHIM') },
      layout: { type: 'SingleColumnLayout', children: [head,
        { type: 'TextBody', text: '${data.confirm_text}', 'font-weight': 'bold' },
        { type: 'TextCaption', text: '⚠️ We pay exactly this account. Hoolam can\'t recover money sent to a wrong account.' },
        { type: 'OptIn', name: 'confirm', label: 'Yes, this is the right account', required: true },
        { type: 'Footer', label: 'Dispatch', 'on-click-action': { name: 'data_exchange', payload: { op: 'courier', v: 'safe', ...carry(dKeys), listed_for: '${data.account_number}', chosen_bank: '${data.bank}', confirm: '${form.confirm}' } } },
      ] },
    },
  };
  if (start === 'FILTER') {
    return {
      version: main.version, data_api_version: main.data_api_version,
      routing_model: { FILTER: ['ORDERS', 'DONE'], ORDERS: ['ORDER'], ORDER: ['CODE', 'DONE'], CODE: ['DONE'] },
      screens: [pick('FILTER'), pick('ORDERS'), pick('ORDER'), pick('CODE'), pick('DONE')],
    };
  }
  return {
    version: main.version, data_api_version: main.data_api_version,
    routing_model: { ORDER: ['DISPATCH', 'DONE'], DISPATCH: ['PICKUP', 'COURIER', 'WAYBILL'], PICKUP: ['DONE'], COURIER: ['BANK'], WAYBILL: ['BANK'], BANK: ['CONFIRM'], CONFIRM: ['DONE'] },
    screens: [pick('ORDER'), screens.DISPATCH, screens.PICKUP, screens.COURIER, screens.WAYBILL, screens.BANK, screens.CONFIRM, pick('DONE')],
  };
}

// ---------------------------------------------------------------------------------------------
// The live side
// ---------------------------------------------------------------------------------------------
export interface OrdersFlowOptions {
  db: Db;
  deals: DealService;
  provider: PaymentProvider;
  currency: Currency;
  secret: string;
  /** Puts a chat into a typed-answer state (e.g. the seller's bank account), so the chat carries on. */
  setChatState: (phone: string, state: string, data: Record<string, unknown>) => Promise<void>;
  /** A new order before it's sent (from the chat, either side), and the chat's Send / Edit / Start again. */
  buyPreview?: (phone: string) => Promise<{ side: 'buy' | 'sell'; item: string; about: string; key: string; info: string; warn: string; photos: string[]; card?: { lines: { icon: string; text: string }[]; big: { label: string; value: string }; note: string } } | null>;
  buyAction?: (phone: string, action: 'send' | 'edit' | 'restart', side: 'buy' | 'sell') => Promise<void>;
  /** Hoolam's WhatsApp number (from the console): the example number in hints, and refused as someone else's number. */
  hoolamNumber?: () => string;
  /** Which forms are the backup versions (only if Meta refused the main ones). */
  backupForms?: () => { list: boolean; one: boolean };
  /** Sends the single-order form to the chat (the backup My orders form hands dispatch over to it). */
  openOrder?: (user: User, code: string, screen: 'dispatch' | 'code') => Promise<boolean>;
  /** Starts the ID check in the chat, and comes back to `next` after. */
  startKyc?: (user: User, why: KycWhy, next: KycNext) => Promise<void>;
  /** Downloads photos people sent (for the buyer's preview). */
  media?: { download(mediaId: string): Promise<{ bytes: Buffer } | null> };
  /** Draws the one picture on an order's screen (its status, or the order before Send) with the real amounts. */
  art?: { formImage(art: Art): Promise<string | null> };
  log?: (line: string) => void;
}

type Res = { screen: string; data: Record<string, unknown> };

const OPEN = `('AWAITING_SELLER','AWAITING_BUYER','AWAITING_PAYMENT','FUNDED','SHIPPED','DISPUTED','RELEASING','PAYOUT_PENDING','REFUNDING')`;
const CLOSED = `('COMPLETED','REFUNDED','CANCELLED','EXPIRED')`;

export class OrdersFlow {
  private banks: Bank[] | null = null;
  constructor(private readonly o: OrdersFlowOptions) {}

  private m(minor: number) { return formatMoney(minor, this.o.currency); }

  /** One request from the form (already decrypted). Always answers with a screen; never throws. */
  async handle(req: { action?: string; screen?: string; data?: Record<string, any>; flow_token?: string }): Promise<Record<string, unknown>> {
    const started = Date.now();
    const out = await this.answer(req);
    const r = out as { screen?: string; data?: Record<string, unknown> };
    // one line per request, so a problem on a phone can be matched to what the server answered
    const op = req.data?.op ?? req.data?.action;
    const keys = Object.keys(req.data ?? {}).join(',');
    this.o.log?.(`orders form: ${req.action ?? '?'}${op ? ':' + op : ''} on ${req.screen || '-'}${keys ? ` [${keys}]` : ''} → ${r.screen ?? JSON.stringify(r.data).slice(0, 60)} (${Date.now() - started} ms, ${JSON.stringify(out).length} bytes)`);
    return out;
  }

  private async answer(req: { action?: string; screen?: string; data?: Record<string, any>; flow_token?: string }): Promise<Record<string, unknown>> {
    if (req.action === 'ping') return { data: { status: 'active' } };
    if (req.data?.error || req.data?.error_message) {
      // WhatsApp tells us when it couldn't use one of our answers: this line says exactly why
      this.o.log?.(`orders form: WhatsApp REJECTED our answer: ${JSON.stringify(req.data).slice(0, 500)}`);
      return { data: { acknowledged: true } };
    }
    const t = readToken(this.o.secret, req.flow_token ?? '');
    const user = t ? await this.user(t.phone) : null;
    // the first answer must be the form's own first screen (WhatsApp rejects anything else)
    const entry = t?.entry ?? String(req.flow_token ?? '').split('.')[3];
    const start: FormStart = !entry || entry === 'orders' ? 'FILTER' : 'ORDER';
    const init = req.action === 'INIT';
    if (!t || !user) {
      this.o.log?.(`orders form: token not accepted (${String(req.flow_token ?? '').slice(0, 12)}…)`);
      return this.wrap(init ? this.notice(start, '⌛ This has expired', 'Open My orders again from the menu.') : this.done('⌛ This has expired', 'Open *My orders* again from the menu.'));
    }
    try {
      if (init) return this.wrap(await this.init(user, t));
      if (req.action === 'BACK') return this.wrap(await this.filterScreen(user, t.mode));
      // which form is on their phone: the main one, or the backup (only if Meta refused the main one)
      const backup = t.entry === 'orders' ? !!this.o.backupForms?.().list : !!this.o.backupForms?.().one;
      return this.wrap(await this.exchange(user, t.mode, req.data ?? {}, req.screen ?? '', { backup, list: t.entry === 'orders' }));
    } catch (e) {
      const why = e instanceof DealError ? (e.message !== e.reason ? e.message : 'That step isn\'t available for this order any more.') : 'Something went wrong on our side. Please try again.';
      if (!(e instanceof DealError)) this.o.log?.(`orders form error: ${(e as Error).stack ?? e}`);
      if (init) return this.wrap(this.notice(start, '😕 Can\'t open this', why));
      // stay on a screen WhatsApp allows us to go to from here
      if (req.screen === 'ORDERS') {
        try { const r = await this.ordersScreen(user, t.mode, 'pending', 1); r.data.summary = `⚠️ ${why}`.slice(0, 80); return this.wrap(r); } catch { /* fall through */ }
      }
      return this.wrap(this.done('😕 Not done', why));
    }
  }

  private wrap(r: Res) { return { version: '3.0', screen: r.screen, data: r.data }; }

  private async user(phone: string): Promise<User | null> {
    const r = await this.o.db.query('SELECT id, phone, display_name, blocked, deal_cap_minor, seller_since, menu_mode, kyc_status, kyc_verified_at, kyc_name FROM users WHERE phone=$1', [phone]);
    return r.rows[0] ?? null;
  }

  private async init(user: User, t: { mode: Mode; entry: Entry; code: string | null }): Promise<Res> {
    if (t.entry === 'orders') return this.filterScreen(user, t.mode);
    if (t.entry === 'preview') return this.previewScreen(user);
    if (!t.code) return this.notice('ORDER', '😕 Can\'t open this', 'Open My orders from the menu.');
    // dispatch / code alerts open the order itself: its main button is the step they came for
    return this.orderScreen(user, await this.mine(user, t.code));
  }

  /** A message shown on the form's first screen (the only screen a form may open on). */
  private notice(start: FormStart, title: string, message: string): Res {
    if (start === 'FILTER') return { screen: 'FILTER', data: { heading: `${title}. ${message}`.slice(0, 80), filters: [{ id: 'pending', title: '⏳ Pending', description: 'Try again' }] } };
    return {
      screen: 'ORDER',
      data: {
        code: '-', heading: title.slice(0, 80), details: plain(message), hint: ' ',
        photo1: PIXEL, photo2: PIXEL, photo3: PIXEL, has_photo1: false, has_photo2: false, has_photo3: false,
        primary: 'close', primary_label: 'Back to the chat',
        secondary: 'none', secondary_label: ' ', has_secondary: false, tertiary: 'none', tertiary_label: ' ', has_tertiary: false, show_price: false, show_address: false,
      },
    };
  }

  // ----- the list -----
  private async counts(user: User, mode: Mode) {
    const col = mode === 'seller' ? '(seller_id=$1 OR counter_seller_id=$1)' : 'buyer_id=$1';
    const r = await this.o.db.query(
      `SELECT count(*) FILTER (WHERE status IN ${OPEN})::int AS pending, count(*) FILTER (WHERE status IN ${CLOSED})::int AS completed, count(*)::int AS total
       FROM deals WHERE ${col}`, [user.id]);
    return r.rows[0] as { pending: number; completed: number; total: number };
  }

  private async filterScreen(user: User, mode: Mode): Promise<Res> {
    const c = await this.counts(user, mode);
    const n = (k: number) => `${k} order${k === 1 ? '' : 's'}`;
    return {
      screen: 'FILTER',
      data: {
        heading: mode === 'seller' ? '🏷️ Orders you\'re selling' : '🛒 Orders you\'re buying',
        filters: [
          { id: 'pending', title: '⏳ Pending', description: `${n(c.pending)} still going` },
          { id: 'completed', title: '✅ Completed', description: `${n(c.completed)} finished, refunded or cancelled` },
          { id: 'all', title: '📋 All', description: n(c.total) },
        ],
      },
    };
  }

  private async ordersScreen(user: User, mode: Mode, filter: string, page: number): Promise<Res> {
    const col = mode === 'seller' ? '(seller_id=$1 OR counter_seller_id=$1)' : 'buyer_id=$1';
    const where = filter === 'pending' ? `AND status IN ${OPEN}` : filter === 'completed' ? `AND status IN ${CLOSED}` : '';
    const total = (await this.o.db.query(`SELECT count(*)::int AS n FROM deals WHERE ${col} ${where}`, [user.id])).rows[0].n as number;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    page = Math.min(Math.max(1, page), pages);
    // the other person's name helps tell orders apart: the buyer's for a seller, the seller's for a buyer
    const other = mode === 'seller' ? 'd.buyer_id' : 'COALESCE(d.seller_id, d.counter_seller_id)';
    const rows: (Deal & { other_name: string | null; other_phone: string | null })[] = (await this.o.db.query(
      `SELECT d.*, u.display_name AS other_name, COALESCE(u.phone, d.invited_phone) AS other_phone
       FROM deals d LEFT JOIN users u ON u.id = ${other}
       WHERE ${col.replace(/(seller_id|counter_seller_id|buyer_id)/g, 'd.$1')} ${where.replace('status', 'd.status')}
       ORDER BY d.created_at DESC LIMIT ${PAGE} OFFSET $2`, [user.id, (page - 1) * PAGE])).rows;
    const name = filter === 'pending' ? 'Pending' : filter === 'completed' ? 'Completed' : 'All orders';
    const from = total ? (page - 1) * PAGE + 1 : 0, to = Math.min(total, page * PAGE);
    const orders = rows.map((d) => {
      const next = this.next(d, mode, user);
      const amount = mode === 'seller' ? d.seller_gets_minor : d.buyer_pays_minor;
      return {
        id: d.code,
        title: rowTitle(d.other_name, d.other_phone, mode, d.code, this.m(amount)),
        description: `${d.item.slice(0, 60)}\n${next.needsYou ? '👉 ' + next.hint : `${statusDot(d)} ${cap(STATUS_WORDS[d.status] ?? d.status)}`}`.slice(0, 300),
      };
    });
    // switching filter happens right here (WhatsApp forms can't route back to the first screen)
    const others = [['pending', '⏳ Show pending', 'Orders still going'], ['completed', '✅ Show completed', 'Finished, refunded or cancelled'], ['all', '📋 Show all', 'Every order']]
      .filter(([id]) => id !== filter).map(([id, title, description]) => ({ id: `f-${id}`, title: title!, description: description! }));
    const nav = [
      ...(page < pages ? [{ id: 'next', title: `➡️ Next ${PAGE}`, description: `Orders ${to + 1}–${Math.min(total, to + PAGE)}` }] : []),
      ...(page > 1 ? [{ id: 'prev', title: `⬅️ Previous ${PAGE}`, description: `Orders ${from - PAGE}–${from - 1}` }] : []),
      ...others,
    ];
    return {
      screen: 'ORDERS',
      data: {
        summary: total ? `${name} · ${from}–${to} of ${total}` : `${name} · no orders yet`,
        filter, page: String(page),
        orders: orders.length ? orders : [{ id: 'none', title: 'No orders here yet', description: mode === 'seller' ? 'Sell something from the menu to start one.' : 'Buy something from the menu to start one.' }],
        nav,
      },
    };
  }

  // ----- one order -----
  private async mine(user: User, code: string): Promise<Deal> {
    const deal = await this.o.deals.findByCode(code);
    if (deal && (this.prospectiveSeller(deal, user) || this.prospectiveBuyer(deal, user))) return deal;
    if (!deal || ![deal.buyer_id, deal.seller_id, deal.counter_seller_id].includes(user.id)) throw new DealError('NOT_FOUND', 'We couldn\'t find that order.');
    return deal;
  }

  /** A buyer's order still waiting for a seller: whoever was sent it (alert or link) can look at it as the seller. */
  private prospectiveSeller(d: Deal, user: User): boolean {
    return d.status === 'AWAITING_SELLER' && d.buyer_id !== user.id && !d.seller_id && (!d.counter_seller_id || d.counter_seller_id === user.id);
  }

  /** A seller's order still waiting for its buyer: whoever was sent it (alert or link) can look at it as the buyer. */
  private prospectiveBuyer(d: Deal, user: User): boolean {
    return d.status === 'AWAITING_BUYER' && !d.legacy_ship && d.seller_id !== user.id && !d.buyer_id;
  }

  private role(deal: Deal, user: User): Mode {
    return deal.seller_id === user.id || deal.counter_seller_id === user.id || this.prospectiveSeller(deal, user) ? 'seller' : 'buyer';
  }

  /** The one next step for this person on this order, plus a secondary choice. */
  next(d: Deal, mode: Mode, user?: User): { primary: string; label: string; hint: string; needsYou: boolean; secondary?: string; secondaryLabel?: string; tertiary?: string; tertiaryLabel?: string } {
    const none = (hint: string) => ({ primary: 'close', label: 'Back to the chat', hint, needsYou: false });
    const handed = !!d.handed_over_at;
    if (mode === 'seller' && (!user || d.seller_id === user.id || d.counter_seller_id === user.id || this.prospectiveSeller(d, user))) {
      if (d.status === 'AWAITING_SELLER') {
        if (d.counter_seller_id) return none('Waiting for the buyer to answer your price');
        const left = d.accept_by ? Math.max(1, Math.round((new Date(d.accept_by).getTime() - Date.now()) / 3600_000)) : null;
        return {
          primary: 'accept', label: 'Accept order', hint: `New order: accept, update the price, or decline${left ? ` (within ${left} hour${left === 1 ? '' : 's'})` : ''}`, needsYou: true,
          secondary: 'counterask', secondaryLabel: 'Update price', tertiary: 'decline', tertiaryLabel: 'Decline order',
        };
      }
      if (d.status === 'AWAITING_BUYER') return { ...none(`Waiting for the buyer to accept${d.accept_by ? ` (${this.o.deals.hoursLeft(d)} h left)` : ''}`), secondary: 'scancel', secondaryLabel: 'Cancel order' };
      if (d.status === 'AWAITING_PAYMENT') return none('Accepted. Waiting for the buyer to pay');
      if (d.status === 'FUNDED' && !d.dispatched_at) return { primary: 'dispatch', label: 'Dispatch now', hint: 'Paid: dispatch it now', needsYou: true, secondary: 'cantfulfil', secondaryLabel: 'Can\'t fulfil? Refund' };
      if (d.status === 'SHIPPED' && !handed && d.handover_code) return { primary: 'code', label: 'Enter handover code', hint: 'Enter the handover code at delivery', needsYou: true };
      if (d.status === 'SHIPPED' && handed) return none('Handed over. Waiting for the buyer to confirm');
      return none(STATUS_WORDS[d.status] ?? d.status);
    }
    if (d.status === 'AWAITING_SELLER') return { ...none('Waiting for the seller to accept'), secondary: 'cancel', secondaryLabel: 'Cancel order' };
    if (d.status === 'AWAITING_BUYER' && !d.legacy_ship) {
      const left = this.o.deals.hoursLeft(d);
      return { primary: 'baccept', label: 'Accept order', hint: `New order: accept, then pay (within ${left} hour${left === 1 ? '' : 's'})`, needsYou: true, secondary: 'bdecline', secondaryLabel: 'Decline order' };
    }
    if (d.status === 'AWAITING_PAYMENT') return { primary: 'pay', label: 'Pay now', hint: 'Accepted: pay to start', needsYou: true, secondary: 'cancel', secondaryLabel: 'Cancel order' };
    if (d.status === 'FUNDED' && this.o.deals.isOverdue(d)) return { primary: 'remind', label: 'Send reminder', hint: 'Not dispatched by the date you expected', needsYou: true, secondary: 'refundme', secondaryLabel: 'Refund me' };
    if (d.status === 'FUNDED') return none('Paid. Waiting for the seller to dispatch');
    if (d.status === 'SHIPPED' && !handed && d.handover_code) return { primary: 'showcode', label: 'Show my code', hint: 'On its way. Have your code ready', needsYou: false, secondary: 'problem', secondaryLabel: 'Report a problem' };
    if (d.status === 'SHIPPED') return { primary: 'happy', label: 'I\'m happy', hint: 'Check it, then confirm', needsYou: true, secondary: 'problem', secondaryLabel: 'Report a problem' };
    return none(STATUS_WORDS[d.status] ?? d.status);
  }

  private async orderScreen(user: User, d: Deal, override?: { primary: string; label: string; note: string; showPrice?: boolean; warn?: string }): Promise<Res> {
    const mode = this.role(d, user);
    // the other side opening a new order counts as seen (the person waiting is told once)
    if ((d.status === 'AWAITING_SELLER' && mode === 'seller') || (d.status === 'AWAITING_BUYER' && mode === 'buyer')) {
      await this.o.deals.markSeen(d.code, user).catch(() => {});
      d = (await this.o.deals.findByCode(d.code)) ?? d;
    }
    // the newest receipt, in the form (all of them go to the chat with one tap)
    const receipts = await this.o.deals.receiptsFor(d.id, mode).catch(() => []);
    const last = receipts[receipts.length - 1];
    let receipt: string | null = null;
    if (last) {
      try { const img = await this.o.deals.receiptImage(d.id, last.kind, last.payoutId, true); receipt = img ? img.toString('base64') : null; } catch { receipt = null; }
    }
    const nx = this.next(d, mode, user);
    // a seller's new order, for its buyer: they confirm or type the delivery address right here, then Accept
    const accepting = mode === 'buyer' && d.status === 'AWAITING_BUYER' && !d.legacy_ship;
    const dateLine = d.arrive_by ? `📅 ${d.started_by === 'SELLER' ? 'Ready by' : 'Expected by'} ${dayText(String(d.arrive_by))}` : '';
    const pic = await this.statusPicture(d, mode);
    const photos = pic ? [] : await this.thumbs(d.id);
    const fee = Number(d.delivery_fee_minor);
    const countered = d.status === 'AWAITING_SELLER' && d.counter_price_minor;
    // bold: the money, where and when, codes. Plain: everything else.
    const key = [
      `💰 Total price ${this.m(d.price_minor)}`,
      mode === 'seller' && d.price_minor > d.seller_gets_minor ? `🧾 ${this.o.deals.sellerFeeLabel(d)} −${this.m(d.price_minor - d.seller_gets_minor)}` : '',
      mode === 'seller' ? `💸 You receive ${this.m(d.seller_gets_minor)}${fee ? `, minus ${this.m(fee)} for delivery` : ''}` : '',
      mode === 'buyer' && d.status !== 'AWAITING_SELLER' && d.buyer_pays_minor > d.price_minor ? `🧾 ${this.o.deals.buyerFeeLabel(d)} ${this.m(d.buyer_pays_minor - d.price_minor)}` : '',
      mode === 'buyer' && d.status !== 'AWAITING_SELLER' ? `💳 You pay ${this.m(d.buyer_pays_minor)}` : '',
      countered ? (mode === 'seller' ? `✏️ Your new price ${this.m(d.counter_price_minor!)}` : `✏️ Seller's new price ${this.m(d.counter_price_minor!)}`) : '',
      d.delivery_address ? `📍 Deliver to: ${d.delivery_address}` : accepting ? '📍 Add your delivery address below' : d.started_by === 'SELLER' && d.status === 'AWAITING_BUYER' ? '📍 The buyer adds the delivery address' : '',
      dateLine,
      d.dispatch_method === 'PICKUP' ? `📍 Pickup at: ${d.pickup_address ?? ''}` : '',
      mode === 'buyer' && d.handover_code && !d.handed_over_at && d.status === 'SHIPPED' ? `🔑 Your handover code: ${d.handover_code}` : '',
      d.handed_over_at ? '✅ Handed over' : '',
    ].filter(Boolean).join('\n');
    const waitingOn = (d.status === 'AWAITING_SELLER' && mode === 'buyer') || (d.status === 'AWAITING_BUYER' && mode === 'seller');
    const seen = waitingOn && d.seen_at ? `👀 Seen ${new Date(d.seen_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).replace(',', ' ·')}` : '';
    const info = [
      seen,
      countered && d.counter_reason ? `💬 Reason: ${d.counter_reason}` : '',
      d.dispatch_method === 'RIDER' ? `🛵 Rider: ${d.courier_name ?? ''} ${localPhone(d.courier_phone)}`.trim() : '',
      d.dispatch_method === 'WAYBILL' ? `🚌 Waybill driver: ${localPhone(d.courier_phone)}`.trim() : '',
    ].filter(Boolean).join('\n');
    const about = [d.description ?? '', d.category ? `🏷️ ${categoryTitle(d.category)}` : ''].filter(Boolean).join('\n');
    const p = override ?? { primary: nx.primary, label: nx.label, note: '' };
    // "Send my receipts to the chat" takes a free link slot (WhatsApp allows two links per screen)
    if (receipt && !override) {
      if (!nx.tertiary) { nx.tertiary = 'receipts'; nx.tertiaryLabel = '🧾 Receipts to chat'; }
      else if (!nx.secondary) { nx.secondary = 'receipts'; nx.secondaryLabel = '🧾 Receipts to chat'; }
    }
    // the other person's name comes first: buyer's name, order ID, then everything else
    const otherId = mode === 'seller' ? d.buyer_id : d.seller_id ?? d.counter_seller_id;
    const otherName = otherId ? (await this.o.db.query('SELECT display_name FROM users WHERE id=$1', [otherId])).rows[0]?.display_name : null;
    const other = otherName ? String(otherName).split(' ')[0] : null;
    const status = (STATUS_WORDS[d.status] ?? d.status).replace(/^./, (c) => c.toUpperCase());
    const heading = mode === 'seller' && d.status === 'AWAITING_SELLER' && other
      ? `🛒 ${other} wants to buy from you`
      : accepting && other ? `🛍️ ${other} · ${d.code} · New order for you`
      : other ? `${mode === 'seller' ? '👤' : '🛡️'} ${other} · ${d.code} · ${status}` : `${d.code} · ${status}`;
    return {
      screen: 'ORDER',
      data: {
        code: d.code,
        heading: heading.slice(0, 80),
        item: plain(`${d.item}${heading.includes(d.code) ? '' : ` (${d.code})`}`).slice(0, 300),
        about: plain(about).slice(0, 2000), has_about: !!about,
        key: plain(key).slice(0, 2000),
        info: plain(info).slice(0, 1000), has_info: !!info,
        hint: plain(override ? override.note : (nx.needsYou ? '👉 ' : '') + nx.hint).slice(0, 400) || ' ',
        warn: plain(override?.warn ?? (accepting ? (d.delivery_address ? 'Is the address right? Leave the box empty to use it, or type another.' : 'Type your delivery address in the box below, then accept.') : '')),
        has_warn: !!override?.warn || accepting,
        // one picture: where the money is, with the real amount and the item photo (or, without it, the photos);
        // once money has moved, the newest receipt goes below it
        photo1: pic ?? photos[0] ?? PIXEL, photo2: photos[1] ?? PIXEL, photo3: receipt ?? photos[2] ?? PIXEL,
        has_photo1: !!(pic ?? photos[0]), has_photo2: !!photos[1], has_photo3: !!(receipt ?? photos[2]),
        primary: p.primary, primary_label: p.label.slice(0, 35),
        secondary: nx.secondary ?? 'none', secondary_label: (nx.secondaryLabel ?? ' ').slice(0, 25), has_secondary: !override && !!nx.secondary,
        tertiary: nx.tertiary ?? 'none', tertiary_label: (nx.tertiaryLabel ?? ' ').slice(0, 25), has_tertiary: !override && !!nx.tertiary,
        show_price: !!override?.showPrice, show_address: accepting,
      },
    };
  }

  /** A new order before it's sent (either side): photos, details, then Send / Edit order / Start again. */
  private async previewScreen(user: User): Promise<Res> {
    const p = await this.o.buyPreview?.(user.phone);
    if (!p) return this.notice('ORDER', 'Nothing to check', 'This order has already been sent, or was started again. Check the chat.');
    const photos: string[] = [];
    let first: Buffer | null = null;
    for (const id of p.photos.slice(0, 3)) {
      try {
        const d = await this.o.media?.download(id);
        if (d && !first) first = d.bytes;
        const t = d ? await thumb(d.bytes) : null;
        if (t) photos.push(t);
      } catch { /* skip a photo we can't fetch */ }
    }
    // one picture: the order before Send, with its real total (or what the seller receives), drawn with the first photo
    const pic = p.card && this.o.art ? await this.o.art.formImage(ART.formCheck({ side: p.side === 'sell' ? 'seller' : 'buyer', item: p.item, ...p.card, photo: first })) : null;
    if (pic) photos.splice(0, photos.length, pic);
    return {
      screen: 'ORDER',
      data: {
        code: 'preview', heading: p.side === 'sell' ? '🏷️ Check your order' : '🛒 Check your order',
        item: plain(p.item).slice(0, 300), about: plain(p.about).slice(0, 2000), has_about: !!p.about,
        key: plain(p.key).slice(0, 2000), info: plain(p.info).slice(0, 1000), has_info: !!p.info,
        hint: 'Is everything right?', warn: plain(p.warn), has_warn: true,
        photo1: photos[0] ?? PIXEL, photo2: photos[1] ?? PIXEL, photo3: photos[2] ?? PIXEL,
        has_photo1: !!photos[0], has_photo2: !!photos[1], has_photo3: !!photos[2],
        primary: 'bsend', primary_label: p.side === 'sell' ? 'Send to buyer' : 'Send to seller',
        secondary: 'bedit', secondary_label: 'Edit order', has_secondary: true,
        tertiary: 'brestart', tertiary_label: 'Start again', has_tertiary: true,
        show_price: false, show_address: false,
      },
    };
  }

  /** The order's status picture for this person: the step, where the money is, their amount, the item photo. */
  private async statusPicture(d: Deal, mode: Mode): Promise<string | null> {
    if (!this.o.art) return null;
    const handed = d.status === 'SHIPPED' && !!d.handed_over_at;
    const step = handed ? 5 : stepOf(d.status);
    const seller = mode === 'seller';
    const paid = !['AWAITING_SELLER', 'AWAITING_BUYER', 'AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED'].includes(d.status);
    const title = ({ AWAITING_SELLER: seller ? 'New order' : 'Waiting to accept', AWAITING_BUYER: seller ? 'Waiting to accept' : 'New order', AWAITING_PAYMENT: 'Waiting for payment',
      FUNDED: 'Money held', SHIPPED: handed ? 'Check it' : 'On the way', RELEASING: 'Paying the seller', PAYOUT_PENDING: 'Paying the seller', COMPLETED: 'Done',
      DISPUTED: 'Problem: money frozen', REFUNDING: 'Refunding', REFUNDED: 'Refunded', CANCELLED: 'Cancelled', EXPIRED: 'Closed' } as Record<string, string>)[d.status] ?? cap(STATUS_WORDS[d.status] ?? d.status);
    const money = d.status === 'DISPUTED' ? 'Frozen until a rep sorts it'
      : ['REFUNDING', 'REFUNDED'].includes(d.status) ? 'Going back to the buyer in full'
      : ['CANCELLED', 'EXPIRED'].includes(d.status) ? 'No money moved'
      : step <= 2 ? 'No money has moved yet' : step <= 5 ? 'Held safely by Hoolam' : 'Paid to the seller';
    const amount = seller ? d.seller_gets_minor : d.status === 'AWAITING_SELLER' ? d.price_minor : d.buyer_pays_minor;
    const amountLabel = seller ? (step === 6 ? 'You received' : 'You receive') : d.status === 'AWAITING_SELLER' ? 'Total price' : paid ? 'You paid' : 'You pay';
    const tone = d.status === 'DISPUTED' || ['CANCELLED', 'EXPIRED'].includes(d.status) ? 'red' : step === 6 || d.status === 'REFUNDED' ? 'green' : 'teal';
    return this.o.art.formImage(ART.formStatus({ step: ['CANCELLED', 'EXPIRED'].includes(d.status) ? 0 : step, title, item: d.item, code: d.code, amountLabel, amount: this.m(amount), money, tone, dealId: d.id }));
  }

  /** Small, light copies of the order photos (Meta allows ~300 KB per image; we keep each well under). */
  private async thumbs(dealId: string): Promise<string[]> {
    const r = await this.o.db.query(`SELECT bytes FROM deal_photos WHERE deal_id=$1 AND kind='ITEM' AND bytes IS NOT NULL ORDER BY id LIMIT 3`, [dealId]);
    const out: string[] = [];
    for (const row of r.rows) {
      const t = await thumb(row.bytes);
      if (t) out.push(t);
    }
    return out;
  }

  // ----- actions -----
  private async exchange(user: User, mode: Mode, p: Record<string, any>, screen = '', form: { backup: boolean; list: boolean } = { backup: false, list: false }): Promise<Res> {
    let action = String(p.op ?? p.action ?? '');
    if (!action) {
      // the step name didn't come through: work it out from the screen and what was sent
      if (screen === 'FILTER') action = 'filter';
      else if (screen === 'ORDERS') action = p.to ? 'nav' : 'open';
      else if (screen === 'CODE') action = 'code';
      else if (screen === 'COURIER') action = 'courier';
      else if (screen === 'DISPATCH') action = p.pickup_address !== undefined ? 'dispatch_submit' : 'method';
    }
    if (action === 'filter') return this.ordersScreen(user, mode, ['pending', 'completed', 'all'].includes(p.filter) ? p.filter : 'pending', 1);
    if (action === 'nav') {
      const f = String(p.to ?? '').match(/^f-(pending|completed|all)$/);
      if (f) return this.ordersScreen(user, mode, f[1]!, 1);
      if (p.to === 'filter') return this.ordersScreen(user, mode, 'pending', 1);
      return this.ordersScreen(user, mode, p.filter ?? 'pending', Number(p.page || 1) + (p.to === 'next' ? 1 : -1));
    }
    if (action === 'open') {
      if (!p.code || p.code === 'none') return this.ordersScreen(user, mode, p.filter ?? 'pending', Number(p.page || 1));
      return this.orderScreen(user, await this.mine(user, p.code));
    }
    // ----- the buyer's order before it's sent -----
    if (action === 'bsend' || action === 'bedit' || action === 'brestart') {
      const waiting = await this.o.buyPreview?.(user.phone);
      if (!waiting && action !== 'brestart') return this.done('Already sent', 'This order has already been sent, or was started again. Check the chat.');
      const side = waiting?.side ?? (mode === 'seller' ? 'sell' : 'buy');
      await this.o.buyAction?.(user.phone, action === 'bsend' ? 'send' : action === 'bedit' ? 'edit' : 'restart', side);
      if (action === 'bsend' && side === 'sell') return this.done('📨 Sent to the buyer', 'Your order code and a backup link for the buyer are in the chat. We\'ll tell you the moment they accept.', 'Don\'t send anything before we confirm the money is held.');
      if (action === 'bsend') return this.done('📨 Sent to the seller', 'Your order code and the link for the seller are in the chat. We\'ll tell you when the seller answers.', 'Nothing to pay yet. You pay after the seller accepts.');
      if (action === 'bedit') return this.done('✏️ Edit your order', 'We\'ve sent it to the chat with your answers filled in.', 'Open it in the chat, change what you need, then review again.');
      return this.done('🔄 Start again', 'We\'ve sent a new order form to the chat.');
    }
    if (action === 'close' || action === 'none') return this.done('👍 All set', 'You can come back to *My orders* any time from the menu.');

    const deal = await this.mine(user, String(p.code ?? ''));
    const code = deal.code;
    switch (action) {
      // ----- seller -----
      case 'counterask':
        return this.orderScreen(user, deal, { primary: 'counter', label: 'Send my price', note: `The buyer offered ${this.m(deal.price_minor)}. Type the total that works for you and why. The buyer accepts it or cancels.`, showPrice: true });
      case 'counter': {
        const major = parseAmount(String(p.new_price ?? ''));
        const minor = major ? toMinor(major, this.o.currency) : 0;
        const reason = String(p.reason ?? '').replace(/\s+/g, ' ').trim();
        const again = (warn: string) => this.orderScreen(user, deal, { primary: 'counter', label: 'Send my price', note: `The buyer offered ${this.m(deal.price_minor)}.`, showPrice: true, warn });
        if (!minor) return again('⚠️ Type the price in naira, like 18000 or 18k.');
        const lim = this.o.deals.limitFor(user, minor);
        if (lim === 'too-big') return again(`⚠️ Orders can be up to ${this.m(this.o.deals.reachFor(user))} for now.`);
        if (reason.length < 3) return again('⚠️ Tell the buyer why, in a few words.');
        await this.o.deals.setMenuMode(user, 'seller');
        if (lim === 'kyc') return this.kycFirst(user, 'accept', { kind: 'button', id: `scounter:${code}` });
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          const data = { code, counterMinor: minor, counterReason: reason.slice(0, 150) };
          if (this.sellerNeedsKyc(user)) return this.kycFirst(user, 'seller', { kind: 'ask', state: 'SELLER_BANK', data, message: msg.askSellerBank() });
          await this.o.setChatState(user.phone, 'SELLER_BANK', data);
          return this.done('🏦 One last step', 'Send your account number in the chat (for example 0123456789), then pick your bank.', 'Then we send the buyer your new price.');
        }
        await this.o.deals.counterAsSeller(code, user, acct.id, minor, reason);
        return this.done('✏️ Price sent', `We've asked the buyer if ${this.m(minor)} works, and told them why. We'll tell you when they answer.`);
      }
      case 'accept': {
        await this.o.deals.setMenuMode(user, 'seller');
        if (this.o.deals.limitFor(user, deal.price_minor) === 'kyc') return this.kycFirst(user, 'accept', { kind: 'button', id: `saccept:${code}` });
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct && this.sellerNeedsKyc(user)) return this.kycFirst(user, 'seller', { kind: 'button', id: `saccept:${code}` });
        if (!acct) {
          await this.o.setChatState(user.phone, 'SELLER_BANK', { code });
          return this.done('🏦 One last step', 'Send your account number in the chat (for example 0123456789), then pick your bank.', 'Then the order is accepted.');
        }
        await this.o.deals.acceptAsSeller(code, user, acct.id);
        return this.done('✅ Order accepted', 'We\'ve asked the buyer to pay. We\'ll tell you the moment the money is held.', 'Don\'t send anything before then.');
      }
      case 'receipts': {
        const side = this.role(deal, user);
        const list = await this.o.deals.receiptsFor(deal.id, side);
        if (!list.length) return this.done('🧾 No receipts yet', 'Receipts appear here once money moves on this order.');
        let sent = 0;
        for (const r of list) if (await this.o.deals.sendReceipt(user.phone, deal.id, r.kind, r.payoutId)) sent++;
        return sent
          ? this.done('🧾 Receipts sent', `${sent === 1 ? 'Your receipt is' : `Your ${sent} receipts are`} in the chat now. Keep them or forward them.`)
          : this.done('🧾 Not sent', 'We couldn\'t send them just now. Please try again in a moment.');
      }
      case 'decline':
        await this.o.deals.declineAsSeller(code, user);
        return this.done('Order declined', 'The buyer has been told. No money moved.');
      case 'dispatch':
        if (form.backup && form.list) {
          // the backup My orders form has no room for the dispatch screens: the single-order form does it
          const sent = await this.o.openOrder?.(user, deal.code, 'dispatch');
          return this.done('🚚 Dispatch', sent ? 'We\'ve sent the dispatch form to the chat.' : 'Tap Dispatch now in the chat.', 'Open it there to dispatch this order.');
        }
        return this.dispatchScreen(deal, null, {}, form.backup);
      case 'method': return this.dispatchScreen(deal, null, { method: p.method });
      case 'code': {
        if (p.digits === undefined) {
          if (form.backup && !form.list) { // the backup single-order form has no code screen: the chat takes it
            await this.o.setChatState(user.phone, 'HANDOVER_CODE', { code });
            return this.done('🔑 Handover code', 'Type the 4-digit code in the chat.', 'Only hand over the item to the person with the right code.');
          }
          return this.codeScreen(deal, null);
        }
        const r = await this.o.deals.enterHandoverCode(code, user, String(p.digits));
        if (r === 'ok') return this.done('✅ Handed over', 'The code is right. If there\'s a rider or driver, they\'re being paid now. You\'ll be paid when the buyer confirms.');
        if (r === 'wrong') {
          const fresh = await this.mine(user, code);
          return this.codeScreen(fresh, `❌ That code doesn't match. ${this.o.deals.handoverTries() - fresh.handover_tries} tries left.`);
        }
        if (r === 'locked') return this.done('🔒 Paused', 'Too many wrong codes. A rep will help you finish the handover.', 'Tap Talk to a rep in the menu.');
        return this.done('Nothing to do', 'This order isn\'t waiting for a handover code.');
      }
      case 'cantfulfil':
        return this.orderScreen(user, deal, { primary: 'refundconfirm', label: 'Yes, refund the buyer', note: 'The buyer gets all their money back, Hoolam\'s fee included. Use the back arrow to keep the order.', warn: '⚠️ This can\'t be undone.' });
      case 'refundconfirm':
        await this.o.deals.refundPaidOrder(code, 'seller', user);
        return this.done('💸 Refund started', 'The buyer is being refunded. We\'ve told them.');
      case 'scancel':
        await this.o.deals.cancelBySeller(code, user);
        return this.done('Order cancelled', 'The buyer can\'t accept it any more. No money moved.');
      // ----- buyer -----
      case 'baccept': {
        await this.o.deals.setMenuMode(user, 'buyer');
        if (this.o.deals.limitFor(user, deal.price_minor) === 'kyc') return this.kycFirst(user, 'pay', { kind: 'button', id: `baccept:${code}` });
        const r = await this.o.deals.acceptAsBuyer(code, user, String(p.address ?? ''));
        if (r === 'need-address') return this.orderScreen(user, deal, { primary: 'baccept', label: 'Accept order', note: 'Where should it be delivered?', warn: '⚠️ Type your delivery address (street, area and city), then accept.' });
        if (r === 'closed') return this.done('😕 Not available', 'This order isn\'t waiting for you any more. Check the chat.');
        return this.done('✅ Order accepted', 'Your payment details are in the chat now.', 'Your money stays with Hoolam until you have your item and you\'re happy.');
      }
      case 'bdecline':
        await this.o.deals.declineAsBuyer(code, user);
        return this.done('Order declined', 'The seller has been told. No money moved.');
      case 'pay':
        if (this.o.deals.limitFor(user, deal.price_minor) === 'kyc') return this.kycFirst(user, 'pay', { kind: 'button', id: `pay:${code}` });
        await this.o.deals.requestPayment(code, user);
        return this.done('💳 Payment details sent', 'Your money stays with Hoolam until you\'re happy.', 'The account to pay into is in the chat.');
      case 'cancel':
        await this.o.deals.cancelByBuyer(code, user);
        return this.done('Order cancelled', 'No money moved.');
      case 'showcode':
        return this.done(`🔑 ${deal.handover_code ?? '----'}`, `Your handover code for ${code}. Give it only to the ${deal.dispatch_method === 'PICKUP' ? 'seller' : deal.dispatch_method === 'WAYBILL' ? 'driver' : 'rider'} when the item is in your hands.`);
      case 'happy':
        await this.o.deals.confirmHappy(code, user);
        return this.done('✅ Thank you', 'We\'re paying the seller now. Thanks for buying safely with Hoolam.');
      case 'problem':
        await this.o.deals.openDispute(code, user);
        await this.o.setChatState(user.phone, 'DISPUTE_DETAIL', { code });
        return this.done('🚩 Money frozen', 'A rep looks at it.', 'Tell us what\'s wrong in the chat: type it or send a photo.');
      case 'remind':
        await this.o.deals.remindSeller(code, user);
        return this.done('🔔 Reminder sent', 'We\'ve reminded the seller to dispatch your order.');
      case 'refundme': {
        const r = await this.o.deals.refundPaidOrder(code, 'buyer', user);
        return this.done('💸 Refund', r === 'refunding' ? 'Your refund is on its way.' : 'We need your account to send the refund.', 'Send your account number in the chat, then pick your bank.');
      }
      case 'dispatch_submit': return this.dispatchSubmit(user, deal, p);
      case 'courier': return this.courier(user, deal, p);
    }
    return this.orderScreen(user, deal);
  }

  // ----- dispatch -----
  /** The buyer's first name (headings start with who the order is for). */
  private async buyerFirst(d: Deal): Promise<string> {
    if (!d.buyer_id) return 'Buyer';
    const n = (await this.o.db.query('SELECT display_name FROM users WHERE id=$1', [d.buyer_id])).rows[0]?.display_name as string | undefined;
    return n?.trim().split(/\s+/)[0] || 'Buyer';
  }

  private async dispatchScreen(d: Deal, error: string | null, p: Record<string, any>, backup = false): Promise<Res> {
    if (d.status !== 'FUNDED' || d.dispatched_at) return this.done('Already done', `Order ${d.code} is ${STATUS_WORDS[d.status] ?? d.status}.`);
    if (backup) return { screen: 'DISPATCH', data: { code: d.code, heading: `${await this.buyerFirst(d)} · ${d.code} · ${d.item}`.slice(0, 80), error: error ?? '', has_error: !!error } };
    const method = ['pickup', 'rider', 'waybill'].includes(p.method) ? p.method : '';
    return {
      screen: 'DISPATCH',
      data: {
        code: d.code, heading: `${await this.buyerFirst(d)} · ${d.code} · ${d.item}`.slice(0, 80), method, show_pickup: method === 'pickup',
        pickup_address: String(p.pickup_address ?? ''), error: error ?? '', has_error: !!error,
      },
    };
  }

  private async dispatchSubmit(user: User, deal: Deal, p: Record<string, any>): Promise<Res> {
    const backup = p.v === 'safe';
    const method = String(p.method ?? '');
    if (!['pickup', 'rider', 'waybill'].includes(method)) return this.dispatchScreen(deal, 'Choose pickup, rider or waybill.', p, backup);
    if (method === 'pickup') {
      const address = String(p.pickup_address ?? '').trim();
      if (backup && p.pickup_address === undefined) {
        return { screen: 'PICKUP', data: { code: deal.code, heading: `📍 ${await this.buyerFirst(deal)} · ${deal.code}`, pickup_address: '', error: '', has_error: false } };
      }
      if (address.length < 3) {
        if (backup) return { screen: 'PICKUP', data: { code: deal.code, heading: `📍 ${await this.buyerFirst(deal)} · ${deal.code}`, pickup_address: address, error: 'Type the pickup address.', has_error: true } };
        return this.dispatchScreen(deal, 'Type the pickup address.', p);
      }
      await this.o.deals.dispatch(deal.code, user, { method: 'PICKUP', pickupAddress: address });
      return this.done('✅ Ready for pickup', 'We\'ve sent the buyer the address and their handover code. Enter the code in My orders or the chat.', 'Ask for the code before you hand over the item.');
    }
    const start = { location: deal.delivery_address ?? '' };
    if (backup) return this.backupCourier(deal, method as 'rider' | 'waybill', 'details', start, null);
    return this.courierScreen(deal, method as 'rider' | 'waybill', start, null);
  }

  /** The backup form's rider/driver steps: each on its own screen (details → bank → confirm). */
  private async backupCourier(d: Deal, method: 'rider' | 'waybill', step: 'details' | 'bank' | 'confirm', v: Record<string, any>, error: string | null,
    extra: { banks?: Bank[]; confirm?: { text: string; bank: string } } = {}): Promise<Res> {
    const rider = method === 'rider';
    const data: Record<string, unknown> = {
      code: d.code, method, heading: `${rider ? '🛵' : '🚌'} ${await this.buyerFirst(d)} · ${d.code}`.slice(0, 80),
      name: String(v.name ?? ''), phone: String(v.phone ?? ''), fee: String(v.fee ?? ''), location: String(v.location ?? ''),
      account_number: String(v.account_number ?? ''), error: error ?? '', has_error: !!error,
    };
    if (step === 'details') return { screen: rider ? 'COURIER' : 'WAYBILL', data };
    if (step === 'bank') return { screen: 'BANK', data: { ...data, banks: bankOptions(extra.banks ?? []) } };
    return { screen: 'CONFIRM', data: { ...data, bank: extra.confirm?.bank ?? '', confirm_text: plain(extra.confirm?.text ?? '') } };
  }

  /**
   * The rider or driver's details, in up to three steps on one screen:
   *  1. details and account number → 2. pick the bank (only banks that account number can belong to) →
   *  3. we show whose account it is; they tick "Yes, this is the right account" and dispatch.
   */
  private async courierScreen(d: Deal, method: 'rider' | 'waybill', v: Record<string, any>, error: string | null,
    step: { banks?: Bank[]; listedFor?: string; confirm?: { text: string; bank: string } } = {}): Promise<Res> {
    const rider = method === 'rider';
    const banks = step.banks ?? [];
    return {
      screen: 'COURIER',
      data: {
        code: d.code, method, heading: `${rider ? '🛵' : '🚌'} ${await this.buyerFirst(d)} · ${d.code}`.slice(0, 80), is_rider: rider,
        phone_label: rider ? 'Rider\'s number' : 'Driver\'s number',
        name: String(v.name ?? ''), phone: String(v.phone ?? ''), fee: String(v.fee ?? ''), location: String(v.location ?? ''),
        account_number: String(v.account_number ?? ''),
        banks: banks.length ? bankOptions(banks) : [{ id: 'none', title: '-' }],
        show_banks: banks.length > 0, listed_for: step.listedFor ?? '', bank: step.confirm?.bank ?? '',
        confirm_text: plain(step.confirm?.text ?? ''), show_confirm: !!step.confirm, error: error ?? '', has_error: !!error,
        footer_label: step.confirm ? 'Dispatch' : banks.length ? 'Check account' : 'Continue',
      },
    };
  }

  private async courier(user: User, deal: Deal, p: Record<string, any>): Promise<Res> {
    const method = p.method === 'waybill' ? 'waybill' : 'rider';
    const role = method === 'rider' ? 'rider' : 'driver';
    // the same steps on the main form (one screen) or the backup form (a screen each)
    const backup = p.v === 'safe';
    const ui = {
      details: (why: string) => (backup ? this.backupCourier(deal, method, 'details', p, why) : this.courierScreen(deal, method, p, why)),
      banks: (banks: Bank[], number: string, why: string | null) => (backup
        ? this.backupCourier(deal, method, 'bank', p, why, { banks })
        : this.courierScreen(deal, method, p, why, { banks, listedFor: number })),
      confirm: (text: string, bank: string, number: string) => (backup
        ? this.backupCourier(deal, method, 'confirm', p, null, { confirm: { text, bank } })
        : this.courierScreen(deal, method, p, null, { listedFor: number, confirm: { text, bank } })),
    };
    if (method === 'rider' && String(p.name ?? '').trim().length < 2) return ui.details(`Type the ${role}'s name.`);
    const phone = normalizePhone(String(p.phone ?? ''));
    if (!phone) return ui.details(`Check the ${role}'s phone number, like ${this.example()}.`);
    if (this.isHoolam(phone)) return ui.details(`That's Hoolam's number. Type the ${role}'s number.`);
    const major = parseAmount(String(p.fee ?? ''));
    if (major === null || major === undefined) return ui.details('Type the delivery fee in naira, like 2000.');
    const fee = toMinor(major, this.o.currency);
    if (fee >= deal.seller_gets_minor) return ui.details(`The delivery fee must be less than what you receive (${this.m(deal.seller_gets_minor)}).`);
    const location = String(p.location ?? '').trim();
    if (location.length < 3) return ui.details(`Where is the ${role} delivering to?`);
    const number = String(p.account_number ?? '').replace(/\D/g, '');
    if (number.length !== 10) return ui.details('The account number must be 10 digits.');
    this.banks ??= await this.o.provider.listBanks();
    const choices = bankChoices(number, this.banks);
    // a new (or changed) account number: show the banks it can belong to
    if (p.listed_for !== number) return ui.banks(choices, number, null);
    const picked = String(p.bank ?? '');
    const other = String(p.bank_other ?? '').trim();
    const bank = (other ? matchBank(other, this.banks) : null)
      ?? (picked && picked !== OTHER_BANK ? this.banks.find((b) => b.code === picked) : null)
      ?? this.banks.find((b) => b.code === String(p.chosen_bank ?? ''))
      ?? null;
    if (!bank) {
      const why = other ? `We couldn't find a bank called "${other.slice(0, 30)}". Check the spelling, or pick it from the list.`
        : picked === OTHER_BANK ? 'Type the bank\'s name in "Not listed? Type it".' : 'Pick the bank.';
      return ui.banks(choices, number, why);
    }
    const name = await this.o.provider.resolveAccount(bank.code, number);
    if (!name) return ui.banks(choices, number, `That account number isn't at ${bank.name}. Check the number or pick another bank.`);
    const confirmed = p.confirm === true || p.confirm === 'true';
    if (!confirmed || String(p.chosen_bank ?? '') !== bank.code) {
      return ui.confirm(`This account belongs to ${name} (${bank.name} ${number}).\nThe ${role}'s fee of ${this.m(fee)} goes here once the handover code is right.`, bank.code, number);
    }
    await this.o.deals.dispatch(deal.code, user, {
      method: method === 'rider' ? 'RIDER' : 'WAYBILL', courierName: method === 'rider' ? String(p.name).trim() : null, courierPhone: phone,
      location, feeMinor: fee, account: { bank_code: bank.code, bank_name: bank.name, account_number: number, account_name: name },
    });
    return this.done('✅ Dispatched', `We've sent the buyer the ${role}'s details and their handover code. Enter the code in My orders or the chat. The ${role} is paid the moment it's right.`, `Tell your ${role}: ask the receiver for their 4-digit code and send it to you.`);
  }

  /** Hoolam's own number, the way people write it: the example in every "like 0…" hint. */
  private example(): string { return localPhone(this.o.hoolamNumber?.() ?? '') || '08012345678'; }
  private isHoolam(phone: string): boolean { const h = (this.o.hoolamNumber?.() ?? '').replace(/\D/g, ''); return !!h && phone.replace(/\D/g, '') === h; }

  private async codeScreen(d: Deal, error: string | null): Promise<Res> {
    if (d.status !== 'SHIPPED' || !d.handover_code || d.handed_over_at) return this.done('Nothing to do', `Order ${d.code} isn't waiting for a handover code.`);
    return { screen: 'CODE', data: { code: d.code, heading: `🔑 ${await this.buyerFirst(d)} · ${d.code} · ${d.item}`.slice(0, 80), error: error ?? '', has_error: !!error } };
  }

  private sellerNeedsKyc(user: User): boolean { return this.o.deals.kycOn && !isVerified(user); }

  /** Above their limit (or a seller's first payout account): the ID check happens in the chat, then the step carries on. */
  private async kycFirst(user: User, why: KycWhy, next: KycNext): Promise<Res> {
    if (!this.o.startKyc) return this.done('🪪 ID check needed', 'Please do this step in the chat.');
    await this.o.startKyc(user, why, next);
    return this.done('🪪 Quick ID check first', 'We\'ve sent it to the chat. It takes a minute, and you only do it once.', why === 'seller' ? 'Then add your payout account.' : 'Then this order carries on.');
  }

  /** The last screen. `important` is shown in bold under the message. */
  private done(title: string, message: string, important = ''): Res {
    return { screen: 'DONE', data: { title: title.slice(0, 80), message: plain(message), important: plain(important), has_important: !!important } };
  }
}

