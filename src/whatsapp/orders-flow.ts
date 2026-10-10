import { createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import type { Db } from '../db.js';
import { formatMoney, parseAmount, toMinor, type Currency } from '../money.js';
import { categoryTitle } from '../deals/categories.js';
import { dayText, DealError, type Deal, type DealService, type User } from '../deals/service.js';
import type { Bank, PaymentProvider } from '../payments/provider.js';
import { bankChoices, matchBank } from './banks.js';
import { normalizePhone } from './inbound.js';
import { STATUS_WORDS } from './messages.js';
import { localPhone } from '../phone.js';

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
/** A small, light copy of a photo for a form (Meta allows ~300 KB per image; we keep each well under). */
async function thumb(bytes: Buffer): Promise<string | null> {
  try { return (await sharp(bytes).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString('base64'); }
  catch { return null; }
}
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

export function ordersFlowJson(start: FormStart = 'FILTER', safe = false) {
  const full = fullOrdersFlowJson(safe);
  if (start === 'FILTER') return full;
  const drop = new Set(['FILTER', 'ORDERS']);
  return {
    ...full,
    routing_model: Object.fromEntries(Object.entries(full.routing_model).filter(([k]) => !drop.has(k))),
    screens: full.screens.filter((x) => !drop.has(x.id)),
  };
}

/** `safe`: no fields that switch between required and optional, and fixed labels (a fallback if Meta refuses those). */
function fullOrdersFlowJson(safe = false) {
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
          tertiary: ex('decline'), tertiary_label: ex('Decline order'), has_tertiary: ex(false), show_price: ex(false),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            { type: 'Image', src: '${data.photo1}', height: 180, 'scale-type': 'contain', visible: '${data.has_photo1}', 'alt-text': 'Photo of the item' },
            { type: 'Image', src: '${data.photo2}', height: 180, 'scale-type': 'contain', visible: '${data.has_photo2}', 'alt-text': 'Photo of the item' },
            { type: 'Image', src: '${data.photo3}', height: 180, 'scale-type': 'contain', visible: '${data.has_photo3}', 'alt-text': 'Photo of the item' },
            { type: 'TextBody', text: '${data.item}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.about}', visible: '${data.has_about}' },
            { type: 'TextBody', text: '${data.key}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.info}', visible: '${data.has_info}' },
            { type: 'TextBody', text: '${data.warn}', 'font-weight': 'bold', visible: '${data.has_warn}' },
            { type: 'TextCaption', text: '${data.hint}' },
            { type: 'TextInput', name: 'new_price', label: 'Your price (₦)', 'input-type': 'text', required: false, visible: '${data.show_price}', 'max-chars': 20, 'helper-text': 'Total, delivery included. e.g. 18000 or 18k' },
            { type: 'TextArea', name: 'reason', label: 'Why the new price?', required: false, visible: '${data.show_price}', 'max-length': 150, 'helper-text': 'The buyer sees this. Max 150 characters' },
            { type: 'EmbeddedLink', text: '${data.secondary_label}', visible: '${data.has_secondary}', 'on-click-action': { name: 'data_exchange', payload: { op: '${data.secondary}', code: '${data.code}' } } },
            { type: 'EmbeddedLink', text: '${data.tertiary_label}', visible: '${data.has_tertiary}', 'on-click-action': { name: 'data_exchange', payload: { op: '${data.tertiary}', code: '${data.code}' } } },
            { type: 'Footer', label: '${data.primary_label}', 'on-click-action': { name: 'data_exchange', payload: { op: '${data.primary}', code: '${data.code}', new_price: '${form.new_price}', reason: '${form.reason}' } } },
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
            { type: 'TextArea', name: 'pickup_address', label: 'Pickup address', required: safe ? false : '${data.show_pickup}', 'max-length': 300, visible: '${data.show_pickup}', 'init-value': '${data.pickup_address}', 'helper-text': 'Where the buyer collects it' },
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
            { type: 'TextInput', name: 'name', label: 'Rider\'s name', 'input-type': 'text', required: safe ? false : '${data.is_rider}', visible: '${data.is_rider}', 'init-value': '${data.name}', 'max-chars': 80 },
            { type: 'TextInput', name: 'phone', label: safe ? 'Phone number' : '${data.phone_label}', 'input-type': 'phone', required: true, 'init-value': '${data.phone}', 'helper-text': 'e.g. 08031234567' },
            { type: 'TextInput', name: 'fee', label: 'Delivery fee (₦)', 'input-type': 'text', required: true, 'init-value': '${data.fee}', 'max-chars': 20, 'helper-text': 'Paid to them from the order money when the code is right' },
            { type: 'TextArea', name: 'location', label: 'Delivering to', required: true, 'init-value': '${data.location}', 'max-length': 300 },
            { type: 'TextInput', name: 'account_number', label: 'Account number', 'input-type': 'number', required: true, 'init-value': '${data.account_number}', 'max-chars': 10, 'helper-text': '10 digits' },
            { type: 'Dropdown', name: 'bank', label: 'Bank', required: false, visible: '${data.show_banks}', 'data-source': '${data.banks}' },
            { type: 'TextInput', name: 'bank_other', label: 'Bank not listed?', 'input-type': 'text', required: false, visible: '${data.show_banks}', 'max-chars': 40, 'helper-text': 'Only if it\'s not in the list above' },
            { type: 'TextCaption', text: '⚠️ We pay exactly the account you give. Hoolam can\'t recover money sent to a wrong account.' },
            { type: 'TextBody', text: '${data.confirm_text}', 'font-weight': 'bold', visible: '${data.show_confirm}' },
            { type: 'OptIn', name: 'confirm', label: 'Yes, this is the right account', required: false, visible: '${data.show_confirm}' },
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
  /** The buyer's order before it's sent (from the chat), and the chat's Send / Edit / Start again. */
  buyPreview?: (phone: string) => Promise<{ item: string; about: string; key: string; info: string; photos: string[] } | null>;
  buyAction?: (phone: string, action: 'send' | 'edit' | 'restart') => Promise<void>;
  /** Downloads photos people sent (for the buyer's preview). */
  media?: { download(mediaId: string): Promise<{ bytes: Buffer } | null> };
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
      return this.wrap(await this.exchange(user, t.mode, req.data ?? {}, req.screen ?? ''));
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
    const r = await this.o.db.query('SELECT id, phone, display_name, blocked, deal_cap_minor, seller_since, menu_mode FROM users WHERE phone=$1', [phone]);
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
        secondary: 'none', secondary_label: ' ', has_secondary: false, tertiary: 'none', tertiary_label: ' ', has_tertiary: false, show_price: false,
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
        description: `${d.item.slice(0, 60)}\n${next.needsYou ? '👉 ' + next.hint : STATUS_WORDS[d.status] ?? d.status}`.slice(0, 300),
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
    if (deal && this.prospectiveSeller(deal, user)) return deal;
    if (!deal || ![deal.buyer_id, deal.seller_id, deal.counter_seller_id].includes(user.id)) throw new DealError('NOT_FOUND', 'We couldn\'t find that order.');
    return deal;
  }

  /** A buyer's order still waiting for a seller: whoever was sent it (alert or link) can look at it as the seller. */
  private prospectiveSeller(d: Deal, user: User): boolean {
    return d.status === 'AWAITING_SELLER' && d.buyer_id !== user.id && !d.seller_id && (!d.counter_seller_id || d.counter_seller_id === user.id);
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
      if (d.status === 'AWAITING_PAYMENT') return none('Waiting for the buyer to pay');
      if (d.status === 'FUNDED' && !d.dispatched_at) return { primary: 'dispatch', label: 'Dispatch now', hint: 'Paid: dispatch it now', needsYou: true, secondary: 'cantfulfil', secondaryLabel: 'Can\'t fulfil? Refund' };
      if (d.status === 'SHIPPED' && !handed && d.handover_code) return { primary: 'code', label: 'Enter handover code', hint: 'Enter the handover code at delivery', needsYou: true };
      if (d.status === 'SHIPPED' && handed) return none('Handed over. Waiting for the buyer to confirm');
      return none(STATUS_WORDS[d.status] ?? d.status);
    }
    if (d.status === 'AWAITING_SELLER') return { ...none('Waiting for the seller to accept'), secondary: 'cancel', secondaryLabel: 'Cancel order' };
    if (d.status === 'AWAITING_PAYMENT') return { primary: 'pay', label: 'Pay now', hint: 'Accepted: pay to start', needsYou: true, secondary: 'cancel', secondaryLabel: 'Cancel order' };
    if (d.status === 'FUNDED' && this.o.deals.isOverdue(d)) return { primary: 'remind', label: 'Send reminder', hint: 'Not dispatched by the date you expected', needsYou: true, secondary: 'refundme', secondaryLabel: 'Refund me' };
    if (d.status === 'FUNDED') return none('Paid. Waiting for the seller to dispatch');
    if (d.status === 'SHIPPED' && !handed && d.handover_code) return { primary: 'showcode', label: 'Show my code', hint: 'On its way. Have your code ready', needsYou: false, secondary: 'problem', secondaryLabel: 'Report a problem' };
    if (d.status === 'SHIPPED') return { primary: 'happy', label: 'I\'m happy', hint: 'Check it, then confirm', needsYou: true, secondary: 'problem', secondaryLabel: 'Report a problem' };
    return none(STATUS_WORDS[d.status] ?? d.status);
  }

  private async orderScreen(user: User, d: Deal, override?: { primary: string; label: string; note: string; showPrice?: boolean; warn?: string }): Promise<Res> {
    const mode = this.role(d, user);
    const nx = this.next(d, mode, user);
    const photos = await this.thumbs(d.id);
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
      d.delivery_address ? `📍 Deliver to: ${d.delivery_address}` : '',
      d.arrive_by ? `📅 Expected by ${dayText(String(d.arrive_by))}` : '',
      d.dispatch_method === 'PICKUP' ? `📍 Pickup at: ${d.pickup_address ?? ''}` : '',
      mode === 'buyer' && d.handover_code && !d.handed_over_at && d.status === 'SHIPPED' ? `🔑 Your handover code: ${d.handover_code}` : '',
      d.handed_over_at ? '✅ Handed over' : '',
    ].filter(Boolean).join('\n');
    const info = [
      countered && d.counter_reason ? `💬 Reason: ${d.counter_reason}` : '',
      d.dispatch_method === 'RIDER' ? `🛵 Rider: ${d.courier_name ?? ''} ${localPhone(d.courier_phone)}`.trim() : '',
      d.dispatch_method === 'WAYBILL' ? `🚌 Waybill driver: ${localPhone(d.courier_phone)}`.trim() : '',
    ].filter(Boolean).join('\n');
    const about = [d.description ?? '', d.category ? `🏷️ ${categoryTitle(d.category)}` : ''].filter(Boolean).join('\n');
    const p = override ?? { primary: nx.primary, label: nx.label, note: '' };
    const buyerName = mode === 'seller' && d.buyer_id ? (await this.o.db.query('SELECT display_name FROM users WHERE id=$1', [d.buyer_id])).rows[0]?.display_name : null;
    const heading = mode === 'seller' && d.status === 'AWAITING_SELLER' && buyerName
      ? `🛒 ${String(buyerName).split(' ')[0]} wants to buy from you`
      : `${d.code} · ${(STATUS_WORDS[d.status] ?? d.status).replace(/^./, (c) => c.toUpperCase())}`;
    return {
      screen: 'ORDER',
      data: {
        code: d.code,
        heading: heading.slice(0, 80),
        item: plain(`${d.item}${heading.startsWith(d.code) ? '' : ` (${d.code})`}`).slice(0, 300),
        about: plain(about).slice(0, 2000), has_about: !!about,
        key: plain(key).slice(0, 2000),
        info: plain(info).slice(0, 1000), has_info: !!info,
        hint: plain(override ? override.note : (nx.needsYou ? '👉 ' : '') + nx.hint).slice(0, 400) || ' ',
        warn: plain(override?.warn ?? ''), has_warn: !!override?.warn,
        photo1: photos[0] ?? PIXEL, photo2: photos[1] ?? PIXEL, photo3: photos[2] ?? PIXEL,
        has_photo1: !!photos[0], has_photo2: !!photos[1], has_photo3: !!photos[2],
        primary: p.primary, primary_label: p.label.slice(0, 35),
        secondary: nx.secondary ?? 'none', secondary_label: (nx.secondaryLabel ?? ' ').slice(0, 25), has_secondary: !override && !!nx.secondary,
        tertiary: nx.tertiary ?? 'none', tertiary_label: (nx.tertiaryLabel ?? ' ').slice(0, 25), has_tertiary: !override && !!nx.tertiary,
        show_price: !!override?.showPrice,
      },
    };
  }

  /** The buyer's order before it's sent: photos, details, then Send to seller / Edit order / Start again. */
  private async previewScreen(user: User): Promise<Res> {
    const p = await this.o.buyPreview?.(user.phone);
    if (!p) return this.notice('ORDER', 'Nothing to check', 'This order has already been sent, or was started again. Check the chat.');
    const photos: string[] = [];
    for (const id of p.photos.slice(0, 3)) {
      try {
        const d = await this.o.media?.download(id);
        const t = d ? await thumb(d.bytes) : null;
        if (t) photos.push(t);
      } catch { /* skip a photo we can't fetch */ }
    }
    return {
      screen: 'ORDER',
      data: {
        code: 'preview', heading: '🛒 Check your order',
        item: plain(p.item).slice(0, 300), about: plain(p.about).slice(0, 2000), has_about: !!p.about,
        key: plain(p.key).slice(0, 2000), info: plain(p.info).slice(0, 1000), has_info: !!p.info,
        hint: 'Is everything right?', warn: 'Nothing to pay yet. You pay after the seller accepts.', has_warn: true,
        photo1: photos[0] ?? PIXEL, photo2: photos[1] ?? PIXEL, photo3: photos[2] ?? PIXEL,
        has_photo1: !!photos[0], has_photo2: !!photos[1], has_photo3: !!photos[2],
        primary: 'bsend', primary_label: 'Send to seller',
        secondary: 'bedit', secondary_label: 'Edit order', has_secondary: true,
        tertiary: 'brestart', tertiary_label: 'Start again', has_tertiary: true,
        show_price: false,
      },
    };
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
  private async exchange(user: User, mode: Mode, p: Record<string, any>, screen = ''): Promise<Res> {
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
      await this.o.buyAction?.(user.phone, action === 'bsend' ? 'send' : action === 'bedit' ? 'edit' : 'restart');
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
        if (minor > this.o.deals.maxDealMinor) return again(`⚠️ Orders can be up to ${this.m(this.o.deals.maxDealMinor)} for now.`);
        if (reason.length < 3) return again('⚠️ Tell the buyer why, in a few words.');
        await this.o.deals.setMenuMode(user, 'seller');
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          await this.o.setChatState(user.phone, 'SELLER_BANK', { code, counterMinor: minor, counterReason: reason.slice(0, 150) });
          return this.done('🏦 One last step', 'Send your account number in the chat (for example 0123456789), then pick your bank.', 'Then we send the buyer your new price.');
        }
        await this.o.deals.counterAsSeller(code, user, acct.id, minor, reason);
        return this.done('✏️ Price sent', `We've asked the buyer if ${this.m(minor)} works, and told them why. We'll tell you when they answer.`);
      }
      case 'accept': {
        await this.o.deals.setMenuMode(user, 'seller');
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          await this.o.setChatState(user.phone, 'SELLER_BANK', { code });
          return this.done('🏦 One last step', 'Send your account number in the chat (for example 0123456789), then pick your bank.', 'Then the order is accepted.');
        }
        await this.o.deals.acceptAsSeller(code, user, acct.id);
        return this.done('✅ Order accepted', 'We\'ve asked the buyer to pay. We\'ll tell you the moment the money is held.', 'Don\'t send anything before then.');
      }
      case 'decline':
        await this.o.deals.declineAsSeller(code, user);
        return this.done('Order declined', 'The buyer has been told. No money moved.');
      case 'dispatch': return this.dispatchScreen(deal, null, {});
      case 'method': return this.dispatchScreen(deal, null, { method: p.method });
      case 'code': {
        if (p.digits === undefined) return this.codeScreen(deal, null);
        const r = await this.o.deals.enterHandoverCode(code, user, String(p.digits));
        if (r === 'ok') return this.done('✅ Handed over', 'The code is right. If there\'s a rider or driver, they\'re being paid now. You\'ll be paid when the buyer confirms.');
        if (r === 'wrong') {
          const fresh = await this.mine(user, code);
          return this.codeScreen(fresh, `❌ That code doesn't match. ${5 - fresh.handover_tries} tries left.`);
        }
        if (r === 'locked') return this.done('🔒 Paused', 'Too many wrong codes. A rep will help you finish the handover.', 'Tap Talk to a rep in the menu.');
        return this.done('Nothing to do', 'This order isn\'t waiting for a handover code.');
      }
      case 'cantfulfil':
        return this.orderScreen(user, deal, { primary: 'refundconfirm', label: 'Yes, refund the buyer', note: 'The buyer gets all their money back, Hoolam\'s fee included. Use the back arrow to keep the order.', warn: '⚠️ This can\'t be undone.' });
      case 'refundconfirm':
        await this.o.deals.refundPaidOrder(code, 'seller', user);
        return this.done('💸 Refund started', 'The buyer is being refunded. We\'ve told them.');
      // ----- buyer -----
      case 'pay':
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

  private async dispatchScreen(d: Deal, error: string | null, p: Record<string, any>): Promise<Res> {
    if (d.status !== 'FUNDED' || d.dispatched_at) return this.done('Already done', `Order ${d.code} is ${STATUS_WORDS[d.status] ?? d.status}.`);
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
    const method = String(p.method ?? '');
    if (!['pickup', 'rider', 'waybill'].includes(method)) return this.dispatchScreen(deal, 'Choose pickup, rider or waybill.', p);
    if (method === 'pickup') {
      const address = String(p.pickup_address ?? '').trim();
      if (address.length < 3) return this.dispatchScreen(deal, 'Type the pickup address.', p);
      await this.o.deals.dispatch(deal.code, user, { method: 'PICKUP', pickupAddress: address });
      return this.done('✅ Ready for pickup', 'We\'ve sent the buyer the address and their handover code. Enter the code in My orders or the chat.', 'Ask for the code before you hand over the item.');
    }
    return this.courierScreen(deal, method as 'rider' | 'waybill', { location: deal.delivery_address ?? '' }, null);
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
        banks: banks.length ? banks.map((b) => ({ id: b.code, title: b.name.slice(0, 30) })) : [{ id: 'none', title: '-' }],
        show_banks: banks.length > 0, listed_for: step.listedFor ?? '', bank: step.confirm?.bank ?? '',
        confirm_text: plain(step.confirm?.text ?? ''), show_confirm: !!step.confirm, error: error ?? '', has_error: !!error,
        footer_label: step.confirm ? 'Dispatch' : banks.length ? 'Check account' : 'Continue',
      },
    };
  }

  private async courier(user: User, deal: Deal, p: Record<string, any>): Promise<Res> {
    const method = p.method === 'waybill' ? 'waybill' : 'rider';
    const role = method === 'rider' ? 'rider' : 'driver';
    const bad = (why: string) => this.courierScreen(deal, method, p, why);
    if (method === 'rider' && String(p.name ?? '').trim().length < 2) return bad(`Type the ${role}'s name.`);
    const phone = normalizePhone(String(p.phone ?? ''));
    if (!phone) return bad(`Check the ${role}'s phone number, like 08031234567.`);
    const major = parseAmount(String(p.fee ?? ''));
    if (major === null || major === undefined) return bad('Type the delivery fee in naira, like 2000.');
    const fee = toMinor(major, this.o.currency);
    if (fee >= deal.seller_gets_minor) return bad(`The delivery fee must be less than what you receive (${this.m(deal.seller_gets_minor)}).`);
    const location = String(p.location ?? '').trim();
    if (location.length < 3) return bad(`Where is the ${role} delivering to?`);
    const number = String(p.account_number ?? '').replace(/\D/g, '');
    if (number.length !== 10) return bad('The account number must be 10 digits.');
    this.banks ??= await this.o.provider.listBanks();
    const choices = bankChoices(number, this.banks);
    // a new (or changed) account number: show the banks it can belong to
    if (p.listed_for !== number) return this.courierScreen(deal, method, p, null, { banks: choices, listedFor: number });
    const picked = String(p.bank ?? '');
    const other = String(p.bank_other ?? '').trim();
    const bank = (other ? matchBank(other, this.banks) : null)
      ?? this.banks.find((b) => b.code === picked)
      ?? this.banks.find((b) => b.code === String(p.chosen_bank ?? ''))
      ?? null;
    if (!bank) return this.courierScreen(deal, method, p, other ? `We couldn't find a bank called "${other.slice(0, 30)}". Pick it from the list.` : 'Pick the bank.', { banks: choices, listedFor: number });
    const name = await this.o.provider.resolveAccount(bank.code, number);
    if (!name) return this.courierScreen(deal, method, p, `That account number isn't at ${bank.name}. Check the number or pick another bank.`, { banks: choices, listedFor: number });
    const confirmed = p.confirm === true || p.confirm === 'true';
    if (!confirmed || String(p.chosen_bank ?? '') !== bank.code) {
      return this.courierScreen(deal, method, p, null, {
        listedFor: number,
        confirm: { bank: bank.code, text: `This account belongs to ${name} (${bank.name} ••••${number.slice(-4)}).\nThe ${role}'s fee of ${this.m(fee)} goes here once the handover code is right.` },
      });
    }
    await this.o.deals.dispatch(deal.code, user, {
      method: method === 'rider' ? 'RIDER' : 'WAYBILL', courierName: method === 'rider' ? String(p.name).trim() : null, courierPhone: phone,
      location, feeMinor: fee, account: { bank_code: bank.code, bank_name: bank.name, account_number: number, account_name: name },
    });
    return this.done('✅ Dispatched', `We've sent the buyer the ${role}'s details and their handover code. Enter the code in My orders or the chat. The ${role} is paid the moment it's right.`, `Tell your ${role}: ask the receiver for their 4-digit code and send it to you.`);
  }

  private codeScreen(d: Deal, error: string | null): Res {
    if (d.status !== 'SHIPPED' || !d.handover_code || d.handed_over_at) return this.done('Nothing to do', `Order ${d.code} isn't waiting for a handover code.`);
    return { screen: 'CODE', data: { code: d.code, heading: `🔑 ${d.code} · ${d.item}`.slice(0, 80), error: error ?? '', has_error: !!error } };
  }

  /** The last screen. `important` is shown in bold under the message. */
  private done(title: string, message: string, important = ''): Res {
    return { screen: 'DONE', data: { title: title.slice(0, 80), message: plain(message), important: plain(important), has_important: !!important } };
  }
}

