import { createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import type { Db } from '../db.js';
import { formatMoney, parseAmount, toMinor, type Currency } from '../money.js';
import { categoryTitle } from '../deals/categories.js';
import { dayText, DealError, type Deal, type DealService, type User } from '../deals/service.js';
import type { Bank, PaymentProvider } from '../payments/provider.js';
import { matchBank } from './banks.js';
import { normalizePhone } from './inbound.js';
import { STATUS_WORDS } from './messages.js';

/**
 * "MY ORDERS": a WhatsApp form that loads live data from our server (the encrypted endpoint in app.ts).
 * Screens:  FILTER → ORDERS (20 a page, newest first) → ORDER (details, photos, the next step)
 *           ORDER → DISPATCH (pickup / rider / waybill) → COURIER (rider or driver details, account check) → DONE
 *           ORDER → CODE (the handover code) → DONE
 * Every action does exactly what the matching chat button does; the chat gets the usual messages.
 */

export type Entry = 'orders' | 'order' | 'dispatch' | 'code';
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
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function ordersFlowJson() {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: {
      FILTER: ['ORDERS'],
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
              'on-select-action': { name: 'data_exchange', payload: { action: 'filter', filter: '${form.filter}' } },
            },
            { type: 'Footer', label: 'Show orders', 'on-click-action': { name: 'data_exchange', payload: { action: 'filter', filter: '${form.filter}' } } },
          ],
        },
      },
      {
        id: 'ORDERS', title: 'My orders',
        data: {
          summary: ex('Pending · 1–20 of 34'), filter: ex('pending'), page: ex('1'),
          orders: exList([{ id: 'HL-7K2QF', title: 'HL-7K2QF · ₦20,500', description: 'Leather bag\n👉 Dispatch it now' }]),
          nav: exList([{ id: 'next', title: '➡️ Next 20', description: 'Older orders' }]),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.summary}' },
            {
              type: 'RadioButtonsGroup', name: 'order', label: 'Tap an order to open it', required: false, 'data-source': '${data.orders}',
              'on-select-action': { name: 'data_exchange', payload: { action: 'open', code: '${form.order}', filter: '${data.filter}', page: '${data.page}' } },
            },
            {
              type: 'RadioButtonsGroup', name: 'nav', label: 'More', required: false, 'data-source': '${data.nav}',
              'on-select-action': { name: 'data_exchange', payload: { action: 'nav', to: '${form.nav}', filter: '${data.filter}', page: '${data.page}' } },
            },
            { type: 'Footer', label: 'Open order', 'on-click-action': { name: 'data_exchange', payload: { action: 'open', code: '${form.order}', filter: '${data.filter}', page: '${data.page}' } } },
          ],
        },
      },
      {
        id: 'ORDER', title: 'Order',
        data: {
          code: ex('HL-7K2QF'), heading: ex('HL-7K2QF · Paid, money held'), details: ex('*Leather bag*'), hint: ex('👉 Dispatch it now'),
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
            { type: 'TextBody', text: '${data.details}', markdown: true },
            { type: 'TextCaption', text: '${data.hint}' },
            { type: 'TextInput', name: 'new_price', label: 'Your price (₦)', 'input-type': 'text', required: false, visible: '${data.show_price}', 'max-chars': 20, 'helper-text': 'Total, delivery included. e.g. 18000 or 18k' },
            { type: 'EmbeddedLink', text: '${data.secondary_label}', visible: '${data.has_secondary}', 'on-click-action': { name: 'data_exchange', payload: { action: '${data.secondary}', code: '${data.code}' } } },
            { type: 'EmbeddedLink', text: '${data.tertiary_label}', visible: '${data.has_tertiary}', 'on-click-action': { name: 'data_exchange', payload: { action: '${data.tertiary}', code: '${data.code}' } } },
            { type: 'Footer', label: '${data.primary_label}', 'on-click-action': { name: 'data_exchange', payload: { action: '${data.primary}', code: '${data.code}', new_price: '${form.new_price}' } } },
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
              'on-select-action': { name: 'data_exchange', payload: { action: 'method', code: '${data.code}', method: '${form.method}' } },
            },
            { type: 'TextArea', name: 'pickup_address', label: 'Pickup address', required: false, 'max-length': 300, visible: '${data.show_pickup}', 'init-value': '${data.pickup_address}', 'helper-text': 'Where the buyer collects it' },
            { type: 'TextCaption', text: '${data.error}', visible: '${data.has_error}' },
            {
              type: 'Footer', label: 'Continue',
              'on-click-action': { name: 'data_exchange', payload: { action: 'dispatch_submit', code: '${data.code}', method: '${form.method}', pickup_address: '${form.pickup_address}' } },
            },
          ],
        },
      },
      {
        id: 'COURIER', title: 'Delivery details',
        data: {
          code: ex('HL-7K2QF'), method: ex('rider'), heading: ex('🛵 Rider for HL-7K2QF'), is_rider: ex(true),
          name: ex(''), phone: ex(''), fee: ex(''), location: ex('12 Woji Road'), account_number: ex(''), bank: ex(''),
          confirm_text: ex(''), show_confirm: ex(false), error: ex(''), has_error: ex(false), footer_label: ex('Check account'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            { type: 'TextInput', name: 'name', label: 'Rider\'s name', 'input-type': 'text', required: false, visible: '${data.is_rider}', 'init-value': '${data.name}', 'max-chars': 80 },
            { type: 'TextInput', name: 'phone', label: 'Phone number', 'input-type': 'phone', required: true, 'init-value': '${data.phone}' },
            { type: 'TextInput', name: 'fee', label: 'Delivery fee (₦)', 'input-type': 'text', required: true, 'init-value': '${data.fee}', 'max-chars': 20, 'helper-text': 'Paid to them from the order money when the code is right' },
            { type: 'TextArea', name: 'location', label: 'Delivering to', required: true, 'init-value': '${data.location}', 'max-length': 300 },
            { type: 'TextInput', name: 'account_number', label: 'Account number', 'input-type': 'number', required: true, 'init-value': '${data.account_number}', 'max-chars': 10, 'helper-text': '10 digits' },
            { type: 'TextInput', name: 'bank', label: 'Bank', 'input-type': 'text', required: true, 'init-value': '${data.bank}', 'max-chars': 40, 'helper-text': 'e.g. GTBank, Opay, Moniepoint' },
            { type: 'TextCaption', text: '⚠️ We pay exactly the account you give. Hoolam can\'t recover money sent to a wrong account.' },
            { type: 'TextBody', text: '${data.confirm_text}', markdown: true, visible: '${data.show_confirm}' },
            { type: 'OptIn', name: 'confirm', label: 'Yes, this is the right account', required: false, visible: '${data.show_confirm}' },
            { type: 'TextCaption', text: '${data.error}', visible: '${data.has_error}' },
            {
              type: 'Footer', label: '${data.footer_label}',
              'on-click-action': {
                name: 'data_exchange',
                payload: {
                  action: 'courier', code: '${data.code}', method: '${data.method}', name: '${form.name}', phone: '${form.phone}', fee: '${form.fee}',
                  location: '${form.location}', account_number: '${form.account_number}', bank: '${form.bank}', confirm: '${form.confirm}',
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
            { type: 'TextBody', text: 'Type the 4-digit code the receiver gave you. Only hand over the item to the person with the right code.' },
            { type: 'TextInput', name: 'digits', label: 'Handover code', 'input-type': 'passcode', required: true, 'max-chars': 4, 'min-chars': 4 },
            { type: 'TextCaption', text: '${data.error}', visible: '${data.has_error}' },
            { type: 'Footer', label: 'Confirm handover', 'on-click-action': { name: 'data_exchange', payload: { action: 'code', code: '${data.code}', digits: '${form.digits}' } } },
          ],
        },
      },
      {
        id: 'DONE', title: 'Hoolam', terminal: true,
        data: { title: ex('✅ Done'), message: ex('We\'ve sent the details in the chat.') },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.title}' },
            { type: 'TextBody', text: '${data.message}', markdown: true },
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
    if (req.action === 'ping') return { data: { status: 'active' } };
    if (req.data?.error) { this.o.log?.(`orders form reported an error: ${JSON.stringify(req.data).slice(0, 300)}`); return { data: { acknowledged: true } }; }
    const t = readToken(this.o.secret, req.flow_token ?? '');
    if (!t) return this.wrap(this.done('⌛ This has expired', 'Open *My orders* again from the menu.'));
    const user = await this.user(t.phone);
    if (!user) return this.wrap(this.done('⌛ This has expired', 'Open *My orders* again from the menu.'));
    try {
      if (req.action === 'INIT') return this.wrap(await this.init(user, t));
      if (req.action === 'BACK') return this.wrap(await this.filterScreen(user, t.mode));
      return this.wrap(await this.exchange(user, t.mode, req.data ?? {}));
    } catch (e) {
      const why = e instanceof DealError ? (e.message !== e.reason ? e.message : 'That step isn\'t available for this order any more.') : 'Something went wrong on our side. Please try again.';
      if (!(e instanceof DealError)) this.o.log?.(`orders form: ${(e as Error).stack ?? e}`);
      return this.wrap(this.done('😕 Not done', why));
    }
  }

  private wrap(r: Res) { return { version: '3.0', screen: r.screen, data: r.data }; }

  private async user(phone: string): Promise<User | null> {
    const r = await this.o.db.query('SELECT id, phone, display_name, blocked, deal_cap_minor, seller_since, menu_mode FROM users WHERE phone=$1', [phone]);
    return r.rows[0] ?? null;
  }

  private async init(user: User, t: { mode: Mode; entry: Entry; code: string | null }): Promise<Res> {
    if (t.entry === 'orders' || !t.code) return this.filterScreen(user, t.mode);
    const deal = await this.mine(user, t.code);
    if (t.entry === 'dispatch') return this.dispatchScreen(deal, null, {});
    if (t.entry === 'code') return this.codeScreen(deal, null);
    return this.orderScreen(user, deal);
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
    const rows: Deal[] = (await this.o.db.query(`SELECT * FROM deals WHERE ${col} ${where} ORDER BY created_at DESC LIMIT ${PAGE} OFFSET $2`, [user.id, (page - 1) * PAGE])).rows;
    const name = filter === 'pending' ? 'Pending' : filter === 'completed' ? 'Completed' : 'All orders';
    const from = total ? (page - 1) * PAGE + 1 : 0, to = Math.min(total, page * PAGE);
    const orders = rows.map((d) => {
      const next = this.next(d, mode, user);
      const amount = mode === 'seller' ? d.seller_gets_minor : d.buyer_pays_minor;
      return {
        id: d.code,
        title: `${d.code} · ${this.m(amount)}`.slice(0, 30),
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
          primary: 'accept', label: 'Accept order', hint: `New order: accept, change the price, or decline${left ? ` (within ${left} hour${left === 1 ? '' : 's'})` : ''}`, needsYou: true,
          secondary: 'counterask', secondaryLabel: 'Change price', tertiary: 'decline', tertiaryLabel: 'Decline order',
        };
      }
      if (d.status === 'AWAITING_PAYMENT') return none('Waiting for the buyer to pay');
      if (d.status === 'FUNDED' && !d.dispatched_at) return { primary: 'dispatch', label: 'Dispatch now', hint: 'Paid: dispatch it now', needsYou: true, secondary: 'cantfulfil', secondaryLabel: 'Can\'t fulfil (refund the buyer)' };
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

  private async orderScreen(user: User, d: Deal, override?: { primary: string; label: string; note: string; showPrice?: boolean }): Promise<Res> {
    const mode = this.role(d, user);
    const nx = this.next(d, mode, user);
    const photos = await this.thumbs(d.id);
    const lines = [
      `*${d.item}*`,
      d.description ?? '',
      d.category ? `🏷️ ${categoryTitle(d.category)}` : '',
      '',
      mode === 'seller' ? `💰 Total price ${this.m(d.price_minor)}\n💸 You receive ${this.m(d.seller_gets_minor)}${Number(d.delivery_fee_minor) ? `, minus ${this.m(Number(d.delivery_fee_minor))} delivery` : ''}`
        : `💰 Total price ${this.m(d.price_minor)}\n🧾 Hoolam fee ${this.m(d.buyer_pays_minor - d.price_minor)}\n💳 You pay ${this.m(d.buyer_pays_minor)}`,
      d.delivery_address ? `📍 ${d.delivery_address}` : '',
      d.arrive_by ? `📅 Expected by ${dayText(String(d.arrive_by))}` : '',
      d.dispatch_method === 'PICKUP' ? `📍 Pickup at ${d.pickup_address ?? ''}` : '',
      d.dispatch_method === 'RIDER' ? `🛵 Rider ${d.courier_name ?? ''} ${d.courier_phone ?? ''}`.trim() : '',
      d.dispatch_method === 'WAYBILL' ? `🚌 Waybill driver ${d.courier_phone ?? ''}`.trim() : '',
      mode === 'buyer' && d.handover_code && !d.handed_over_at && d.status === 'SHIPPED' ? `🔑 Your handover code: *${d.handover_code}*` : '',
      d.handed_over_at ? '✅ Handed over' : '',
    ].filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
    const pageUrl = this.o.deals.orderPageUrl(d);
    const p = override ?? { primary: nx.primary, label: nx.label, note: '' };
    const buyerName = mode === 'seller' && d.buyer_id ? (await this.o.db.query('SELECT display_name FROM users WHERE id=$1', [d.buyer_id])).rows[0]?.display_name : null;
    const intro = mode === 'seller' && d.status === 'AWAITING_SELLER' && buyerName ? `🛒 *${String(buyerName).split(' ')[0]} wants to buy from you*\n\n` : '';
    return {
      screen: 'ORDER',
      data: {
        code: d.code,
        heading: `${d.code} · ${(STATUS_WORDS[d.status] ?? d.status).replace(/^./, (c) => c.toUpperCase())}`.slice(0, 80),
        details: (intro + lines + (pageUrl ? `\n\n[Open the order page](${pageUrl})` : '')).slice(0, 4000),
        hint: (override ? override.note : (nx.needsYou ? '👉 ' : '') + nx.hint).slice(0, 400),
        photo1: photos[0] ?? PIXEL, photo2: photos[1] ?? PIXEL, photo3: photos[2] ?? PIXEL,
        has_photo1: !!photos[0], has_photo2: !!photos[1], has_photo3: !!photos[2],
        primary: p.primary, primary_label: p.label.slice(0, 35),
        secondary: nx.secondary ?? 'none', secondary_label: (nx.secondaryLabel ?? ' ').slice(0, 25), has_secondary: !override && !!nx.secondary,
        tertiary: nx.tertiary ?? 'none', tertiary_label: (nx.tertiaryLabel ?? ' ').slice(0, 25), has_tertiary: !override && !!nx.tertiary,
        show_price: !!override?.showPrice,
      },
    };
  }

  /** Small, light copies of the order photos (Meta allows ~300 KB per image; we keep each well under). */
  private async thumbs(dealId: string): Promise<string[]> {
    const r = await this.o.db.query(`SELECT bytes FROM deal_photos WHERE deal_id=$1 AND kind='ITEM' AND bytes IS NOT NULL ORDER BY id LIMIT 3`, [dealId]);
    const out: string[] = [];
    for (const row of r.rows) {
      try { out.push((await sharp(row.bytes).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString('base64')); }
      catch { /* skip a photo we can't read */ }
    }
    return out;
  }

  // ----- actions -----
  private async exchange(user: User, mode: Mode, p: Record<string, any>): Promise<Res> {
    const action = String(p.action ?? '');
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
    if (action === 'close' || action === 'none') return this.done('👍 All set', 'You can come back to *My orders* any time from the menu.');

    const deal = await this.mine(user, String(p.code ?? ''));
    const code = deal.code;
    switch (action) {
      // ----- seller -----
      case 'counterask':
        return this.orderScreen(user, deal, { primary: 'counter', label: 'Send my price', note: `The buyer offered ${this.m(deal.price_minor)}. Type the total that works for you; they accept it or cancel.`, showPrice: true });
      case 'counter': {
        const major = parseAmount(String(p.new_price ?? ''));
        const minor = major ? toMinor(major, this.o.currency) : 0;
        if (!minor) return this.orderScreen(user, deal, { primary: 'counter', label: 'Send my price', note: '⚠️ Type the price in naira, like 18000 or 18k.', showPrice: true });
        if (minor > this.o.deals.maxDealMinor) return this.orderScreen(user, deal, { primary: 'counter', label: 'Send my price', note: `⚠️ Orders can be up to ${this.m(this.o.deals.maxDealMinor)} for now.`, showPrice: true });
        await this.o.deals.setMenuMode(user, 'seller');
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          await this.o.setChatState(user.phone, 'SELLER_BANK', { code, counterMinor: minor });
          return this.done('🏦 One last step', 'Send your account number and bank *in the chat* (for example _0123456789 GTBank_), and we\'ll send the buyer your price.');
        }
        await this.o.deals.counterAsSeller(code, user, acct.id, minor);
        return this.done('✏️ Price sent', `We've asked the buyer if ${this.m(minor)} works. We'll tell you when they answer.`);
      }
      case 'accept': {
        await this.o.deals.setMenuMode(user, 'seller');
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          await this.o.setChatState(user.phone, 'SELLER_BANK', { code });
          return this.done('🏦 One last step', 'Send your account number and bank *in the chat* (for example _0123456789 GTBank_), and the order is accepted.');
        }
        await this.o.deals.acceptAsSeller(code, user, acct.id);
        return this.done('✅ Order accepted', 'We\'ve asked the buyer to pay. We\'ll tell you the moment the money is held. Don\'t send anything before then.');
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
        if (r === 'locked') return this.done('🔒 Paused', 'Too many wrong codes. A rep will help you finish the handover. Tap *Talk to a rep* in the menu.');
        return this.done('Nothing to do', 'This order isn\'t waiting for a handover code.');
      }
      case 'cantfulfil':
        return this.orderScreen(user, deal, { primary: 'refundconfirm', label: 'Yes, refund the buyer', note: '⚠️ The buyer gets all their money back, Hoolam\'s fee included. This can\'t be undone. Use the back arrow to keep the order.' });
      case 'refundconfirm':
        await this.o.deals.refundPaidOrder(code, 'seller', user);
        return this.done('💸 Refund started', 'The buyer is being refunded. We\'ve told them.');
      // ----- buyer -----
      case 'pay':
        await this.o.deals.requestPayment(code, user);
        return this.done('💳 Payment details sent', 'We\'ve sent the account to pay into *in the chat*. Your money stays with Hoolam until you\'re happy.');
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
        return this.done('🚩 Money frozen', 'Tell us what\'s wrong *in the chat*: type it or send a photo. A rep looks at it.');
      case 'remind':
        await this.o.deals.remindSeller(code, user);
        return this.done('🔔 Reminder sent', 'We\'ve reminded the seller to dispatch your order.');
      case 'refundme': {
        const r = await this.o.deals.refundPaidOrder(code, 'buyer', user);
        return this.done('💸 Refund', r === 'refunding' ? 'Your refund is on its way.' : 'Send your account number and bank *in the chat*, and we\'ll refund you straight away.');
      }
      case 'dispatch_submit': return this.dispatchSubmit(user, deal, p);
      case 'courier': return this.courier(user, deal, p);
    }
    return this.orderScreen(user, deal);
  }

  // ----- dispatch -----
  private dispatchScreen(d: Deal, error: string | null, p: Record<string, any>): Res {
    if (d.status !== 'FUNDED' || d.dispatched_at) return this.done('Already done', `Order ${d.code} is ${STATUS_WORDS[d.status] ?? d.status}.`);
    const method = ['pickup', 'rider', 'waybill'].includes(p.method) ? p.method : '';
    return {
      screen: 'DISPATCH',
      data: {
        code: d.code, heading: `${d.code} · ${d.item}`.slice(0, 80), method, show_pickup: method === 'pickup',
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
      return this.done('✅ Ready for pickup', 'We\'ve sent the buyer the address and their handover code. *Ask for the code before you hand over the item*, then enter it in My orders or the chat.');
    }
    return this.courierScreen(deal, method as 'rider' | 'waybill', { location: deal.delivery_address ?? '' }, null, null);
  }

  private courierScreen(d: Deal, method: 'rider' | 'waybill', v: Record<string, any>, error: string | null, confirmText: string | null): Res {
    const rider = method === 'rider';
    return {
      screen: 'COURIER',
      data: {
        code: d.code, method, heading: rider ? `🛵 Rider for ${d.code}` : `🚌 Waybill for ${d.code}`, is_rider: rider,
        name: String(v.name ?? ''), phone: String(v.phone ?? ''), fee: String(v.fee ?? ''), location: String(v.location ?? ''),
        account_number: String(v.account_number ?? ''), bank: String(v.bank ?? ''),
        confirm_text: confirmText ?? '', show_confirm: !!confirmText, error: error ?? '', has_error: !!error,
        footer_label: confirmText ? 'Dispatch' : 'Check account',
      },
    };
  }

  private async courier(user: User, deal: Deal, p: Record<string, any>): Promise<Res> {
    const method = p.method === 'waybill' ? 'waybill' : 'rider';
    const role = method === 'rider' ? 'rider' : 'driver';
    const bad = (why: string) => this.courierScreen(deal, method, p, why, null);
    if (method === 'rider' && String(p.name ?? '').trim().length < 2) return bad(`Type the ${role}'s name.`);
    const phone = normalizePhone(String(p.phone ?? ''));
    if (!phone) return bad(`Check the ${role}'s phone number.`);
    const major = parseAmount(String(p.fee ?? ''));
    if (major === null || major === undefined) return bad('Type the delivery fee in naira, like 2000.');
    const fee = toMinor(major, this.o.currency);
    if (fee >= deal.seller_gets_minor) return bad(`The delivery fee must be less than what you receive (${this.m(deal.seller_gets_minor)}).`);
    const location = String(p.location ?? '').trim();
    if (location.length < 3) return bad(`Where is the ${role} delivering to?`);
    const number = String(p.account_number ?? '').replace(/\D/g, '');
    if (number.length !== 10) return bad('The account number must be 10 digits.');
    this.banks ??= await this.o.provider.listBanks();
    const bank = matchBank(String(p.bank ?? ''), this.banks);
    if (!bank) return bad(`We couldn't find a bank called "${String(p.bank ?? '').slice(0, 30)}". Try GTBank, Opay, Moniepoint, Kuda…`);
    const name = await this.o.provider.resolveAccount(bank.code, number);
    if (!name) return bad('That account number didn\'t match the bank. Please check it.');
    const confirmed = p.confirm === true || p.confirm === 'true';
    if (!confirmed) return this.courierScreen(deal, method, p, null, `This account belongs to *${name}* (${bank.name} ••••${number.slice(-4)}).\nThe ${role}'s fee of *${this.m(fee)}* goes here once the handover code is right.`);
    await this.o.deals.dispatch(deal.code, user, {
      method: method === 'rider' ? 'RIDER' : 'WAYBILL', courierName: method === 'rider' ? String(p.name).trim() : null, courierPhone: phone,
      location, feeMinor: fee, account: { bank_code: bank.code, bank_name: bank.name, account_number: number, account_name: name },
    });
    return this.done('✅ Dispatched', `We've sent the buyer the ${role}'s details and their handover code.\n\n*Tell your ${role}: ask the receiver for their 4-digit code and send it to you.* Then enter it in My orders or the chat. The ${role} is paid the moment it's right.`);
  }

  private codeScreen(d: Deal, error: string | null): Res {
    if (d.status !== 'SHIPPED' || !d.handover_code || d.handed_over_at) return this.done('Nothing to do', `Order ${d.code} isn't waiting for a handover code.`);
    return { screen: 'CODE', data: { code: d.code, heading: `🔑 ${d.code} · ${d.item}`.slice(0, 80), error: error ?? '', has_error: !!error } };
  }

  private done(title: string, message: string): Res {
    return { screen: 'DONE', data: { title: title.slice(0, 80), message } };
  }
}

