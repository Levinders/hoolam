import { SOCIAL_NAMES, type SocialKind } from '../socials.js';
import type { Db } from '../db.js';
import { formatMoney, parseAmount, toMinor, type Currency } from '../money.js';
import { PRICING, quote, type FeeBand } from '../pricing.js';
import { FakeProvider } from '../payments/fake.js';
import type { PaymentProvider } from '../payments/provider.js';
import { DealError, isVerified, type BuyerDealInput, type DealService, type MenuMode, type User } from '../deals/service.js';
import { readDob, type KycMethod, type KycService } from '../kyc.js';
import { bus } from '../events.js';
import { CATEGORIES, categoryTitle, isCategory } from '../deals/categories.js';
import type { ContactCard, Messenger, Outbound } from './client.js';
import type { Inbound } from './inbound.js';
import { COMMANDS, ICE_BREAKER_STEPS, type MenuItem } from './automation.js';
import { localPhone, msg, STATUS_WORDS, type KycWhy } from './messages.js';
import { lagosDate, parseDay } from '../phone.js';
import { readBuyForm, type Side } from './buy-flow.js';
import { normalizePhone } from './inbound.js';
import { bankChoices, matchBank, parseBankInput } from './banks.js';
import type { Bank } from '../payments/provider.js';
import { dayText } from '../deals/service.js';
import { firstName, reviewProblem, VIDEO_MAX_BYTES, type Trust } from '../trust.js';
import type { Ambassadors } from '../ambassadors.js';
import { AmbassadorChat, SENT_ME_RE } from './amb-flow.js';
import { MarketChat } from '../market/market-chat.js';
import { readOrderForm } from '../market/market-forms.js';
import { payoutToken, problemReasonTitle, readPageForm, readPayoutToken, readProblemForm, readRateForm } from './more-forms.js';
import type { Market } from '../market/market.js';
import { ART } from '../chat-art/build.js';

/**
 * The WhatsApp conversation. Each person has a small state (what we're waiting for from them)
 * stored in chat_sessions. Buttons carry the deal code, so most taps need no state at all.
 */

type State =
  | 'IDLE' | 'SELL_ITEM' | 'SELL_PRICE' | 'SELL_BANK' | 'SELL_BANK_CONFIRM' | 'SELL_CONFIRM'
  | 'DISPUTE_DETAIL' | 'REFUND_BANK' | 'REFUND_BANK_CONFIRM'
  | 'BUY_CODE' | 'ACCOUNT_BANK' | 'ACCOUNT_BANK_CONFIRM' | 'HUMAN_MESSAGE'
  | 'BUY_FORM' | 'BUY_ITEM' | 'BUY_DESC' | 'BUY_CATEGORY' | 'BUY_PRICE' | 'BUY_ADDRESS' | 'BUY_DATE' | 'BUY_PHOTOS' | 'BUY_SELLER' | 'BUY_CONFIRM'
  | 'SELLER_BANK' | 'SELLER_BANK_CONFIRM'
  | 'SELL_FORM' | 'SELL_PHOTOS' | 'SELL_BUYER' | 'SELLER_COUNTER_PRICE' | 'SELLER_COUNTER_REASON' | 'SHIP_PROOF'
  | 'CHECK_SELLER' | 'RATE_COMMENT' | 'REVIEW_TEXT' | 'REVIEW_CONSENT' | 'PROFILE_VIDEO' | 'PROFILE_NAME' | 'PROFILE_CITY' | 'PROFILE_PHOTO' | 'PROFILE_SOCIAL'
  | 'SETUP_NAME' | 'SETUP_CITY' | 'DISPATCH' | 'HANDOVER_CODE' | 'BUYER_ADDRESS'
  | 'KYC_METHOD' | 'KYC_DOB' | 'KYC_NUMBER' | 'PIN_NOTE'
  | 'AMB_NAME' | 'AMB_PHOTO' | 'AMB_ASK'
  | `MK_${string}`; // the market (see market-chat.ts)

/**
 * Where to pick up after an ID check: tap the same button again, carry on with the new order, ask the next
 * question (the payout account), or send the payouts that were waiting.
 */
export type KycNext =
  | { kind: 'button'; id: string }
  | { kind: 'draft'; draft: Record<string, any> }
  | { kind: 'ask'; state: string; data: Record<string, any>; message: Outbound }
  | { kind: 'payout' }
  | { kind: 'none' };
interface Session { state: State; data: Record<string, any>; isNew: boolean }

export interface FlowOptions {
  db: Db;
  deals: DealService;
  provider: PaymentProvider;
  messenger: Messenger;
  currency: Currency;
  testMode?: boolean;
  /** The buyer's WhatsApp form, once it exists on Meta. Null = ask in the chat instead. */
  buyForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  /** The buyer's form filled in with their answers ("Edit order"). Null = change things in the chat instead. */
  buyEditForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  /** The seller's WhatsApp form, once it exists on Meta. */
  sellForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  /** The seller's form filled in with their answers ("Edit order"). */
  sellEditForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  /** The live "My orders" form (needs the forms endpoint). Returns false when it can't be sent. */
  ordersForm?: { open(phone: string, user: User, at: { screen: 'orders' | 'order' | 'dispatch' | 'code' | 'preview'; code?: string; item?: string; totalMinor?: number; mode?: 'buyer' | 'seller'; fresh?: boolean }): Promise<boolean> };
  /** Called when WhatsApp refuses to send a form, so we stop trying until the next restart. */
  onFormRefused?: (key: 'buy' | 'sell' | 'buyEdit' | 'sellEdit' | 'kyc' | 'mkList' | 'mkEdit' | 'mkOrder' | 'payout' | 'problem' | 'page' | 'rate', phone: string) => Promise<void> | void;
  /** Payout account (live), Report a problem, My page, Rating: when they can be sent (else the chat asks). */
  extraForm?: (key: 'payout' | 'problem' | 'page' | 'rate') => { flowId: string; mode: 'draft' | 'published' } | null;
  /** How long a rep takes to answer a problem (hours), for the problem form. */
  problemHours?: () => number;
  /** The market's forms (list an item, edit an item, delivery for a market order), when they can be sent. */
  marketForm?: (key: 'mkList' | 'mkEdit' | 'mkOrder') => { flowId: string; mode: 'draft' | 'published' } | null;
  /** Seller and buyer records. */
  trust?: Trust;
  /** Where public seller pages live, e.g. https://hoolam.onrender.com */
  publicBaseUrl?: string;
  /** Hoolam's WhatsApp number (console), so nobody can use it as the other person's number. */
  hoolamNumber?: () => string;
  /** Hoolam's contact card, sent once on someone's first message. Null = don't send. */
  contactCard?: () => ContactCard | null;
  /** ID checks (BVN/NIN). */
  kyc?: KycService;
  /** The ID check form, once it exists on Meta. Null = ask in the chat instead. */
  kycForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  /** Fetches photos people send (for a seller's page photo). */
  media?: { download(mediaId: string): Promise<{ bytes: Buffer; mimeType?: string } | null> };
  /** The ambassador programme (menu row, applying, setup, the Ambassador screen, links from ambassadors). */
  ambassadors?: Ambassadors;
  /** Its WhatsApp forms: the application, and Details (live). */
  ambApplyForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  ambDetailsForm?: () => { flowId: string; mode: 'draft' | 'published' } | null;
  onAmbFormRefused?: (key: 'ambApply' | 'ambDetails', phone: string) => Promise<void> | void;
  /** The Hoolam market (Features → Market). */
  market?: Market;
  /** Where item pages live: go.hoolam.com/i/<code> */
  itemUrl?: (code: string) => string;
  formSecret?: string;
  siteUrl?: string;
  log?: (line: string) => void;
}

/**
 * What someone has told us so far about a new order, kept in the chat session until they tap Send.
 * The same for both sides (Sell something is the mirror of Buy something): `side` says whose order it is.
 */
interface BuyDraft {
  side?: Side;                                         // 'buy' (default) or 'sell'
  item?: string; description?: string | null; category?: string; priceMinor?: number; // price = the total, delivery included
  address?: string | null;                             // seller: null = the buyer adds it
  addressPin?: string | null;                          // "lat,lng" when the address came from a shared location
  arriveBy?: string | null;                            // buyer: expected by; seller: ready by
  photos?: { mediaId: string; mimeType?: string | null }[]; photosDone?: boolean;
  otherPhone?: string;                                 // the seller's number (buyer's order) or the buyer's (seller's order)
  accountId?: string;                                  // seller: where they're paid
  market?: { listingId: number; qty: number; priceMinor: number; title: string }[]; // from the market (one seller)
}
const MAX_PHOTOS = 3;
const BUY_FROM_RE = /^buy from @([a-z0-9-]{1,40})\b/i;
export const BUY_THIS_RE = /\bbuy this:?\s*([a-z0-9]+(?:-[a-z0-9]+)+)\b(?:.*?\bad[: ]+([a-z0-9-]{1,30}))?/i;

const CODE_RE = /\bHL-?([A-Z2-9]{5})\b/i;


const clean = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s/-]/gu, '').replace(/\s+/g, ' ').trim();

/** "/sell" etc. Built from COMMANDS in automation.ts, so the two never drift apart. Works at any point. */
const SLASH: Record<string, MenuItem> = { start: 'open', human: 'human', deals: 'orders', code: 'pay', ...Object.fromEntries(COMMANDS.map((c) => [c.name, c.goTo])) };
/** Words that always bring the menu back, whatever we were waiting for. */
const GREETINGS = ['menu', 'hi', 'hello', 'start', 'help', 'hey', 'main menu', 'good morning', 'good afternoon', 'good evening'];
/** Typed phrases (the ice breakers first) understood when nothing else is in progress. */
const PHRASES: Record<string, MenuItem> = {
  ...Object.fromEntries(ICE_BREAKER_STEPS.map((i) => [clean(i.text), i.goTo])),
  'i want to sell something': 'sell', 'sell': 'sell', 'sell something': 'sell',
  'i have an order code': 'pay', 'i have a deal code to pay': 'pay', 'pay': 'pay', 'pay for a deal': 'pay', 'pay for an order': 'pay', 'i have a deal code': 'pay', 'code': 'pay', 'order code': 'pay',
  'a seller sent me a deal code': 'pay',
  'buy': 'buy', 'buy something': 'buy', 'i want to buy something': 'buy', 'buy safely': 'buy',
  'how does hoolam work': 'how', 'how it works': 'how', 'how hoolam works': 'how',
  'get help': 'support', 'i need help': 'support', 'help me': 'support',
  'i need to talk to a person': 'human', 'i want to talk to a person': 'human', 'talk to a person': 'human', 'talk to a rep': 'human', 'rep': 'human', 'agent': 'human', 'support': 'support',
  'my orders': 'orders', 'orders': 'orders', 'my deals': 'orders', 'deals': 'orders', 'fees': 'fees', 'fee': 'fees', 'price': 'fees',
  'check a seller': 'check', 'check seller': 'check', 'my trust card': 'card', 'trust card': 'card',
  'market': 'market', 'browse': 'market', 'browse the market': 'market', 'shop': 'market', 'my items': 'items', 'list an item': 'items',
  'my account': 'me', 'report a problem': 'problem', 'problem': 'problem', 'my payout account': 'account', 'payout account': 'account', 'account': 'account',
  'switch to selling': 'tosell', 'switch to buying': 'tobuy', 'switch': 'switch', 'im selling': 'tosell', 'im buying': 'tobuy',
};

export class Conversation {
  private readonly amb: AmbassadorChat | null;
  readonly mkt: MarketChat | null;
  constructor(private readonly o: FlowOptions) {
    this.amb = o.ambassadors ? new AmbassadorChat(o.ambassadors, {
      save: (phone, state, data = {}) => this.save(phone, state as State, data),
      send: (phone, m) => this.send(phone, m),
      startKyc: async (phone, user, next) => {
        const fresh = (await this.userByPhone(phone)) ?? user;
        return this.startKyc(phone, fresh, 'ambassador', next);
      },
      askBank: async (phone, then) => { await this.save(phone, 'ACCOUNT_BANK', { then }); return this.bankPrompt(phone, 'ACCOUNT_BANK', msg.askBank()); },
      menu: async (phone, user) => { await this.save(phone, 'IDLE'); return this.send(phone, await this.menuMsg(user, modeOf(user))); },
      continueTo: async (phone, user, item) => this.openMenuItem(phone, user, item, true),
      download: async (id) => (this.o.media ? (await this.o.media.download(id))?.bytes ?? null : null),
      applyForm: () => this.o.ambApplyForm?.() ?? null,
      detailsForm: () => this.o.ambDetailsForm?.() ?? null,
      formRefused: (key, phone) => this.o.onAmbFormRefused?.(key, phone),
      secret: o.formSecret ?? 'hoolam',
      siteUrl: o.siteUrl ?? 'https://hoolam.com',
      log: o.log,
    }) : null;
    this.mkt = o.market ? new MarketChat(o.market, {
      send: (phone, m) => this.send(phone, m),
      save: (phone, state, data = {}) => this.save(phone, state as State, data),
      menu: async (phone, user) => { await this.save(phone, 'IDLE'); return this.send(phone, await this.menuMsg(user, modeOf(user))); },
      startOrder: async (phone, user, d) => {
        if (user.menu_mode !== 'buyer') await this.o.deals.setMenuMode(user, 'buyer');
        const draft: BuyDraft = { side: 'buy', item: d.item, description: d.description, category: d.category, priceMinor: d.priceMinor, otherPhone: d.sellerPhone, ...(d.address ? { address: d.address } : {}), photos: [], photosDone: true, market: d.market };
        // the delivery address and date in one short form (the chat asks the same if they type, or when the form can't be sent)
        const f = !d.address ? this.o.marketForm?.('mkOrder') ?? null : null;
        if (f && this.o.deals.limitFor(user, d.priceMinor) === 'ok') {
          await this.save(phone, 'BUY_ADDRESS', draft as Record<string, any>);
          const status = await this.send(phone, {
            kind: 'form', header: '🚚 Where should it come?', cta: 'Add delivery', flowId: f.flowId, mode: f.mode, flowToken: 'mkorder:v1', screen: 'ORDER',
            text: `*${d.item}*\nYour delivery address, and when you expect it. Then you check the order before it goes to the seller.\n\n🔒 Nothing is paid yet.`,
            footer: 'Prefer typing? Just send the address.',
            data: { item: d.item.slice(0, 80), address: '', pickup: false },
          });
          if (status !== 'FAILED') return;
          await this.o.onFormRefused?.('mkOrder', phone);
        }
        return this.continueBuying(phone, draft);
      },
      form: (key) => this.o.marketForm?.(key) ?? null,
      formRefused: (key, phone) => this.o.onFormRefused?.(key, phone),
      setupSeller: (phone, user) => this.startSetup(phone, user, 'items'),
      kyc: (phone, user) => this.startKyc(phone, user, 'seller', { kind: 'button', id: 'mk:items' }),
      askBank: async (phone) => { await this.save(phone, 'ACCOUNT_BANK', {}); return this.bankPrompt(phone, 'ACCOUNT_BANK', msg.askBank()); },
      download: async (id) => (this.o.media ? (await this.o.media.download(id))?.bytes ?? null : null),
      sellerPhone: async (id) => (await this.o.db.query('SELECT phone FROM users WHERE id=$1', [id])).rows[0]?.phone ?? null,
      buyerQuote: (p) => this.o.deals.buyerQuote(p, true),
      pageUrl: (code) => this.o.itemUrl?.(code) ?? `${this.o.publicBaseUrl ?? 'https://hoolam.com'}/i/${code}`,
      log: o.log,
    }) : null;
  }

  /** The menu for this person: their side's options, and the ambassador row last when it applies to them. */
  private async menuMsg(user: User, mode: MenuMode, note?: string): Promise<Outbound> {
    const row = this.o.ambassadors ? await this.o.ambassadors.menuRow(user).catch(() => null) : null;
    return msg.menu(user.display_name, mode, note, row);
  }

  private async session(phone: string): Promise<Session> {
    const r = await this.o.db.query(
      `INSERT INTO chat_sessions (phone, last_inbound_at) VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE SET last_inbound_at=now() RETURNING state, data, (xmax = 0) AS is_new`, [phone]);
    return { state: r.rows[0].state, data: r.rows[0].data ?? {}, isNew: r.rows[0].is_new === true };
  }

  private async save(phone: string, state: State, data: Record<string, any> = {}) {
    await this.o.db.query('UPDATE chat_sessions SET state=$2, data=$3, updated_at=now() WHERE phone=$1', [phone, state, JSON.stringify(data)]);
  }

  private send(phone: string, m: Outbound) { return this.o.messenger.send(phone, m); }
  /** Hoolam's own number, typed as the other person's? */
  private isHoolam(phone: string): boolean { const h = (this.o.hoolamNumber?.() ?? '').replace(/\D/g, ''); return !!h && phone.replace(/\D/g, '') === h; }

  /** The message we're answering, per person: corrections quote it (see fix). */
  private readonly lastIn = new Map<string, string>();
  /** A correction or an acknowledgement shows the message it's about, quoted above it. */
  private fix(phone: string, o: Outbound): Outbound { const id = this.lastIn.get(phone); return id ? { ...o, replyTo: id } : o; }

  /** Once, on someone's first message (buyer, seller, rider, anyone): why save Hoolam, then the contact card. */
  private async contactCardOnce(phone: string): Promise<void> {
    const card = this.o.contactCard?.() ?? null;
    if (!card) return;
    const r = await this.o.db.query('INSERT INTO contact_cards (phone) VALUES ($1) ON CONFLICT DO NOTHING RETURNING phone', [phone]).catch(() => null);
    if (!r?.rowCount) return;
    await this.send(phone, msg.saveHoolam());
    await this.send(phone, { kind: 'contact', contact: card });
  }

  async handle(m: Inbound): Promise<void> {
    const s = await this.session(m.phone);
    const user = await this.o.deals.upsertUser(m.phone, m.name);
    if (!m.id.startsWith('kyc-') && !m.id.startsWith('form-')) this.lastIn.set(m.phone, m.id);
    if (this.lastIn.size > 5000) this.lastIn.delete(this.lastIn.keys().next().value!);
    if (s.isNew) await this.contactCardOnce(m.phone).catch((e) => this.o.log?.(`contact card: ${(e as Error).message}`));
    try {
      await this.route(m, s, user);
    } catch (e) {
      if (e instanceof DealError) {
        if (e.reason === 'NEEDS_KYC') return void (await this.kycFromError(m, s, user));
        const map: Record<Exclude<DealError['reason'], 'NEEDS_KYC'>, Outbound> = {
          NOT_FOUND: msg.dealNotFound(), NOT_ALLOWED: msg.notAllowed(), OWN_DEAL: msg.ownDeal(),
          TAKEN: msg.dealTaken(), CLOSED: msg.notAllowed(), TOO_BIG: msg.priceTooHigh({ minor: this.o.deals.reachFor(user), currency: this.o.currency }),
        };
        await this.send(m.phone, map[e.reason]);
        return;
      }
      this.o.log?.(`flow error for ${m.phone}: ${(e as Error).stack ?? e}`);
      await this.send(m.phone, msg.somethingWrong());
    }
  }

  private async route(m: Inbound, s: Session, user: User): Promise<unknown> {
    // A paused account can only talk to the team.
    if (user.blocked && m.buttonId !== 'menu:human' && s.state !== 'HUMAN_MESSAGE') return this.send(m.phone, msg.accountPaused());
    const text = m.text.trim();
    const lower = text.toLowerCase();

    // ----- buttons that carry a deal code -----
    if (m.buttonId) {
      const [action, code] = m.buttonId.split(':');
      switch (action) {
        case 'menu':
          if (code === 'amb' && this.amb) return this.amb.open(m.phone, user);
          return this.openMenuItem(m.phone, user, (code === 'help' ? 'how' : code === 'deals' ? 'orders' : code) as MenuItem);
        case 'mk': {
          if (!this.mkt || !this.o.market?.on()) return this.openMenuItem(m.phone, user, 'open');
          if (/^MK_[LE]_/.test(s.state) && /^mk:(photosdone|lcat|stock1|ldel|lsame|lpl|pend|edel|lgo|lchg|ephdone)\b/.test(m.buttonId)) {
            return this.mkt.listingStep(m.phone, user, s.state, s.data, { type: m.type, text, mediaId: m.mediaId, buttonId: m.buttonId });
          }
          return this.mkt.button(m.phone, user, m.buttonId);
        }
        case 'amb': {
          if (!this.amb) return this.send(m.phone, msg.didntUnderstand());
          const [, what, arg] = m.buttonId.split(':');
          return this.amb.button(m.phone, user, what ?? '', arg);
        }
        case 'setup':
          if (code === 'wname' && s.state === 'SETUP_NAME') { // keep the name buyers already see
            await this.save(m.phone, 'SETUP_CITY', s.data);
            return this.send(m.phone, msg.setupCity());
          }
          if (code === 'nocity' && s.state === 'SETUP_CITY') return this.finishSetup(m.phone, user, s.data.next);
          return this.openMenuItem(m.phone, user, 'open');
        case 'sproblem':
          await this.save(m.phone, 'HUMAN_MESSAGE', { code });
          return this.send(m.phone, msg.askSellerProblem(code!, await this.buyerNameFor(code!)));
        case 'account':
          if (this.sellerNeedsKyc(user)) return this.startKyc(m.phone, user, 'seller', { kind: 'ask', state: 'ACCOUNT_BANK', data: {}, message: msg.askNewAccount() });
          await this.save(m.phone, 'ACCOUNT_BANK');
          return this.bankPrompt(m.phone, 'ACCOUNT_BANK', msg.askNewAccount());
        // ----- ID check -----
        case 'kyc': return this.kycButton(m.phone, s, user, code ?? '');
        case 'pay': await this.o.deals.setMenuMode(user, 'buyer'); return this.o.deals.requestPayment(code!, user);
        case 'newacct': return this.o.deals.requestPayment(code!, user, true);
        case 'cancel': return this.o.deals.cancelByBuyer(code!, user);
        case 'shipped': {
          const d = await this.o.deals.findByCode(code!);
          if (d && !d.legacy_ship) return this.startDispatch(m.phone, user, code!);
          await this.o.deals.markShipped(code!, user);
          return this.save(m.phone, 'SHIP_PROOF', { code });
        }
        // ----- dispatch, handover code, refunds on paid orders -----
        case 'dispatch': return this.startDispatch(m.phone, user, code!);
        case 'dm': return this.dispatchMethod(m.phone, user, s, code as 'pickup' | 'rider' | 'waybill');
        case 'dloc':
          if (s.state !== 'DISPATCH') return this.send(m.phone, msg.didntUnderstand());
          return this.dispatchStep(m.phone, user, { ...s.data, location: s.data.buyerAddress ?? '', pin: s.data.buyerPin ?? null });
        case 'bpick': return this.bankPicked(m.phone, user, s, code!);
        case 'dacct': {
          if (s.state !== 'DISPATCH' || !s.data.pendingAccount) return this.send(m.phone, msg.didntUnderstand());
          if (code !== 'yes') { const { pendingAccount: _p, ...rest } = s.data; return this.dispatchStep(m.phone, user, { ...rest, account: undefined }); }
          return this.dispatchStep(m.phone, user, { ...s.data, account: s.data.pendingAccount, pendingAccount: undefined });
        }
        case 'hcode': // the seller, or the rider/driver from the message Hoolam sent them at dispatch
          if (await this.o.deals.askForHandoverCode(code!, user)) await this.save(m.phone, 'HANDOVER_CODE', { code });
          else await this.save(m.phone, 'IDLE');
          return;
        case 'hcodeshow': return this.o.deals.showHandoverCode(code!, user);
        case 'srefund': {
          await this.save(m.phone, 'IDLE');
          const d = await this.o.deals.findByCode(code!);
          return this.send(m.phone, msg.confirmSellerRefund(code!, await this.o.deals.nameOf(d?.buyer_id)));
        }
        case 'srefundok': await this.save(m.phone, 'IDLE'); await this.o.deals.refundPaidOrder(code!, 'seller', user); return;
        case 'remind': return this.o.deals.remindSeller(code!, user);
        case 'refundme': await this.save(m.phone, 'IDLE'); await this.o.deals.refundPaidOrder(code!, 'buyer', user); return;
        case 'noproof':
          await this.save(m.phone, 'IDLE');
          return this.send(m.phone, msg.dealStatusNow(code!, 'SHIPPED'));
        case 'happy': return this.o.deals.confirmHappy(code!, user);
        case 'problem':
          return this.startProblem(m.phone, user, code!);
        case 'bank': return this.bankAnswer(m.phone, s, user, code === 'yes');
        // ----- buyer's deal -----
        case 'buy': return this.draftButton(m.phone, s, user, 'buy', code!);
        case 'bfix': return this.fixBuying(m.phone, s, code!);
        case 'bdate': {
          if (s.state !== 'BUY_DATE') return this.continueBuying(m.phone, s.data);
          const soonest = s.data.side === 'sell' ? 0 : 1; // a seller can be ready today
          return this.continueBuying(m.phone, { ...s.data, arriveBy: lagosDate(Math.min(30, Math.max(soonest, Number(code) || soonest))) });
        }
        case 'cat':
          if (s.state !== 'BUY_CATEGORY' || !isCategory(code)) return this.continueBuying(m.phone, s.data);
          return this.continueBuying(m.phone, { ...s.data, category: code });

        // ----- the seller's side of a buyer's deal -----
        case 'pin': return this.pinNote(m.phone, user, s, null);
        case 'sview': {
          await this.save(m.phone, 'IDLE');
          await this.o.deals.markSeen(code!, user);
          // a new order for a seller opens in the form (photos, details, Accept / Update price / Decline); the chat is the fallback
          const d = await this.o.deals.findByCode(code!);
          if (d?.status === 'AWAITING_SELLER' && d.buyer_id !== user.id && !d.seller_id && this.o.ordersForm
            && (await this.o.ordersForm.open(m.phone, user, { screen: 'order', code: d.code, mode: 'seller' }))) return;
          return this.o.deals.showToSeller(code!, user);
        }
        case 'saccept': await this.o.deals.setMenuMode(user, 'seller'); return this.sellerAccepts(m.phone, user, code!);
        case 'sdecline': {
          await this.save(m.phone, 'IDLE');
          const d = await this.o.deals.findByCode(code!);
          // Alerted by number? Ask if it's "not interested" or "wrong number" (then we never alert them again).
          if (d?.status === 'AWAITING_SELLER' && d.invited_phone === m.phone) return this.send(m.phone, msg.askDeclineReason(code!));
          return this.o.deals.declineAsSeller(code!, user);
        }
        case 'sno': await this.save(m.phone, 'IDLE'); return this.o.deals.declineAsSeller(code!, user);
        case 'scounter': await this.o.deals.setMenuMode(user, 'seller'); return this.startCounter(m.phone, user, code!);
        case 'cyes': await this.save(m.phone, 'IDLE'); return this.o.deals.acceptCounter(code!, user);
        // ----- trust card -----
        case 'record': return this.o.deals.showSellerRecord(code!, user);
        case 'rateup': case 'ratedown': {
          const happy = action === 'rateup';
          await this.save(m.phone, 'IDLE');
          const form = this.o.extraForm?.('rate') ?? null;
          const r = await this.o.deals.rateDeal(code!, user, happy, !form);
          if (r !== 'ok') return;
          if (!happy) await this.save(m.phone, 'RATE_COMMENT', { code });
          if (form && (await this.rateForm(m.phone, user, code!, happy, form))) return;
          if (form) { const seller = (await this.sellerNameFor(code!)) ?? 'the seller'; return this.send(m.phone, happy ? msg.askReview(seller, code!) : msg.askRatingComment(code!)); }
          return;
        }
        case 'ratenote': await this.save(m.phone, 'IDLE'); return this.send(m.phone, msg.ratingCommentThanks());
        // ----- a few words for the seller's page (after a happy rating), shown only with their yes -----
        case 'revw': {
          const seller = (await this.sellerNameFor(code!)) ?? 'the seller';
          await this.save(m.phone, 'REVIEW_TEXT', { code, seller });
          return this.send(m.phone, msg.askReviewText(seller));
        }
        case 'revno': await this.save(m.phone, 'IDLE'); return this.send(m.phone, msg.reviewSkipped());
        case 'revyes': case 'revpriv': {
          if (s.state !== 'REVIEW_CONSENT' || s.data.code !== code) return this.send(m.phone, msg.reviewSkipped());
          await this.save(m.phone, 'IDLE');
          const show = action === 'revyes';
          await this.o.deals.saveReview(code!, user, String(s.data.text), show);
          return this.send(m.phone, show ? msg.reviewShown(String(s.data.seller ?? 'the seller')) : msg.reviewPrivate());
        }
        case 'buyfrom': return this.buyFrom(m.phone, user, code!);
        case 'card': return this.cardAction(m.phone, user, code!);
        // ----- the buyer's side of a seller's order -----
        case 'bview': await this.save(m.phone, 'IDLE'); await this.o.deals.setMenuMode(user, 'buyer'); await this.o.deals.markSeen(code!, user); return this.viewAsBuyer(m.phone, user, code!);
        case 'baccept': await this.o.deals.setMenuMode(user, 'buyer'); return this.buyerAccepts(m.phone, user, code!);
        case 'baddr': {
          if (s.state !== 'BUYER_ADDRESS' || s.data.code !== code) return this.buyerAccepts(m.phone, user, code!);
          await this.save(m.phone, 'IDLE');
          return this.acceptWithAddress(m.phone, user, code!, null);
        }
        case 'bdecline': {
          await this.save(m.phone, 'IDLE');
          const d = await this.o.deals.findByCode(code!);
          // alerted by number? Ask if it's "not interested" or "wrong number" (then that seller can't alert them again)
          if (d?.status === 'AWAITING_BUYER' && d.invited_phone === m.phone) return this.send(m.phone, msg.askBuyerDeclineReason(code!));
          return this.o.deals.declineAsBuyer(code!, user);
        }
        case 'bno': await this.save(m.phone, 'IDLE'); return this.o.deals.declineAsBuyer(code!, user);
        case 'bnotme': await this.save(m.phone, 'IDLE'); return this.o.deals.declineAsBuyer(code!, user, true);
        case 'snotme': await this.save(m.phone, 'IDLE'); return this.o.deals.declineAsSeller(code!, user, true);
        case 'scancel': await this.save(m.phone, 'IDLE'); return this.o.deals.cancelBySeller(code!, user);
        case 'sell': return this.draftButton(m.phone, s, user, 'sell', code!);
      }
    }

    // ----- they opened the chat for the first time -----
    if (m.type === 'welcome') {
      await this.save(m.phone, 'IDLE');
      return this.send(m.phone, msg.welcome(user.display_name));
    }

    // ----- a submitted WhatsApp form -----
    if (m.type === 'form') {
      const token = String(m.form?.flow_token ?? '');
      if (token.startsWith('o1.')) return; // "My orders" closed: everything it did was already sent in the chat
      if (token.startsWith('kyc')) return this.kycFormSubmitted(m, s, user);
      if (token.startsWith('amb') && this.amb) return this.amb.formSubmitted(m.phone, user, m.form ?? {});
      if (token.startsWith('a1.')) return; // Details closed: nothing to do
      // the market's forms
      if (token.startsWith('mkorder')) {
        const d = s.data as BuyDraft;
        if (!d.market?.length || !['BUY_ADDRESS', 'BUY_DATE'].includes(s.state)) return this.send(m.phone, msg.didntUnderstand());
        const f = readOrderForm(m.form ?? {});
        return this.continueBuying(m.phone, { ...d, ...(f.address ? { address: f.address.slice(0, 300), addressPin: null } : {}), arriveBy: f.arriveBy });
      }
      if (/^mk(list|edit)/.test(token) && this.mkt) return this.mkt.formSubmitted(m.phone, user, token, m.form ?? {}, s);
      // payout account, report a problem, my page, rating
      if (token.startsWith('pb1.')) return this.payoutFormSubmitted(m.phone, user, s, token, m.form ?? {});
      if (token.startsWith('problem:')) return this.problemFormSubmitted(m.phone, user, s, token.slice(8), m.form ?? {});
      if (token.startsWith('page:')) return this.pageFormSubmitted(m.phone, user, token, m.form ?? {});
      if (token.startsWith('rate:')) return this.rateFormSubmitted(m.phone, user, token.slice(5), m.form ?? {});
      const side: Side = token.startsWith('sell') ? 'sell' : 'buy';
      // an edited order keeps its photos unless new ones were added
      const kept = /^(buyedit|selledit)/.test(token) && Array.isArray(s.data.photos) ? s.data.photos : [];
      return this.buyFormSubmitted(m.phone, user, m.form ?? {}, kept, side);
    }

    // ----- voice notes: Phase 2 -----
    if (m.type === 'audio' && !['DISPUTE_DETAIL', 'HUMAN_MESSAGE', 'SHIP_PROOF'].includes(s.state)) return this.send(m.phone, msg.voiceSoon());

    // ----- test mode: pretend the buyer's transfer landed -----
    if (this.o.provider instanceof FakeProvider && this.o.testMode && ['paid', 'i paid', 'i have paid', 'done'].includes(lower)) {
      const ref = await this.o.deals.latestPendingPaymentFor(user.id);
      if (!ref) return this.send(m.phone, msg.testNothingToPay());
      this.o.provider.pay(ref);
      await this.o.deals.handleCollection(ref);
      return;
    }

    // ----- someone arriving from an ambassador's link: "Hi Hoolam, I want to buy safely. Tobi sent me (TOBI)" -----
    const sentMe = !m.buttonId ? text.match(SENT_ME_RE) : null;
    if (sentMe && this.amb) {
      await this.amb.arrived(user, sentMe[1]!);
      if (/\bsell/i.test(text)) return this.openMenuItem(m.phone, user, 'sell', true);
      if (/\bbuy/i.test(text)) return this.openMenuItem(m.phone, user, 'buy', true);
      await this.save(m.phone, 'IDLE');
      return this.send(m.phone, msg.welcome(user.display_name));
    }

    // ----- the very first message from someone new: tell the story once, unless they already know what they want -----
    const firstWords = clean(text);
    if (s.isNew && !m.buttonId && !text.match(CODE_RE) && !BUY_FROM_RE.test(text) && !BUY_THIS_RE.test(text) && !PHRASES[firstWords] && !firstWords.startsWith('/')) {
      await this.save(m.phone, 'IDLE');
      return this.send(m.phone, msg.welcome(user.display_name));
    }

    if (this.mkt && /^stop updates?$/.test(lower)) return this.mkt.setUpdates(m.phone, user, false);
    // ----- "I want to buy this: nike-air-x7k2" (from an item page or a shared item link; "ad ig-nov" = which ad) -----
    const buyThis = !m.buttonId ? text.match(BUY_THIS_RE) : null;
    if (buyThis && this.mkt && this.o.market?.on()) {
      if (modeOf(user) !== 'buyer') await this.o.deals.setMenuMode(user, 'buyer');
      return this.mkt.buyCode(m.phone, user, buyThis[1]!.toLowerCase(), buyThis[2]?.toLowerCase() ?? null);
    }

    // ----- "Buy from @bayo-shoes" (from a seller's public page) -----
    const buyFromMatch = text.match(BUY_FROM_RE);
    if (buyFromMatch && this.o.trust) {
      const sellerId = await this.o.trust.findSeller({ slug: buyFromMatch[1]! });
      if (sellerId) return this.buyFrom(m.phone, user, sellerId);
    }

    // ----- anywhere: a slash command, "menu"/"hi", or a deal code -----
    const words = clean(text);
    const slash = words.match(/^\/(\w+)/);
    if (slash) return this.openMenuItem(m.phone, user, SLASH[slash[1]!] ?? 'open');
    if (GREETINGS.includes(words)) return this.openMenuItem(m.phone, user, 'open');
    const codeMatch = text.match(CODE_RE);
    if (codeMatch && s.state !== 'CHECK_SELLER' && (['IDLE', 'BUY_CODE'].includes(s.state) || /^(pay|view)\b/i.test(text))) {
      await this.save(m.phone, 'IDLE');
      const code = 'HL-' + codeMatch[1]!.toUpperCase();
      const deal = await this.o.deals.findByCode(code);
      // A buyer's deal waiting for its seller: whoever opens it is shown it as the seller.
      if (deal?.status === 'AWAITING_SELLER' || (deal?.started_by === 'BUYER' && deal.buyer_id !== user.id)) return this.o.deals.showToSeller(code, user);
      if (deal && deal.seller_id !== user.id) await this.o.deals.setMenuMode(user, 'buyer');
      return this.viewAsBuyer(m.phone, user, code);
    }
    if (s.state === 'IDLE' && PHRASES[words]) return this.openMenuItem(m.phone, user, PHRASES[words]!);

    // ----- a shared location (📎 → Location): for an address question, or the rider's drop-off -----
    if (m.type === 'location' && m.location && this.mkt && ['MK_WHERE', 'MK_AREA', 'MK_BROWSE'].includes(s.state)) {
      return this.mkt.location(m.phone, user, m.location.latitude, m.location.longitude);
    }
    if (m.type === 'location' && m.location) {
      const pin = `${m.location.latitude.toFixed(6)},${m.location.longitude.toFixed(6)}`;
      const place = [m.location.name, m.location.address].filter(Boolean).join(', ') || null;
      if (s.state === 'BUY_ADDRESS' || s.state === 'BUYER_ADDRESS') {
        await this.save(m.phone, 'PIN_NOTE', { back: s.state, prev: s.data, pin, place });
        return this.send(m.phone, this.fix(m.phone, msg.askPinNote(place)));
      }
      if (s.state === 'DISPATCH' && s.data.method && s.data.method !== 'pickup' && s.data.phone && s.data.fee !== undefined && !s.data.location) {
        return this.dispatchStep(m.phone, user, { ...s.data, location: place ?? 'Shared location (see the map)', pin });
      }
      return this.send(m.phone, s.state === 'IDLE' ? await this.menuMsg(user, modeOf(user)) : msg.didntUnderstand());
    }

    // ----- typed answers, depending on what we asked -----
    if (s.state.startsWith('MK_')) {
      if (!this.mkt || !this.o.market?.on()) { await this.save(m.phone, 'IDLE'); return this.send(m.phone, await this.menuMsg(user, modeOf(user))); }
      if (s.state === 'MK_WHERE' || s.state === 'MK_AREA') return text ? this.mkt.typedArea(m.phone, user, text) : this.mkt.askWhere(m.phone);
      if (s.state === 'MK_BROWSE') return text ? this.mkt.typed(m.phone, user, text) : this.mkt.home(m.phone, user);
      if (s.state === 'MK_APPLY') return this.mkt.apply(m.phone, user, text.slice(0, 200) || null);
      return this.mkt.listingStep(m.phone, user, s.state, s.data, { type: m.type, text, mediaId: m.mediaId, buttonId: null });
    }
    switch (s.state) {
      case 'PIN_NOTE': return this.pinNote(m.phone, user, s, text);
      case 'AMB_NAME': case 'AMB_PHOTO': case 'AMB_ASK':
        if (!this.amb) { await this.save(m.phone, 'IDLE'); return this.send(m.phone, await this.menuMsg(user, modeOf(user))); }
        return this.amb.typed(m.phone, user, s.state, s.data, { type: m.type, text, mediaId: m.mediaId });
      case 'SELL_FORM': // (older sessions) typed instead of opening the form: carry on in the chat
      case 'SELL_ITEM': {
        if (text.length < 2) return this.send(m.phone, msg.askItem());
        return this.continueBuying(m.phone, { side: 'sell', item: text.slice(0, 200) });
      }
      case 'SELL_PRICE': case 'SELL_PHOTOS': case 'SELL_BUYER': case 'SELL_CONFIRM': // the old seller questions: start the new way
        return this.startSelling(m.phone);
      case 'BUYER_ADDRESS': {
        if (text.length < 5) return this.send(m.phone, msg.askBuyerAddress(s.data.code, null));
        await this.save(m.phone, 'IDLE');
        return this.acceptWithAddress(m.phone, user, s.data.code, text.slice(0, 300));
      }
      case 'KYC_METHOD': {
        const method: KycMethod | null = /\bbvn\b/i.test(text) ? 'BVN' : /\bv?nin\b/i.test(text) ? 'NIN' : null;
        if (/^\d[\d\s]{9,}$/.test(text)) await this.forgetMessage(m.id); // a number typed too early: never kept
        if (!method) return this.startKyc(m.phone, user, s.data.why ?? 'order', s.data.kycNext ?? { kind: 'none' });
        await this.save(m.phone, 'KYC_DOB', { ...s.data, method });
        return this.send(m.phone, msg.kycAskDob(method));
      }
      case 'KYC_DOB': {
        if (/^\d[\d\s]{9,}$/.test(text)) await this.forgetMessage(m.id);
        const dob = readDob(text);
        if (!dob) return this.send(m.phone, this.fix(m.phone, msg.kycBadDob()));
        await this.save(m.phone, 'KYC_NUMBER', { ...s.data, dob });
        return this.send(m.phone, msg.kycAskNumber(s.data.method ?? 'BVN'));
      }
      case 'KYC_NUMBER': {
        await this.forgetMessage(m.id); // we never keep the BVN or NIN, not even the message that carried it
        const digits = text.replace(/\D/g, '');
        const method: KycMethod = s.data.method === 'NIN' ? 'NIN' : 'BVN';
        if (digits.length !== 11) return this.send(m.phone, this.fix(m.phone, msg.kycBadNumber(method)));
        return this.runKyc(m.phone, user, method, digits, s.data.dob, s.data);
      }
      case 'SELLER_COUNTER_PRICE': {
        const major = parseAmount(text);
        if (!major) return this.send(m.phone, this.fix(m.phone, msg.badPrice()));
        const counterMinor = toMinor(major, this.o.currency);
        const lim = this.o.deals.limitFor(user, counterMinor);
        if (lim === 'too-big') return this.send(m.phone, this.fix(m.phone, msg.priceTooHigh({ minor: this.o.deals.reachFor(user), currency: this.o.currency })));
        if (lim === 'kyc') return this.startKyc(m.phone, user, 'accept', { kind: 'ask', state: 'SELLER_COUNTER_REASON', data: { code: s.data.code, counterMinor }, message: msg.askCounterReason({ minor: counterMinor, currency: this.o.currency }) });
        await this.save(m.phone, 'SELLER_COUNTER_REASON', { code: s.data.code, counterMinor });
        return this.send(m.phone, msg.askCounterReason({ minor: counterMinor, currency: this.o.currency }));
      }
      case 'SELLER_COUNTER_REASON': {
        const reason = text.replace(/\s+/g, ' ').trim();
        if (reason.length < 3 || reason.length > 150) return this.send(m.phone, this.fix(m.phone, msg.badCounterReason()));
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (acct) {
          await this.save(m.phone, 'IDLE');
          return this.o.deals.counterAsSeller(s.data.code, user, acct.id, s.data.counterMinor, reason);
        }
        const data = { code: s.data.code, counterMinor: s.data.counterMinor, counterReason: reason };
        if (this.sellerNeedsKyc(user)) return this.startKyc(m.phone, user, 'seller', { kind: 'ask', state: 'SELLER_BANK', data, message: msg.askSellerBank() });
        await this.save(m.phone, 'SELLER_BANK', data);
        return this.bankPrompt(m.phone, 'SELLER_BANK', msg.askSellerBank());
      }
      case 'SHIP_PROOF': {
        await this.save(m.phone, 'IDLE');
        const photo = m.type === 'image' && m.mediaId ? { mediaId: m.mediaId, mimeType: m.mimeType ?? null } : null;
        const note = m.type === 'text' ? text : m.type === 'image' ? text : '';
        if (!photo && !note) return this.send(m.phone, msg.dealStatusNow(s.data.code, 'SHIPPED'));
        return this.o.deals.addShippingProof(s.data.code, user, { photo, note });
      }
      case 'SELL_BANK':
      case 'REFUND_BANK':
      case 'ACCOUNT_BANK':
      case 'SELLER_BANK':
        return this.bankTyped(m.phone, s, text, undefined, user);
      case 'BUY_CODE':
        return this.send(m.phone, this.fix(m.phone, msg.badDealCode()));
      case 'BUY_FORM': // they typed instead of opening the form: that's fine, carry on in the chat
      case 'BUY_ITEM': {
        if (text.length < 2) return this.send(m.phone, s.data.side === 'sell' ? msg.askItem() : msg.askBuyItem());
        return this.continueBuying(m.phone, { ...s.data, item: text.slice(0, 200) });
      }
      case 'BUY_DESC': {
        if (text.length < 2) return this.send(m.phone, msg.askBuyDescription());
        return this.continueBuying(m.phone, { ...s.data, description: text.slice(0, 600) });
      }
      case 'BUY_CATEGORY': {
        const typed = CATEGORIES.find((c) => clean(c.title).startsWith(words) || c.id === words);
        return this.continueBuying(m.phone, typed ? { ...s.data, category: typed.id } : s.data);
      }
      case 'BUY_PRICE': {
        const major = parseAmount(text);
        if (!major && s.data.side === 'sell') return this.send(m.phone, msg.askPrice());
        if (!major) return this.send(m.phone, this.fix(m.phone, msg.badPrice()));
        const priceMinor = toMinor(major, this.o.currency);
        if (this.o.deals.limitFor(user, priceMinor) === 'too-big') return this.send(m.phone, this.fix(m.phone, msg.priceTooHigh({ minor: this.o.deals.reachFor(user), currency: this.o.currency })));
        const { kycPrice: _k, ...rest } = s.data;
        return this.continueBuying(m.phone, { ...rest, priceMinor }); // above the no-ID limit: the ID check comes next
      }
      case 'BUY_ADDRESS': {
        const sell = s.data.side === 'sell';
        if (sell && /^(skip|no|none|later|buyer)$/i.test(text)) return this.continueBuying(m.phone, { ...s.data, address: null, addressPin: null });
        if (text.length < 5) return this.send(m.phone, this.fix(m.phone, sell ? msg.askSellAddress() : msg.askDeliveryAddress()));
        return this.continueBuying(m.phone, { ...s.data, address: text.slice(0, 300), addressPin: null });
      }
      case 'BUY_DATE': {
        const day = parseDay(text);
        if (!day) return this.send(m.phone, this.fix(m.phone, s.data.side === 'sell' ? msg.badReadyBy() : msg.badArriveBy()));
        return this.continueBuying(m.phone, { ...s.data, arriveBy: day });
      }
      case 'BUY_PHOTOS': {
        if (m.type === 'image' && m.mediaId) {
          const photos = [...(s.data.photos ?? []), { mediaId: m.mediaId, mimeType: m.mimeType ?? null }].slice(0, MAX_PHOTOS);
          const side: Side = s.data.side === 'sell' ? 'sell' : 'buy';
          if (photos.length >= MAX_PHOTOS) {
            await this.send(m.phone, this.fix(m.phone, msg.photoAdded(photos.length, MAX_PHOTOS, side)));
            return this.continueBuying(m.phone, { ...s.data, photos, photosDone: true });
          }
          await this.save(m.phone, 'BUY_PHOTOS', { ...s.data, photos });
          return this.send(m.phone, this.fix(m.phone, msg.photoAdded(photos.length, MAX_PHOTOS, side)));
        }
        return this.continueBuying(m.phone, { ...s.data, photosDone: true }); // "no", "done", anything typed: move on
      }
      case 'BUY_SELLER': { // the other person's WhatsApp: the seller's (buyer's order) or the buyer's (seller's order)
        const sell = s.data.side === 'sell';
        const phone = normalizePhone(text);
        if (!phone) return this.send(m.phone, this.fix(m.phone, sell ? msg.badBuyerPhone() : msg.badSellerPhone()));
        const wrong = this.wrongNumber(phone, m.phone, sell ? 'buyer' : 'seller');
        if (wrong) return this.send(m.phone, this.fix(m.phone, wrong));
        return this.continueBuying(m.phone, { ...s.data, otherPhone: phone });
      }
      case 'CHECK_SELLER': return this.checkSeller(m.phone, user, text);
      case 'REVIEW_TEXT': {
        if (!text || /^(skip|no|cancel)$/i.test(text)) { await this.save(m.phone, 'IDLE'); return this.send(m.phone, msg.reviewSkipped()); }
        const problem = reviewProblem(text);
        if (problem) return this.send(m.phone, msg.reviewNotOk(problem as 'short' | 'long' | 'contact'));
        const words = text.trim().replace(/\s+/g, ' ');
        await this.save(m.phone, 'REVIEW_CONSENT', { ...s.data, text: words });
        const city = (await this.o.db.query('SELECT city FROM users WHERE id=$1', [user.id])).rows[0]?.city ?? null;
        return this.send(m.phone, msg.askReviewConsent(words, firstName(user.display_name) ?? 'A buyer', city, s.data.code));
      }
      case 'PROFILE_VIDEO': {
        if (m.type !== 'video' || !m.mediaId) {
          if (/^(cancel|stop|no)$/i.test(text)) { await this.save(m.phone, 'IDLE'); return this.showMyCard(m.phone, user); }
          return this.send(m.phone, this.fix(m.phone, msg.videoNeeded()));
        }
        try {
          const file = this.o.media ? await this.o.media.download(m.mediaId) : null;
          if (!file || !this.o.trust) return this.send(m.phone, msg.videoFailed());
          if (file.bytes.length > VIDEO_MAX_BYTES) return this.send(m.phone, msg.videoTooBig());
          await this.o.trust.setVideo(user.id, file.bytes, /^video\/(mp4|3gpp)$/.test(file.mimeType ?? '') ? file.mimeType! : 'video/mp4');
        } catch (e) {
          this.o.log?.(`seller video for ${m.phone}: ${(e as Error).message}`);
          return this.send(m.phone, /too big/.test((e as Error).message) ? msg.videoTooBig() : msg.videoFailed());
        }
        await this.save(m.phone, 'IDLE');
        return this.send(m.phone, msg.videoReceived());
      }
      case 'RATE_COMMENT': {
        await this.save(m.phone, 'IDLE');
        if (!text) return this.send(m.phone, msg.ratingCommentThanks());
        return this.o.deals.rateComment(s.data.code, user, text);
      }
      case 'DISPATCH': return this.dispatchTyped(m.phone, user, s, text);
      case 'HANDOVER_CODE': {
        const digits = text.replace(/\D/g, '');
        if (digits.length !== 4) return this.send(m.phone, this.fix(m.phone, msg.askHandoverCode(s.data.code)));
        const r = await this.o.deals.enterHandoverCode(s.data.code, user, digits);
        if (r !== 'wrong') await this.save(m.phone, 'IDLE');
        return;
      }
      case 'SETUP_NAME': {
        if (text.length < 2) return this.send(m.phone, msg.setupIntro(await this.shownName(user)));
        await this.o.trust?.setProfile(user.id, { businessName: text.slice(0, 60) });
        await this.save(m.phone, 'SETUP_CITY', s.data);
        return this.send(m.phone, msg.setupCity());
      }
      case 'SETUP_CITY': {
        if (/^(skip|no|none)$/i.test(text)) return this.finishSetup(m.phone, user, s.data.next);
        await this.o.trust?.setProfile(user.id, { city: text.slice(0, 60) });
        return this.finishSetup(m.phone, user, s.data.next);
      }
      case 'PROFILE_NAME': {
        if (text.length < 2) return this.send(m.phone, msg.askBusinessName(user.display_name ?? ''));
        await this.o.trust?.setProfile(user.id, { businessName: text });
        await this.save(m.phone, 'PROFILE_CITY');
        return this.send(m.phone, msg.askCity());
      }
      case 'PROFILE_PHOTO': {
        if (m.type !== 'image' || !m.mediaId) {
          if (/^(cancel|stop|no)$/i.test(text)) { await this.save(m.phone, 'IDLE'); return this.showMyCard(m.phone, user); }
          return this.send(m.phone, this.fix(m.phone, msg.photoNeeded()));
        }
        try {
          const file = this.o.media ? await this.o.media.download(m.mediaId) : null;
          if (!file || !this.o.trust) return this.send(m.phone, msg.photoFailed());
          await this.o.trust.setPhoto(user.id, file.bytes);
        } catch (e) {
          this.o.log?.(`profile photo for ${m.phone}: ${(e as Error).message}`);
          return this.send(m.phone, msg.photoFailed());
        }
        await this.save(m.phone, 'IDLE');
        return this.pageUpdated(m.phone, user, 'Photo saved. It\'s on your page now.');
      }
      case 'PROFILE_SOCIAL': {
        const kind = s.data.kind as SocialKind;
        if (!this.o.trust || !SOCIAL_NAMES[kind]) { await this.save(m.phone, 'IDLE'); return this.showMyCard(m.phone, user); }
        if (/^(cancel|stop)$/i.test(text)) { await this.save(m.phone, 'IDLE'); return this.showMyCard(m.phone, user); }
        const error = await this.o.trust.setSocial(user.id, kind, /^(remove|delete|none)$/i.test(text) ? null : text);
        if (error) return this.send(m.phone, msg.socialRefused(error, kind));
        await this.save(m.phone, 'IDLE');
        return this.pageUpdated(m.phone, user, /^(remove|delete|none)$/i.test(text) ? `${SOCIAL_NAMES[kind]} removed.` : `${SOCIAL_NAMES[kind]} added to your page.`);
      }
      case 'PROFILE_CITY': {
        await this.o.trust?.setProfile(user.id, { city: text });
        await this.save(m.phone, 'IDLE');
        return this.showMyCard(m.phone, user);
      }
      case 'HUMAN_MESSAGE': {
        const body = m.type === 'image' || m.type === 'audio' || m.type === 'video' ? `[${m.type} ${m.mediaId}] ${text}`.trim() : text;
        if (!body) return this.send(m.phone, msg.askHumanMessage());
        const about = s.data.code ? `[Order ${s.data.code}] ` : '';
        const r = await this.o.db.query(
          'INSERT INTO support_requests (user_id, phone, message, wa_message_id) VALUES ($1,$2,$3,$4) RETURNING id', [user.id, m.phone, (about + body).slice(0, 2000), m.id]);
        await this.save(m.phone, 'IDLE');
        this.o.log?.(`support request #${r.rows[0].id} from …${m.phone.slice(-4)}`);
        bus.support({ requestId: Number(r.rows[0].id), phone: m.phone, name: user.display_name ?? null, text: (about + body).slice(0, 200) });
        return this.send(m.phone, msg.humanLogged('S-' + r.rows[0].id, m.id));
      }
      case 'DISPUTE_DETAIL': {
        const detail = m.type === 'image' || m.type === 'audio' || m.type === 'video' ? `[${m.type} ${m.mediaId}] ${text}`.trim() : text;
        const ref = await this.o.deals.addDisputeDetail(s.data.code, user, detail);
        if (m.type === 'image' && m.mediaId) await this.o.deals.addProblemPhotos(s.data.code, user, [{ mediaId: m.mediaId, mimeType: m.mimeType ?? null }]).catch((e) => this.o.log?.(`problem photo: ${(e as Error).message}`));
        return this.afterProblem(m.phone, user, s.data.code, ref);
      }
      default:
        return this.send(m.phone, s.state === 'IDLE' ? await this.menuMsg(user, modeOf(user)) : msg.didntUnderstand());
    }
  }

  private maxDeal(user?: User): number { return user ? this.o.deals.capFor(user) : this.o.deals.maxDealMinor; }

  /** Everything the menus (and the slash commands) can do. */
  private async openMenuItem(phone: string, user: User, item: MenuItem, asked = false): Promise<unknown> {
    // before someone's very first order: "Did an ambassador send you?" (once)
    if (!asked && (item === 'buy' || item === 'sell') && this.amb && (await this.amb.maybeAsk(phone, user, item))) return;
    switch (item) {
      case 'sell':
        if (!user.seller_since) return this.startSetup(phone, user, 'sell');
        await this.o.deals.setMenuMode(user, 'seller');
        return this.startSelling(phone);
      case 'buy':
        await this.o.deals.setMenuMode(user, 'buyer');
        return this.startBuying(phone);
      case 'pay':
        await this.o.deals.setMenuMode(user, 'buyer');
        await this.save(phone, 'BUY_CODE');
        return this.send(phone, msg.askDealCode());
      case 'problem':
        await this.save(phone, 'IDLE');
        return modeOf(user) === 'seller' ? this.pickSellerProblem(phone, user) : this.pickProblemDeal(phone, user);
      case 'account': {
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          if (this.sellerNeedsKyc(user)) return this.startKyc(phone, user, 'seller', { kind: 'ask', state: 'ACCOUNT_BANK', data: {}, message: msg.askBank() });
          await this.save(phone, 'ACCOUNT_BANK');
          return this.bankPrompt(phone, 'ACCOUNT_BANK', msg.askBank());
        }
        await this.save(phone, 'IDLE');
        return this.send(phone, msg.accountInfo(acct.account_name, acct.bank_name, acct.account_number.slice(-4)));
      }
      case 'support':
        await this.save(phone, 'IDLE');
        return this.send(phone, msg.getHelp(modeOf(user)));
      case 'human':
        await this.save(phone, 'HUMAN_MESSAGE');
        return this.send(phone, msg.askHumanMessage());
      case 'check':
        await this.save(phone, 'CHECK_SELLER');
        return this.send(phone, msg.askCheckSeller());
      case 'card':
        if (!user.seller_since) return this.startSetup(phone, user, 'card');
        await this.save(phone, 'IDLE');
        return this.showMyCard(phone, user);
      case 'market':
        if (!this.mkt || !this.o.market?.on()) return this.openMenuItem(phone, user, 'open');
        if (modeOf(user) !== 'buyer') await this.o.deals.setMenuMode(user, 'buyer');
        return this.mkt.browse(phone, user);
      case 'items':
        if (!this.mkt || !this.o.market?.on()) return this.openMenuItem(phone, user, 'open');
        return this.mkt.myItems(phone, user);
      case 'me': {
        if (!user.seller_since) return this.startSetup(phone, user, 'card');
        await this.save(phone, 'IDLE');
        const t = this.o.trust ? await this.o.trust.seller(user.id) : null;
        const acct = await this.o.deals.defaultBankAccount(user.id);
        return this.send(phone, msg.myAccount({
          name: t?.name ?? user.display_name ?? 'You', verified: !!t?.verified, completed: t?.completed ?? 0,
          bank: acct ? `${acct.bank_name} ••••${String(acct.account_number).slice(-4)}` : null,
        }));
      }
      case 'switch':
        return this.openMenuItem(phone, user, modeOf(user) === 'seller' ? 'tobuy' : 'tosell');
      case 'tosell':
      case 'tobuy': {
        const to: MenuMode = item === 'tosell' ? 'seller' : 'buyer';
        if (to === 'seller' && !user.seller_since) return this.startSetup(phone, user, 'menu');
        const changed = modeOf(user) !== to;
        await this.o.deals.setMenuMode(user, to);
        await this.save(phone, 'IDLE');
        return this.send(phone, await this.menuMsg(user, to, changed ? msg.switchedTo(to) : undefined));
      }
    }
    await this.save(phone, 'IDLE');
    if (item === 'orders' || item === 'deals') {
      if (this.o.ordersForm && (await this.o.ordersForm.open(phone, user, { screen: 'orders' }))) return;
      return this.listOrders(phone, user);
    }
    if (item === 'how') return this.send(phone, msg.help());
    if (item === 'fees') return this.send(phone, this.feesMessage());
    return this.send(phone, await this.menuMsg(user, modeOf(user)));
  }

  // ===== ID CHECK (KYC): once per person =====
  /** A seller (or someone becoming one) who must check their ID before their payout account. */
  private sellerNeedsKyc(user: User): boolean { return this.o.deals.kycOn && !isVerified(user); }

  private async userByPhone(phone: string): Promise<User | null> {
    return (await this.o.db.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0] ?? null;
  }

  private limits() {
    const c = this.o.currency;
    return { noId: { minor: this.o.deals.maxDealMinor, currency: c }, verified: { minor: this.o.deals.maxDealVerifiedMinor, currency: c } };
  }

  /** The chat message that carried a BVN or NIN: blanked in the saved webhook, so the number isn't kept. */
  private async forgetMessage(id: string): Promise<void> {
    await this.o.db.query(
      `UPDATE webhook_events SET payload = payload || '{"text":"[ID number removed]","form":null}'::jsonb WHERE source='whatsapp' AND event_key=$1`, [id]).catch(() => {});
  }

  /** For the live orders form: start the ID check in the chat. */
  async startKycFor(user: User, why: KycWhy, next: KycNext): Promise<void> {
    await this.startKyc(user.phone, user, why, next);
  }

  /** Why we need it, then BVN or NIN (the form, or buttons in the chat). */
  private async startKyc(phone: string, user: User, why: KycWhy, next: KycNext): Promise<unknown> {
    const k = this.o.kyc;
    if (isVerified(user)) return this.afterKyc(phone, user, next);
    if (!k?.available) { await this.save(phone, 'IDLE'); return this.send(phone, msg.kycOff(this.limits().noId)); }
    // flagged and with the team (or declined): no more checks, BVN or NIN
    const blocked = await k.blocked(user.id);
    if (blocked) return this.kycBlocked(phone, blocked, false, why, next);
    await this.save(phone, 'KYC_METHOD', { kycNext: next, why });
    if ((await k.triesLeft(user.id)) <= 0) return this.send(phone, msg.kycFailed('NO_TRIES', 'BVN', 0));
    const form = this.o.kycForm?.() ?? null;
    if (form) {
      const status = await this.send(phone, msg.kycForm(form.flowId, form.mode, why, this.limits(), k.testMode));
      if (status !== 'FAILED') return;
      await this.o.onFormRefused?.('kyc', phone);
    }
    return this.send(phone, msg.kycIntro(why, this.limits(), k.testMode));
  }

  /** No more checks for them: the team has a flagged ID to look at, or declined it. A typed price comes back as before. */
  private async kycBlocked(phone: string, b: 'REVIEW' | 'DECLINED', fresh: boolean, why: KycWhy, next: KycNext): Promise<unknown> {
    const noId = this.limits().noId;
    const draft = next.kind === 'draft';
    if (draft) { const { priceMinor, ...d } = next.draft; await this.save(phone, 'BUY_PRICE', { ...d, kycPrice: priceMinor }); }
    else await this.save(phone, 'IDLE');
    return this.send(phone, b === 'DECLINED' ? msg.kycDeclined(why, noId, draft) : msg.kycInReview(fresh, why, noId, draft));
  }

  /** Use BVN / Use NIN / Not now / Try again / Talk to a rep / Check my ID (payout). */
  private async kycButton(phone: string, s: Session, user: User, what: string): Promise<unknown> {
    const inKyc = s.state.startsWith('KYC_');
    const next: KycNext = (inKyc && s.data.kycNext) || { kind: 'none' };
    const why: KycWhy = (inKyc && s.data.why) || 'order';
    if (what === 'payout') return this.startKyc(phone, user, 'payout', { kind: 'payout' });
    if (what === 'bvn' || what === 'nin') {
      if (isVerified(user)) return this.afterKyc(phone, user, next);
      const blocked = await this.o.kyc?.blocked(user.id);
      if (blocked) {
        // a price waiting after "Not now" stays waiting
        if (s.state === 'BUY_PRICE' && s.data.kycPrice) { const { kycPrice, ...d } = s.data; return this.kycBlocked(phone, blocked, false, 'order', { kind: 'draft', draft: { ...d, priceMinor: kycPrice } }); }
        return this.kycBlocked(phone, blocked, false, why, next);
      }
      await this.save(phone, 'KYC_DOB', { kycNext: next, why, method: what.toUpperCase() });
      return this.send(phone, msg.kycAskDob(what === 'bvn' ? 'BVN' : 'NIN'));
    }
    if (what === 'retry') {
      // "Check my ID" after "Not now" on a new order: the price they typed comes back
      if (s.state === 'BUY_PRICE' && s.data.kycPrice) { const { kycPrice, ...d } = s.data; return this.startKyc(phone, user, 'order', { kind: 'draft', draft: { ...d, priceMinor: kycPrice } }); }
      return this.startKyc(phone, user, why, next);
    }
    if (what === 'later') {
      if (inKyc && next.kind === 'draft') {
        const { priceMinor, ...d } = next.draft;
        await this.save(phone, 'BUY_PRICE', { ...d, kycPrice: priceMinor });
        return this.send(phone, msg.kycLater(this.limits().noId, true));
      }
      await this.save(phone, 'IDLE');
      return this.send(phone, msg.kycLater(this.limits().noId, false));
    }
    if (what === 'rep') {
      if (!isVerified(user)) await this.o.kyc?.markReview(user.id, 'Asked a rep for help with the ID check');
      return this.openMenuItem(phone, user, 'human');
    }
    return this.startKyc(phone, user, why, next);
  }

  /** The ID check form: BVN or NIN, the number and the date of birth. */
  private async kycFormSubmitted(m: Inbound, s: Session, user: User): Promise<unknown> {
    const f = m.form ?? {};
    await this.forgetMessage(m.id);
    const method: KycMethod = String(f.method ?? '').toUpperCase() === 'NIN' ? 'NIN' : 'BVN';
    const digits = String(f.number ?? '').replace(/\D/g, '');
    const rawDob = String(f.dob ?? '');
    const dob = /^\d{12,13}$/.test(rawDob) ? new Date(Number(rawDob)).toISOString().slice(0, 10) : readDob(rawDob);
    const data = s.state.startsWith('KYC_') ? s.data : { kycNext: { kind: 'none' }, why: 'order' };
    if (!dob) { await this.save(m.phone, 'KYC_DOB', { ...data, method }); return this.send(m.phone, this.fix(m.phone, msg.kycBadDob())); }
    if (digits.length !== 11) { await this.save(m.phone, 'KYC_NUMBER', { ...data, method, dob }); return this.send(m.phone, this.fix(m.phone, msg.kycBadNumber(method))); }
    return this.runKyc(m.phone, user, method, digits, dob, data);
  }

  private async runKyc(phone: string, user: User, method: KycMethod, number: string, dob: string, data: Record<string, any>): Promise<unknown> {
    if (!this.o.kyc) return this.send(phone, msg.kycOff(this.limits().noId));
    const r = await this.o.kyc.verify(user.id, method, number, dob);
    if (!r.ok) {
      // flagged just now (or earlier): the team decides
      if (r.reason === 'IN_REVIEW' || r.reason === 'DECLINED') {
        return this.kycBlocked(phone, r.reason === 'DECLINED' ? 'DECLINED' : 'REVIEW', !!r.fresh, data.why ?? 'order', data.kycNext ?? { kind: 'none' });
      }
      await this.save(phone, 'KYC_METHOD', { kycNext: data.kycNext ?? { kind: 'none' }, why: data.why ?? 'order' }); // "Try again" starts over
      return this.send(phone, msg.kycFailed(r.reason, method, r.triesLeft));
    }
    const fresh = (await this.userByPhone(phone)) ?? user;
    const acct = await this.o.deals.defaultBankAccount(fresh.id);
    const seller = !!fresh.seller_since && (!acct || this.o.deals.accountMatches(r.name, acct.account_name));
    await this.send(phone, msg.kycDone(r.name, this.limits().verified, seller));
    return this.afterKyc(phone, fresh, data.kycNext ?? { kind: 'none' });
  }

  /** Back to what they were doing. Payouts that were waiting for the check go out. */
  private async afterKyc(phone: string, user: User, next: KycNext): Promise<unknown> {
    if (next.kind === 'payout' || next.kind === 'none') {
      const r = await this.o.deals.releaseHeldPayouts(user.id);
      if (r === 'mismatch') return; // we've asked for an account in their own name
      if (r === 'released') { await this.save(phone, 'IDLE'); return; } // "You've been paid" follows
      await this.save(phone, 'IDLE');
      return this.send(phone, await this.menuMsg(user, modeOf(user)));
    }
    if (next.kind === 'draft') return this.continueBuying(phone, next.draft as BuyDraft);
    if (next.kind === 'ask') { await this.save(phone, next.state as State, next.data); return /_BANK$/.test(next.state) ? this.bankPrompt(phone, next.state as State, next.message) : this.send(phone, next.message); }
    await this.save(phone, 'IDLE');
    return this.handle({ id: `kyc-${Date.now()}`, phone, name: null, type: 'button', text: '', buttonId: next.id, mediaId: null });
  }

  /** An order step needed the ID check (above their limit): start it, and come back to the same step after. */
  private async kycFromError(m: Inbound, s: Session, user: User): Promise<unknown> {
    let next: KycNext = { kind: 'none' };
    if (m.buttonId?.startsWith('bank:') && s.data.code) next = { kind: 'button', id: `saccept:${s.data.code}` };
    else if (m.buttonId) next = { kind: 'button', id: m.buttonId };
    else if (s.state === 'BUYER_ADDRESS' && s.data.code) next = { kind: 'button', id: `baccept:${s.data.code}` };
    else if (s.state === 'SELLER_COUNTER_REASON' && s.data.code) next = { kind: 'button', id: `scounter:${s.data.code}` };
    const action = (next.kind === 'button' ? next.id : '').split(':')[0] ?? '';
    const why: KycWhy = ['saccept', 'scounter', 'bank'].includes(action) || s.state.startsWith('SELLER_') ? 'accept' : ['baccept', 'baddr', 'pay', 'cyes', 'bview'].includes(action) || s.state === 'BUYER_ADDRESS' ? 'pay' : 'order';
    return this.startKyc(m.phone, user, why, next);
  }

  // ===== A SHARED LOCATION =====
  /** After a pin: an optional landmark, then the address question carries on. `note` null = Skip. */
  private async pinNote(phone: string, user: User, s: Session, note: string | null): Promise<unknown> {
    if (s.state !== 'PIN_NOTE' || !s.data.pin) return this.send(phone, msg.didntUnderstand());
    const { back, prev, pin, place } = s.data as { back: State; prev: Record<string, any>; pin: string; place: string | null };
    const typed = (note ?? '').replace(/\s+/g, ' ').trim();
    const address = (typed.length >= 2 ? (place ? `${typed} · ${place}` : typed) : place ?? 'Shared location (see the map)').slice(0, 300);
    if (back === 'BUYER_ADDRESS') {
      await this.save(phone, 'IDLE');
      return this.acceptWithAddress(phone, user, prev.code, address, pin);
    }
    return this.continueBuying(phone, { ...(prev as BuyDraft), address, addressPin: pin });
  }

  // ===== BECOMING A SELLER (once) =====
  /** Two quick questions that create the trust card. `next`: where to go after. */
  private async startSetup(phone: string, user: User, next: 'sell' | 'card' | 'menu' | 'items') {
    await this.save(phone, 'SETUP_NAME', { next }); // typing the name still works
    if (await this.pageForm(phone, user, next)) return;
    return this.send(phone, msg.setupIntro(await this.shownName(user)));
  }

  /** My page in one form: the one-time setup (`setup` = what comes after), or editing. False when it can't be sent. */
  private async pageForm(phone: string, user: User, setup: 'sell' | 'card' | 'menu' | 'items' | null): Promise<boolean> {
    const form = this.o.extraForm?.('page') ?? null;
    if (!form) return false;
    const t = this.o.trust ? await this.o.trust.seller(user.id) : null;
    const link = (k: SocialKind) => t?.socials.find((x) => x.kind === k)?.url ?? '';
    const status = await this.send(phone, msg.pageForm(form.flowId, form.mode, setup ? `page:setup:${setup}` : 'page:edit', !!setup, {
      heading: setup ? 'Your trust card' : 'My page',
      intro: setup ? 'What buyers see before they pay you. It grows with every order you complete.' : 'Change what you need. Leave a link empty to remove it.',
      name: (setup ? await this.shownName(user) : t?.name) ?? '', city: t?.city ?? '',
      photo_note: t?.photoVersion ? 'You have a photo. Add a new one to replace it.' : 'Your face or your shop, in the middle. Pages with a photo get more trust.',
      instagram: link('instagram'), tiktok: link('tiktok'), facebook: link('facebook'), website: link('website'),
      button: setup ? 'Create my trust card' : 'Save my page',
    }, setup ? ART.picture('sample-trust') : undefined));
    if (status !== 'FAILED') return true;
    await this.o.onFormRefused?.('page', phone);
    return false;
  }

  private async pageFormSubmitted(phone: string, user: User, token: string, form: Record<string, unknown>) {
    if (!this.o.trust) return;
    const f = readPageForm(form);
    const setup = token.startsWith('page:setup:') ? token.slice(11) as 'sell' | 'card' | 'menu' | 'items' : null;
    const problems: string[] = [];
    if (f.name.length >= 2) await this.o.trust.setProfile(user.id, { businessName: f.name.slice(0, 60) });
    else if (setup) await this.o.trust.setProfile(user.id, { businessName: (await this.shownName(user)) ?? 'Seller' });
    await this.o.trust.setProfile(user.id, { city: f.city.slice(0, 60) || null } as never);
    if (f.photo) {
      try {
        const file = this.o.media ? await this.o.media.download(f.photo.mediaId) : null;
        if (file) await this.o.trust.setPhoto(user.id, file.bytes); else problems.push('We couldn\'t get your photo. Send it here instead.');
      } catch (e) { this.o.log?.(`page photo for ${phone}: ${(e as Error).message}`); problems.push('We couldn\'t use that photo. Try another one.'); }
    }
    const now = await this.o.trust.seller(user.id);
    for (const k of ['instagram', 'tiktok', 'facebook', 'website'] as SocialKind[]) {
      const typed = f.socials[k];
      const had = now?.socials.find((x) => x.kind === k)?.url ?? '';
      if (typed === had) continue;
      const error = await this.o.trust.setSocial(user.id, k, typed || null);
      if (error) problems.push(`${SOCIAL_NAMES[k]}: ${error}`);
    }
    if (setup) {
      if (problems.length) await this.send(phone, msg.pageSaved(problems));
      return this.finishSetup(phone, user, setup);
    }
    await this.save(phone, 'IDLE');
    if (problems.length) return this.send(phone, msg.pageSaved(problems));
    return this.pageUpdated(phone, user, 'Saved. Your page is up to date.');
  }

  // ----- rating: a few words (👍) or what went wrong (👎) -----
  private async rateForm(phone: string, user: User, code: string, happy: boolean, form: { flowId: string; mode: 'draft' | 'published' }): Promise<boolean> {
    const seller = (await this.sellerNameFor(code)) ?? 'the seller';
    const deal = await this.o.deals.findByCode(code);
    const item = (deal?.item ?? 'order').slice(0, 50);
    const status = await this.send(phone, msg.rateForm(form.flowId, form.mode, code, happy, seller, happy
      ? { heading: `How's your ${item}?`, label: 'Your thoughts (optional)', hint: 'What you liked about it', note: `Shows on ${seller}'s page with your first name.` }
      : { heading: 'What went wrong?', label: 'Tell us (optional)', hint: 'What could have been better', note: 'Only the Hoolam team sees this.' }));
    if (status !== 'FAILED') return true;
    await this.o.onFormRefused?.('rate', phone);
    return false;
  }

  private async rateFormSubmitted(phone: string, user: User, code: string, form: Record<string, unknown>) {
    const f = readRateForm(form);
    await this.save(phone, 'IDLE');
    const r = await this.o.db.query('SELECT r.happy FROM deal_ratings r JOIN deals d ON d.id=r.deal_id WHERE d.code=$1 AND r.buyer_id=$2', [code, user.id]);
    const happy = r.rows[0]?.happy !== false;
    if (!f.words) return this.send(phone, happy ? msg.reviewSkipped() : msg.ratingCommentThanks());
    if (!happy) return this.o.deals.rateComment(code, user, f.words);
    const problem = reviewProblem(f.words);
    if (problem) {
      await this.save(phone, 'REVIEW_TEXT', { code, seller: (await this.sellerNameFor(code)) ?? 'the seller' });
      return this.send(phone, msg.reviewNotOk(problem as 'short' | 'long' | 'contact'));
    }
    await this.o.deals.saveReview(code, user, f.words.replace(/\s+/g, ' '), true);
    return this.send(phone, msg.reviewShown((await this.sellerNameFor(code)) ?? 'the seller'));
  }

  // ----- payout account (live form; the chat steps are the backup) -----
  /** Asks for a bank account: the payout form when it can be sent (and no ID check comes first), else the chat question. The state is already saved. */
  private async bankPrompt(phone: string, state: State, chatMsg: Outbound): Promise<unknown> {
    const form = this.o.extraForm?.('payout') ?? null;
    const user = await this.userByPhone(phone);
    const kycFirst = !!user && state !== 'REFUND_BANK' && this.sellerNeedsKyc(user);
    if (form && user && !kycFirst && this.o.formSecret) {
      const why = state === 'REFUND_BANK' ? 'refund' : state === 'ACCOUNT_BANK' ? 'change' : state === 'SELLER_BANK' ? 'accept' : 'sell';
      const status = await this.send(phone, msg.payoutForm(form.flowId, form.mode, payoutToken(this.o.formSecret, phone), why));
      if (status !== 'FAILED') return;
      await this.o.onFormRefused?.('payout', phone);
    }
    return this.send(phone, chatMsg);
  }

  /** Is this account allowed for this person? The name from the bank, or why not (plain words, for the form and the chat). */
  private async checkAccount(user: User, state: string, bank: Bank, number: string): Promise<{ ok: true; name: string } | { ok: false; why: string }> {
    const name = await this.o.provider.resolveAccount(bank.code, number);
    if (!name) return { ok: false, why: `We couldn't find ${number} at ${bank.name}. Check the number and the bank.` };
    if (state !== 'REFUND_BANK' && this.sellerNeedsKyc(user)) return { ok: false, why: 'Check your ID first: send "hi" in the chat to carry on.' };
    if (isVerified(user) && !this.o.deals.accountMatches(user.kyc_name, name)) {
      return { ok: false, why: `This account is in the name ${name}. ${state === 'REFUND_BANK' ? 'Refunds' : 'Payouts'} only go to an account in your own name (${user.kyc_name ?? 'the name on your ID'}).` };
    }
    return { ok: true, name };
  }

  /** The payout form talking to our endpoint: the number → the likely banks → the name on the account. */
  async payoutFormRequest(req: { action?: string; screen?: string; data?: Record<string, any>; flow_token?: string }): Promise<Record<string, unknown>> {
    const wrap = (screen: string, data: Record<string, unknown>) => ({ version: '3.0', screen, data });
    if (req.action === 'ping') return { data: { status: 'active' } };
    if (req.data?.error || req.data?.error_message) { this.o.log?.(`payout form: WhatsApp REJECTED our answer: ${JSON.stringify(req.data).slice(0, 300)}`); return { data: { acknowledged: true } }; }
    const phone = this.o.formSecret ? readPayoutToken(this.o.formSecret, req.flow_token ?? '') : null;
    const user = phone ? await this.userByPhone(phone) : null;
    const s = phone ? (await this.o.db.query('SELECT state FROM chat_sessions WHERE phone=$1', [phone])).rows[0] : null;
    const state = String(s?.state ?? '');
    const account = (error: string | null, number = '') => wrap('ACCOUNT', {
      heading: state === 'REFUND_BANK' ? 'Where should a refund go?' : state === 'ACCOUNT_BANK' ? 'Your new payout account' : 'Where should we pay you?',
      intro: user && isVerified(user) && user.kyc_name ? `It must be in your own name: ${user.kyc_name}.` : 'Use an account in your own name.',
      error: error ?? '', has_error: !!error, account_number: number,
    });
    if (!user || !/_BANK$/.test(state)) return account('⌛ This has expired. Go back to the chat and tap the last button again.');
    try {
      if (req.action === 'INIT') return account(null);
      const op = String(req.data?.op ?? '');
      const number = String(req.data?.account_number ?? '').replace(/\D/g, '');
      if (number.length !== 10) return account('⚠️ An account number has 10 digits.', number);
      const banks = await this.o.provider.listBanks();
      const options = (list: Bank[]) => [...list.map((b) => ({ id: b.code, title: b.name.slice(0, 30) })), { id: 'other', title: 'My bank isn\'t listed' }].slice(0, 200);
      const bankScreen = (error: string | null) => wrap('BANK', { account_number: number, banks: options(bankChoices(number, banks)), error: error ?? '', has_error: !!error });
      if (op === 'number') return bankScreen(null);
      const picked = req.data?.bank === 'other' ? matchBank(String(req.data?.bank_other ?? ''), banks) : banks.find((b) => b.code === req.data?.bank) ?? null;
      if (!picked) return bankScreen(req.data?.bank === 'other' ? '⚠️ We couldn\'t find that bank. Check the spelling, or pick it from the list.' : '⚠️ Pick your bank.');
      const r = await this.checkAccount(user, state, picked, number);
      if (!r.ok) return bankScreen(`⚠️ ${r.why}`);
      return wrap('CONFIRM', {
        account_number: number, bank: picked.code, confirm_text: `${r.name}\n${picked.name} · ${number}`,
        name_note: isVerified(user) ? '✓ Matches the name on your ID' : '', has_note: isVerified(user),
      });
    } catch (e) {
      this.o.log?.(`payout form error: ${(e as Error).stack ?? e}`);
      return account('😕 Something went wrong on our side. Please try again.');
    }
  }

  /** The payout form was saved: checked again here, then it carries on exactly like "Yes, that's my account" in the chat. */
  private async payoutFormSubmitted(phone: string, user: User, s: Session, token: string, form: Record<string, unknown>) {
    if (!this.o.formSecret || readPayoutToken(this.o.formSecret, token) !== phone || !/_BANK$/.test(s.state)) return this.send(phone, msg.didntUnderstand());
    const number = String(form.account_number ?? '').replace(/\D/g, '');
    const bank = (await this.o.provider.listBanks()).find((b) => b.code === String(form.bank ?? ''));
    const r = bank && number.length === 10 ? await this.checkAccount(user, s.state, bank, number) : { ok: false as const, why: 'That account didn\'t come through.' };
    if (!r.ok || !bank) return this.send(phone, { kind: 'text', text: `⚠️ ${r.ok ? 'That account didn\'t come through.' : r.why}\n\nSend the 10-digit account number here, or try the form again.` });
    const next = (s.state.replace(/_BANK$/, '_BANK_CONFIRM')) as State;
    const data = { ...s.data, pendingAccount: { bank_code: bank.code, bank_name: bank.name, account_number: number, account_name: r.name } };
    await this.save(phone, next, data);
    return this.bankAnswer(phone, { state: next, data, isNew: false }, user, true);
  }

  /** The name buyers would see if they don't type a shop name (from their WhatsApp profile). */
  private async shownName(user: User): Promise<string | null> {
    if (!user.display_name) return null;
    const t = this.o.trust ? await this.o.trust.seller(user.id) : null;
    return t?.name ?? user.display_name;
  }

  private async finishSetup(phone: string, user: User, next: 'sell' | 'card' | 'menu' | 'items' = 'menu') {
    await this.o.deals.setMenuMode(user, 'seller');
    await this.save(phone, 'IDLE');
    const t = this.o.trust ? await this.o.trust.seller(user.id) : null;
    const card = t ? msg.trustCardText(t) : '';
    const art = t ? ART.trust(t, user.id) : undefined;
    if (next === 'sell') {
      await this.send(phone, msg.setupDone(card, true, art));
      return this.startSelling(phone);
    }
    if (next === 'card') return this.showMyCard(phone, user);
    if (next === 'items' && this.mkt) { await this.send(phone, msg.setupDone(card, false, art)); return this.mkt.myItems(phone, (await this.userByPhone(phone)) ?? user); }
    return this.send(phone, msg.setupDone(card, false, art));
  }

  /** A seller's "Report a problem": pick an order, then tell a rep what's wrong. */
  private async pickSellerProblem(phone: string, user: User) {
    const r = await this.o.db.query(
      `SELECT code, item FROM deals WHERE seller_id=$1 AND status IN ('AWAITING_PAYMENT','FUNDED','SHIPPED','DISPUTED','PAYOUT_PENDING','RELEASING')
       ORDER BY created_at DESC LIMIT 10`, [user.id]);
    if (r.rows.length === 0) return this.send(phone, msg.noOrdersToReport());
    if (r.rows.length === 1) {
      await this.save(phone, 'HUMAN_MESSAGE', { code: r.rows[0].code });
      return this.send(phone, msg.askSellerProblem(r.rows[0].code, await this.buyerNameFor(r.rows[0].code)));
    }
    return this.send(phone, msg.pickOrderForSellerProblem(r.rows));
  }

  /** "2.5% (at least ₦300)": how the Hoolam fee is worked out, for before the price is final. */
  private feeRuleText(): string {
    const c = this.o.currency;
    const r = this.o.deals.pricingRules() ?? PRICING[c];
    const unit = c === 'NGN' ? 100 : 1;
    return `${r.ratePercent}% of the total (starting from ${formatMoney(r.min * unit, c)}${r.max ? `, at most ${formatMoney(r.max * unit, c)}` : ''})`;
  }

  private feesMessage(): Outbound {
    const c = this.o.currency;
    const r = this.o.deals.pricingRules() ?? PRICING[c];
    const unit = c === 'NGN' ? 100 : 1;
    const f = (major: number) => formatMoney(major * unit, c);
    const who = '🤝 *Whoever starts the order pays Hoolam\'s fee.* The other side pays a small flat *transaction fee*.\n' +
      '🛒 Buyer starts it → buyer pays Hoolam\'s fee, the seller\'s transaction fee comes out of their payout\n' +
      '🏷️ Seller starts it → seller pays Hoolam\'s fee, the buyer pays a transaction fee';
    const t = this.o.deals.txnFees();
    const bands = (b: FeeBand[]) => b.map((x, i) => x.upTo == null ? `${f(x.fee)} above ${f(b[i - 1]?.upTo ?? 0)}` : `${f(x.fee)} up to ${f(x.upTo)}`).join('\n');
    const same = JSON.stringify(t.seller) === JSON.stringify(t.buyer);
    const txn = same ? `*Transaction fee*\n${bands(t.seller)}` : `*Seller's transaction fee*\n${bands(t.seller)}\n\n*Buyer's transaction fee*\n${bands(t.buyer)}`;
    const rules = `*Hoolam's fee: ${r.ratePercent}%* of the price\nStarting from ${f(r.min)}, at most ${f(r.max)}\n\n${txn}\n\n${who}`;
    const examples = [5_000, 15_000, 50_000]
      .map((major) => major * unit)
      .filter((minor) => minor <= this.maxDeal())
      .map((minor) => {
        const q = quote(minor, c, r);
        return `${formatMoney(minor, c)} order → Hoolam's fee ${formatMoney(q.feeMinor, c)}`;
      });
    const txnAt = (minor: number) => { const major = minor / unit; return (t.seller.find((b) => b.upTo == null || major <= b.upTo) ?? t.seller[t.seller.length - 1]!).fee; };
    const rows = [5_000, 15_000, 50_000].map((major) => major * unit).filter((minor) => minor <= this.maxDeal())
      .map((minor) => ({ price: formatMoney(minor, c), hoolam: formatMoney(quote(minor, c, r).feeMinor, c), txn: f(txnAt(minor)) }));
    return msg.fees(rules, examples, { minor: this.maxDeal(), currency: c }, rows.length ? ART.fees(rows) : undefined);
  }

  /** Paid deals this person bought that can still be frozen. */
  private async pickProblemDeal(phone: string, user: User) {
    const r = await this.o.db.query(
      `SELECT code, item FROM deals WHERE buyer_id=$1 AND status IN ('FUNDED','SHIPPED') ORDER BY created_at DESC LIMIT 10`, [user.id]);
    if (r.rows.length === 0) return this.send(phone, msg.noDealsToReport());
    if (r.rows.length === 1) return this.startProblem(phone, user, r.rows[0].code);
    return this.send(phone, msg.pickDealForProblem(r.rows));
  }

  private async startProblem(phone: string, user: User, code: string) {
    // the money is frozen at once; then one form (what went wrong, details, photos), or the chat question
    const form = this.o.extraForm?.('problem') ?? null;
    const info = await this.o.deals.openDispute(code, user, !form);
    await this.save(phone, 'DISPUTE_DETAIL', { code });
    if (!form || !info) return;
    const amount = formatMoney(info.amountMinor, this.o.currency);
    const hours = this.o.problemHours?.() ?? 24;
    const status = await this.send(phone, msg.problemForm(form.flowId, form.mode, code, {
      heading: `${code} · ${info.item}${info.sellerName ? ` from ${info.sellerName}` : ''}`.slice(0, 80),
      frozen: `${amount} is frozen with Hoolam until this is sorted.`,
      reply: `A rep replies within ${hours} hour${hours === 1 ? '' : 's'}.`,
    }, ART.frozen('buyer', amount, code, hours)));
    if (status !== 'FAILED') return;
    await this.o.onFormRefused?.('problem', phone);
    return this.send(phone, msg.askProblem(code, info.sellerName, { minor: info.amountMinor, currency: this.o.currency }));
  }

  /** After the buyer told us what's wrong: the case is open; a refund account if we don't have one. */
  private async afterProblem(phone: string, user: User, code: string, ref: string) {
    if (await this.o.deals.defaultBankAccount(user.id)) {
      await this.save(phone, 'IDLE');
      return this.send(phone, msg.problemLogged(code, caseRef(ref), await this.sellerNameFor(code)));
    }
    await this.save(phone, 'REFUND_BANK', { code, caseId: ref });
    return this.bankPrompt(phone, 'REFUND_BANK', msg.askRefundBank());
  }

  private async problemFormSubmitted(phone: string, user: User, s: Session, code: string, form: Record<string, unknown>) {
    const deal = await this.o.deals.findByCode(code);
    if (!deal || deal.buyer_id !== user.id || deal.status !== 'DISPUTED') return this.send(phone, msg.dealStatusNow(code, deal?.status ?? 'CLOSED'));
    const f = readProblemForm(form);
    const ref = await this.o.deals.addDisputeDetail(code, user, `${problemReasonTitle(f.reason)}: ${f.details}`.slice(0, 2000));
    const n = await this.o.deals.addProblemPhotos(code, user, f.photos).catch((e) => { this.o.log?.(`problem photos: ${(e as Error).message}`); return 0; });
    if (n) await this.o.deals.addDisputeDetail(code, user, `[${n} photo${n === 1 ? '' : 's'} added as proof]`);
    if (s.state === 'DISPUTE_DETAIL' || s.state === 'IDLE') return this.afterProblem(phone, user, code, ref);
    return this.send(phone, msg.problemLogged(code, caseRef(ref), await this.sellerNameFor(code)));
  }

  /** Sell something: the seller's form (the mirror of the buyer's), or the same questions in the chat. */
  private async startSelling(phone: string) {
    const form = this.o.sellForm?.() ?? null;
    if (form) {
      await this.save(phone, 'BUY_FORM', { side: 'sell' });
      const status = await this.send(phone, msg.sellForm(form.flowId, form.mode, await this.neverOrdered(phone)));
      if (status !== 'FAILED') return;
      await this.o.onFormRefused?.('sell', phone);
    }
    await this.save(phone, 'BUY_ITEM', { side: 'sell' });
    return this.send(phone, msg.askItem());
  }

  /** Send / Edit / Start again and the skip buttons, for either side's new order. */
  private async draftButton(phone: string, s: Session, user: User, side: Side, code: string) {
    const d = s.data as BuyDraft;
    const same = (d.side ?? 'buy') === side;
    const start = () => (side === 'sell' ? this.startSelling(phone) : this.startBuying(phone));
    if (code === 'restart') return start();
    if (!same) return start(); // a button from an older message
    if (code === 'send' || code === 'confirm') return this.finishBuying(phone, s, user);
    if (code === 'edit') return this.editBuying(phone, s);
    if (code === 'nophotos' || code === 'photosdone') return this.continueBuying(phone, { ...d, photosDone: true });
    if (code === 'noaddress' && side === 'sell') return this.continueBuying(phone, { ...d, address: null });
    return this.continueBuying(phone, d);
  }

  /** The buyer's / seller's first name on an order (for "Ada · Order HL-X"). */
  private async buyerNameFor(code: string) { return this.o.deals.nameOf((await this.o.deals.findByCode(code))?.buyer_id); }
  private async sellerNameFor(code: string) { return this.o.deals.nameOf((await this.o.deals.findByCode(code))?.seller_id); }

  /** The other person's number can't be Hoolam's, or (outside test mode) their own. */
  private wrongNumber(other: string, mine: string, who: 'seller' | 'buyer'): Outbound | null {
    if (this.isHoolam(other)) return msg.hoolamNumberTyped(who);
    if (other === mine && !this.o.testMode) return msg.ownNumberTyped(who);
    return null;
  }

  // ===== THE BUYER'S SIDE OF A SELLER'S ORDER =====
  /** A seller's new order opens in the form for the buyer (photos, details, Accept / Decline); the chat is the fallback. */
  private async viewAsBuyer(phone: string, user: User, code: string) {
    await this.o.deals.markSeen(code, user);
    const d = await this.o.deals.findByCode(code);
    if (d?.status === 'AWAITING_BUYER' && !d.legacy_ship && d.seller_id !== user.id && this.o.ordersForm
      && (await this.o.ordersForm.open(phone, user, { screen: 'order', code: d.code, mode: 'buyer', fresh: true }))) return;
    return this.o.deals.joinAsBuyer(code, user);
  }

  /** Accept: confirm, change or add the delivery address, then the payment details. */
  private async buyerAccepts(phone: string, user: User, code: string) {
    const d = await this.o.deals.findByCode(code);
    if (!d) throw new DealError('NOT_FOUND');
    if (d.status !== 'AWAITING_BUYER' || d.legacy_ship) { await this.save(phone, 'IDLE'); return this.o.deals.joinAsBuyer(code, user); }
    if (d.seller_id === user.id && !this.o.testMode) throw new DealError('OWN_DEAL');
    this.o.deals.assertLimit(user, d.price_minor); // above their limit: the ID check first, then the address
    await this.save(phone, 'BUYER_ADDRESS', { code: d.code });
    return this.send(phone, msg.askBuyerAddress(d.code, d.delivery_address));
  }

  private async acceptWithAddress(phone: string, user: User, code: string, address: string | null, pin: string | null = null) {
    const r = await this.o.deals.acceptAsBuyer(code, user, address, pin);
    if (r === 'need-address') { await this.save(phone, 'BUYER_ADDRESS', { code }); return this.send(phone, msg.askBuyerAddress(code, null)); }
  }

  /** "Update price" on a buyer's deal. */
  private async startCounter(phone: string, user: User, code: string) {
    const deal = await this.o.deals.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    if (deal.status !== 'AWAITING_SELLER' || (deal.counter_seller_id && deal.counter_seller_id !== user.id)) {
      return this.o.deals.showToSeller(code, user); // explains why not
    }
    await this.save(phone, 'SELLER_COUNTER_PRICE', { code });
    return this.send(phone, msg.askCounterPrice({ minor: deal.price_minor, currency: deal.currency }));
  }

  /** "My orders": what they bought (buying menu) or sold (selling menu). */
  private async listOrders(phone: string, user: User) {
    const mode = modeOf(user);
    const orders = await this.o.deals.recentOrders(user.id, mode);
    const lines = orders.map((d) => {
      const amount = mode === 'seller' ? d.seller_gets_minor : d.buyer_pays_minor;
      const who = d.other_name ? `*${String(d.other_name).split(' ')[0]}* · ` : '';
      return `${who}*${d.code}* · ${d.item.slice(0, 28)}\n${formatMoney(amount, d.currency)} · ${STATUS_WORDS[d.status] ?? d.status}`;
    });
    return this.send(phone, msg.ordersList(lines, mode));
  }



  // ===== TRUST CARD =====
  /** "Check a seller": a phone number or a deal code → their card. */
  private async checkSeller(phone: string, user: User, text: string) {
    const code = text.match(CODE_RE);
    let sellerId: string | null = null;
    if (code) {
      const deal = await this.o.deals.findByCode('HL-' + code[1]!.toUpperCase());
      sellerId = deal?.seller_id ?? null;
    } else {
      const p = normalizePhone(text);
      if (!p) return this.send(phone, this.fix(phone, msg.badSellerPhone()));
      sellerId = (await this.o.trust?.findSeller({ phone: p })) ?? null;
    }
    await this.save(phone, 'IDLE');
    const t = sellerId && this.o.trust ? await this.o.trust.seller(sellerId) : null;
    if (!t || !sellerId) return this.send(phone, msg.noSellerRecord());
    return this.send(phone, msg.sellerRecord(msg.trustCardText(t), null, sellerId === user.id ? null : sellerId, null, ART.trust(t, sellerId)));
  }

  /** Start a buyer's deal already pointed at a seller (from their page, or "Buy from them"). */
  private async buyFrom(phone: string, user: User, sellerId: string) {
    const t = this.o.trust ? await this.o.trust.seller(sellerId) : null;
    const seller = await this.o.db.query('SELECT phone FROM users WHERE id=$1', [sellerId]);
    if (!t || !seller.rows[0]) return this.startBuying(phone);
    if (sellerId === user.id && !this.o.testMode) return this.showMyCard(phone, user);
    await this.o.deals.setMenuMode(user, 'buyer');
    await this.save(phone, 'BUY_ITEM', { side: 'buy', otherPhone: seller.rows[0].phone });
    return this.send(phone, msg.buyingFrom(t.name, msg.trustLine(t)));
  }

  private pageUrl(slug: string): string {
    return `${(this.o.publicBaseUrl ?? '').replace(/\/$/, '')}/s/${slug}`;
  }

  private async pageUpdated(phone: string, user: User, what: string) {
    const t = this.o.trust ? await this.o.trust.seller(user.id) : null;
    return this.send(phone, msg.pageUpdated(what, t?.isPublic && t.slug ? this.pageUrl(t.slug) : null));
  }

  private async showMyCard(phone: string, user: User) {
    const t = this.o.trust ? await this.o.trust.seller(user.id) : null;
    if (!t) return this.send(phone, msg.didntUnderstand());
    return this.send(phone, msg.myTrustCard(msg.trustCardText(t), t.isPublic && t.slug ? this.pageUrl(t.slug) : null, t.ownStats ?? null, ART.trust(t, user.id)));
  }

  private async cardAction(phone: string, user: User, action: string): Promise<unknown> {
    if (!this.o.trust) return;
    switch (action) {
      case 'share': {
        const slug = await this.o.trust.setPublic(user.id, true);
        const t = await this.o.trust.seller(user.id);
        if (!slug || !t) return;
        const url = this.pageUrl(slug);
        await this.send(phone, msg.cardShared(url, ART.trustStatus(t, url.replace(/^https?:\/\//, ''), user.id)));
        return this.send(phone, msg.cardForwardText(t.name, url));
      }
      case 'hide':
        await this.o.trust.setPublic(user.id, false);
        return this.send(phone, msg.cardHidden());
      case 'edit': {
        const t = await this.o.trust.seller(user.id);
        if (!t) return;
        await this.save(phone, 'IDLE');
        return this.send(phone, msg.editMyPage(t, !!t.photoVersion, { video: this.o.trust.videoOn() ? await this.o.trust.videoState(user.id) : null }, !!this.o.extraForm?.('page')));
      }
      case 'form':
        await this.save(phone, 'IDLE');
        if (await this.pageForm(phone, user, null)) return;
        return this.cardAction(phone, user, 'name');
      case 'name': {
        const t = await this.o.trust.seller(user.id);
        await this.save(phone, 'PROFILE_NAME');
        return this.send(phone, msg.askBusinessName(t?.name ?? user.display_name ?? ''));
      }
      case 'video': {
        if (!this.o.trust.videoOn()) return this.showMyCard(phone, user);
        await this.save(phone, 'PROFILE_VIDEO');
        return this.send(phone, msg.askSellerVideo(await this.o.trust.videoState(user.id)));
      }
      case 'rmvideo':
        await this.save(phone, 'IDLE');
        await this.o.trust.removeVideo(user.id);
        return this.pageUpdated(phone, user, 'Video removed.');
      case 'delivered': {
        const t = await this.o.trust.seller(user.id);
        await this.save(phone, 'IDLE');
        await this.o.trust.setShowDelivered(user.id, !t?.showDelivered);
        if (t?.showDelivered) return this.send(phone, msg.deliveredOff());
        const after = await this.o.trust.seller(user.id);
        return this.send(phone, msg.deliveredOn(after?.delivered?.length ?? 0));
      }
      case 'photo': {
        const t = await this.o.trust.seller(user.id);
        await this.save(phone, 'PROFILE_PHOTO');
        return this.send(phone, msg.askProfilePhoto(!!t?.photoVersion));
      }
      case 'rmphoto':
        await this.save(phone, 'IDLE');
        await this.o.trust.removePhoto(user.id);
        return this.pageUpdated(phone, user, 'Photo removed.');
      case 'cancel':
        await this.save(phone, 'IDLE');
        return this.showMyCard(phone, user);
      default: {
        const social = action.match(/^(s|rm)-(instagram|tiktok|facebook|website)$/);
        if (!social) return;
        const kind = social[2] as SocialKind;
        if (social[1] === 'rm') {
          await this.save(phone, 'IDLE');
          await this.o.trust.setSocial(user.id, kind, null);
          return this.pageUpdated(phone, user, `${SOCIAL_NAMES[kind]} removed.`);
        }
        const t = await this.o.trust.seller(user.id);
        await this.save(phone, 'PROFILE_SOCIAL', { kind });
        return this.send(phone, msg.askSocial(kind, t?.socials.find((x) => x.kind === kind)?.label ?? null));
      }
      case 'wname':
        await this.save(phone, 'PROFILE_CITY');
        return this.send(phone, msg.askCity());
      case 'nocity':
        await this.save(phone, 'IDLE');
        return this.showMyCard(phone, user);
    }
  }

  /** No order yet, on either side: the form opens with "Hoolam holds your money" in three steps. */
  private async neverOrdered(phone: string): Promise<boolean> {
    const r = await this.o.db.query(`SELECT 1 FROM deals d JOIN users u ON u.id IN (d.buyer_id, d.seller_id) WHERE u.phone=$1 LIMIT 1`, [phone]).catch(() => null);
    return !!r && !r.rowCount;
  }

  // ===== A NEW ORDER (Buy something, and its mirror Sell something) =====
  private async startBuying(phone: string) {
    const form = this.o.buyForm?.() ?? null;
    if (form) {
      await this.save(phone, 'BUY_FORM', { side: 'buy' });
      const status = await this.send(phone, msg.buyForm(form.flowId, form.mode, await this.neverOrdered(phone)));
      if (status !== 'FAILED') return;
      await this.o.onFormRefused?.('buy', phone);
    }
    await this.save(phone, 'BUY_ITEM', { side: 'buy' });
    return this.send(phone, msg.askBuyItem());
  }

  /** The answers from either side's WhatsApp form. Anything missing or wrong is asked again in the chat. */
  private async buyFormSubmitted(phone: string, user: User, form: Record<string, unknown>, keptPhotos: BuyDraft['photos'] = [], side: Side = 'buy') {
    const f = readBuyForm(form);
    const photos = f.photos.length ? f.photos : keptPhotos ?? [];
    const d: BuyDraft = { side, photos, photosDone: photos.length > 0, arriveBy: f.arriveBy };
    if (f.item) d.item = f.item.slice(0, 200);
    d.description = f.description ? f.description.slice(0, 600) : null; // optional in the form
    if (isCategory(f.category)) d.category = f.category;
    const major = f.price ? parseAmount(f.price) : null;
    const priceMinor = major ? toMinor(major, this.o.currency) : 0;
    const tooBig = !!priceMinor && this.o.deals.limitFor(user, priceMinor) === 'too-big';
    if (priceMinor && !tooBig) d.priceMinor = priceMinor; // above the no-ID limit: the ID check comes after the form
    if (f.address) d.address = f.address.slice(0, 300);
    else if (side === 'sell') d.address = null; // left empty on purpose: the buyer adds it
    if (f.otherPhone) {
      const p = normalizePhone(f.otherPhone);
      const who = side === 'sell' ? 'buyer' : 'seller';
      const wrong = p ? this.wrongNumber(p, phone, who) : null;
      if (!p || wrong) { await this.save(phone, 'BUY_SELLER', d as Record<string, any>); return this.send(phone, this.fix(phone, wrong ?? (side === 'sell' ? msg.badBuyerPhone() : msg.badSellerPhone()))); }
      d.otherPhone = p;
    }
    if (tooBig) {
      await this.save(phone, 'BUY_PRICE', d as Record<string, any>);
      return this.send(phone, this.fix(phone, msg.priceTooHigh({ minor: this.o.deals.reachFor(user), currency: this.o.currency })));
    }
    return this.continueBuying(phone, d);
  }

  /** Asks for the first thing still missing, in order; when nothing is, shows the order to check. */
  private async continueBuying(phone: string, d: BuyDraft): Promise<unknown> {
    if ('kycPrice' in d) { const { kycPrice: _k, ...rest } = d as BuyDraft & { kycPrice?: number }; d = rest; }
    const ask = async (state: State, m: Outbound) => { await this.save(phone, state, d as Record<string, any>); return this.send(phone, m); };
    const sell = d.side === 'sell';
    if (!d.item) return ask('BUY_ITEM', sell ? msg.askItem() : msg.askBuyItem());
    if (d.description === undefined) return ask('BUY_DESC', msg.askBuyDescription()); // the form may leave it empty
    if (!d.category) return ask('BUY_CATEGORY', msg.askCategory());
    if (!d.priceMinor) return ask('BUY_PRICE', sell ? msg.askPrice() : msg.askBuyPrice());
    const me = await this.userByPhone(phone);
    if (me) {
      const lim = this.o.deals.limitFor(me, d.priceMinor);
      if (lim === 'kyc') return this.startKyc(phone, me, 'order', { kind: 'draft', draft: d as Record<string, any> });
      if (lim === 'too-big' && d.market?.length) { await this.save(phone, 'IDLE'); return this.send(phone, msg.priceTooHigh({ minor: this.o.deals.reachFor(me), currency: this.o.currency })); }
      if (lim === 'too-big') { const { priceMinor: _p, ...rest } = d; d = rest; return ask('BUY_PRICE', msg.priceTooHigh({ minor: this.o.deals.reachFor(me), currency: this.o.currency })); }
    }
    if (sell ? d.address === undefined : !d.address) return ask('BUY_ADDRESS', sell ? msg.askSellAddress() : msg.askDeliveryAddress());
    if (d.arriveBy === undefined) return ask('BUY_DATE', sell ? msg.askReadyBy() : msg.askArriveBy());
    if (!d.photosDone) return ask('BUY_PHOTOS', sell ? msg.askSellPhotos() : msg.askBuyPhotos());
    if (!d.otherPhone) return ask('BUY_SELLER', sell ? msg.askBuyerPhone() : msg.askSellerPhone());
    if (sell && !d.accountId) {
      // the seller's payout account: asked once, the first time
      const acct = me ? await this.o.deals.defaultBankAccount(me.id) : null;
      if (!acct) {
        // every seller checks their ID once, before their payout account (then the account must be in that name)
        if (me && this.sellerNeedsKyc(me)) return this.startKyc(phone, me, 'seller', { kind: 'ask', state: 'SELL_BANK', data: d as Record<string, any>, message: msg.askBank() });
        await this.save(phone, 'SELL_BANK', d as Record<string, any>);
        return this.bankPrompt(phone, 'SELL_BANK', msg.askBank());
      }
      d.accountId = acct.id;
    }
    return this.showBuySummary(phone, d);
  }

  private async showBuySummary(phone: string, d: BuyDraft) {
    const sell = d.side === 'sell';
    if (!d.item || !d.priceMinor) return sell ? this.startSelling(phone) : this.startBuying(phone);
    const user = (await this.o.db.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0] as User | undefined;
    const q = this.o.deals.previewDeal(d.priceMinor, sell ? 'seller' : 'buyer', user ? this.maxDeal(user) : undefined); // checks the limit
    await this.save(phone, 'BUY_CONFIRM', d as Record<string, any>);
    // the order to check opens in the form (photos, details, Send / Edit / Start again); the chat summary is the fallback
    if (user && this.o.ordersForm && (await this.o.ordersForm.open(phone, user, { screen: 'preview', item: d.item, totalMinor: d.priceMinor, mode: sell ? 'seller' : 'buyer' }))) return;
    if (sell) {
      const acct = d.accountId ? (await this.o.db.query('SELECT bank_name, account_number FROM bank_accounts WHERE id=$1', [d.accountId])).rows[0] : null;
      return this.send(phone, msg.sellSummary({
        item: d.item, description: d.description ?? null, category: categoryTitle(d.category), address: d.address ?? null,
        photos: d.photos?.length ?? 0, readyBy: d.arriveBy ? dayText(d.arriveBy) : null, buyerPhone: d.otherPhone ?? '',
        sum: this.o.deals.sellerSum({ price_minor: q.priceMinor, seller_gets_minor: q.sellerGetsMinor, fee_payer: 'SELLER' }),
        bank: acct ? `${acct.bank_name} ••••${String(acct.account_number).slice(-4)}` : null,
      }));
    }
    return this.send(phone, msg.buySummary({
      item: d.item, description: d.description ?? null, category: categoryTitle(d.category), address: d.address ?? null,
      photos: d.photos?.length ?? 0, arriveBy: d.arriveBy ? dayText(d.arriveBy) : null, sellerPhone: d.otherPhone ?? null,
      total: { minor: d.priceMinor, currency: this.o.currency }, feeRule: this.feeRuleText(),
    }));
  }

  /** "Edit order": the form filled in with their answers, or (no form) pick one thing to change in the chat. */
  private async editBuying(phone: string, s: Session) {
    const d = s.data as BuyDraft;
    const sell = d.side === 'sell';
    if (s.state !== 'BUY_CONFIRM' || !d.item || !d.priceMinor) return sell ? this.startSelling(phone) : this.startBuying(phone);
    const form = (sell ? this.o.sellEditForm?.() : this.o.buyEditForm?.()) ?? null;
    if (form) {
      const n = d.photos?.length ?? 0;
      const data = {
        item: d.item, description: d.description ?? '', category: d.category ?? '', price: String(d.priceMinor / 100),
        address: d.address ?? '', arrive_by: d.arriveBy ?? '', other_phone: d.otherPhone ? localPhone(d.otherPhone) : '',
        photo_note: n ? `You added ${n} photo${n === 1 ? '' : 's'}. They stay unless you add new ones here.` : 'Add 1 to 3 photos of the item.',
      };
      const status = await this.send(phone, sell ? msg.sellEditForm(form.flowId, form.mode, data) : msg.buyEditForm(form.flowId, form.mode, data));
      if (status !== 'FAILED') return;
      await this.o.onFormRefused?.(sell ? 'sellEdit' : 'buyEdit', phone);
    }
    return this.send(phone, msg.askWhatToChange(sell ? 'sell' : 'buy'));
  }

  /** Chat version of "Edit order": forget one answer and ask for it again, then show the order again. */
  private async fixBuying(phone: string, s: Session, what: string) {
    const d = { ...(s.data as BuyDraft) };
    if (s.state !== 'BUY_CONFIRM' || !d.item || !d.priceMinor) return d.side === 'sell' ? this.startSelling(phone) : this.startBuying(phone);
    if (what === 'item') delete d.item;
    else if (what === 'description') delete d.description;
    else if (what === 'category') delete d.category;
    else if (what === 'price') delete d.priceMinor;
    else if (what === 'address') delete d.address;
    else if (what === 'date') delete d.arriveBy;
    else if (what === 'photos') { d.photos = []; d.photosDone = false; }
    else if (what === 'seller') delete d.otherPhone;
    return this.continueBuying(phone, d);
  }

  /** The order someone is checking, for the review form. Null when there's nothing waiting to be sent. */
  async buyPreview(phone: string): Promise<{ side: Side; item: string; about: string; key: string; info: string; warn: string; photos: string[]; card: { lines: { icon: string; text: string }[]; big: { label: string; value: string }; note: string } } | null> {
    const r = await this.o.db.query('SELECT state, data FROM chat_sessions WHERE phone=$1', [phone]);
    const d = (r.rows[0]?.data ?? {}) as BuyDraft;
    if (r.rows[0]?.state !== 'BUY_CONFIRM' || !d.item || !d.priceMinor) return null;
    const c = this.o.currency;
    const about = [d.description ?? '', d.category ? `🏷️ ${categoryTitle(d.category)}` : ''].filter(Boolean).join('\n');
    const photos = (d.photos ?? []).map((p) => p.mediaId);
    if (d.side === 'sell') {
      const q = this.o.deals.previewDeal(d.priceMinor, 'seller', Number.MAX_SAFE_INTEGER);
      const acct = d.accountId ? (await this.o.db.query('SELECT bank_name, account_number FROM bank_accounts WHERE id=$1', [d.accountId])).rows[0] : null;
      return {
        side: 'sell', item: d.item, about, photos,
        key: [
          `💰 Total price ${formatMoney(q.priceMinor, c)}`,
          `🧾 Hoolam fee −${formatMoney(q.priceMinor - q.sellerGetsMinor, c)}`,
          `💸 You receive ${formatMoney(q.sellerGetsMinor, c)}`,
          d.address ? `📍 Deliver to: ${d.address}` : '📍 The buyer adds the delivery address',
          d.arriveBy ? `📅 Ready by ${dayText(d.arriveBy)}` : '',
          `📨 Buyer's WhatsApp: ${localPhone(d.otherPhone ?? '')}`,
        ].filter(Boolean).join('\n'),
        info: `Minus the rider's fee, if you send one.${acct ? `\n🏦 Paid into ${acct.bank_name} ••••${String(acct.account_number).slice(-4)}` : ''}\n🛡️ You started the order, so you pay Hoolam's fee. The buyer pays a small transaction fee.`,
        warn: 'Nothing is paid yet. The buyer accepts, then pays Hoolam.',
        card: {
          lines: [{ icon: 'user', text: `Buyer: ${localPhone(d.otherPhone ?? '')}` }, { icon: 'banknote', text: `Price ${formatMoney(q.priceMinor, c)} · fee ${formatMoney(q.priceMinor - q.sellerGetsMinor, c)}` }],
          big: { label: 'You receive', value: formatMoney(q.sellerGetsMinor, c) },
          note: 'The buyer pays Hoolam first. You\'re paid once they\'re happy.',
        },
      };
    }
    // what the buyer pays at today's price (the seller can still change the price when they accept)
    const qb = d.market?.length ? this.o.deals.buyerQuote(d.priceMinor, true) : this.o.deals.previewDeal(d.priceMinor, 'buyer', Number.MAX_SAFE_INTEGER);
    return {
      side: 'buy', item: d.item, about, photos,
      key: [
        `💰 Total price ${formatMoney(d.priceMinor, c)}`,
        `🧾 Hoolam fee ${formatMoney(qb.buyerPaysMinor - qb.priceMinor, c)}`,
        `💳 You pay ${formatMoney(qb.buyerPaysMinor, c)}, after the seller accepts`,
        d.address ? `📍 Deliver to: ${d.address}` : '',
        d.arriveBy ? `📅 Expected by ${dayText(d.arriveBy)}` : '',
        `📨 Seller's WhatsApp: ${localPhone(d.otherPhone ?? '')}`,
      ].filter(Boolean).join('\n'),
      info: 'Delivery is included in the total, if any. If the seller changes the price, you see the new total before you pay.',
      warn: 'Nothing is paid yet. You pay after the seller accepts.',
      card: {
        lines: [{ icon: 'store', text: `Seller: ${localPhone(d.otherPhone ?? '')}` }, ...(d.address ? [{ icon: 'mapPin', text: d.address }] : [])],
        big: { label: 'You pay, after they accept', value: formatMoney(qb.buyerPaysMinor, c) },
        note: `Price ${formatMoney(d.priceMinor, c)} + Hoolam fee ${formatMoney(qb.buyerPaysMinor - qb.priceMinor, c)}. Nothing is paid yet.`,
      },
    };
  }

  private async finishBuying(phone: string, s: Session, user: User) {
    const d = s.data as BuyDraft;
    const sell = d.side === 'sell';
    if (s.state !== 'BUY_CONFIRM' || !d.item || !d.priceMinor || !d.otherPhone) return sell ? this.startSelling(phone) : this.startBuying(phone);
    if (sell && !d.accountId) return this.continueBuying(phone, d);
    await this.save(phone, 'IDLE');
    const common = {
      item: d.item, priceMinor: d.priceMinor, photos: d.photos ?? [],
      description: d.description ?? null, category: d.category ?? null, address: d.address ?? null, addressPin: d.address ? d.addressPin ?? null : null,
    };
    if (sell) {
      await this.o.deals.setMenuMode(user, 'seller');
      await this.o.deals.createSellerDeal(user, { ...common, buyerPhone: d.otherPhone, readyBy: d.arriveBy ?? null, accountId: d.accountId! });
      return;
    }
    const input: BuyerDealInput = { ...common, sellerPhone: d.otherPhone, arriveBy: d.arriveBy ?? null, market: d.market ?? null };
    await this.o.deals.createBuyerDeal(user, input);
  }

  // ===== THE SELLER ACCEPTS A BUYER'S DEAL =====
  private async sellerAccepts(phone: string, user: User, code: string) {
    const deal = await this.o.deals.findByCode(code);
    if (!deal) throw new DealError('NOT_FOUND');
    const acct = await this.o.deals.defaultBankAccount(user.id);
    if (deal.status !== 'AWAITING_SELLER') return this.o.deals.acceptAsSeller(code, user, acct?.id ?? ''); // explains why not
    if (acct) {
      await this.save(phone, 'IDLE');
      return this.o.deals.acceptAsSeller(code, user, acct.id);
    }
    this.o.deals.assertLimit(user, deal.price_minor); // above their limit: the ID check first (the order waits)
    if (this.sellerNeedsKyc(user)) return this.startKyc(phone, user, 'seller', { kind: 'button', id: `saccept:${code}` });
    await this.save(phone, 'SELLER_BANK', { code });
    return this.bankPrompt(phone, 'SELLER_BANK', msg.askSellerBank());
  }

  // ----- bank accounts -----
  /**
   * Account number and bank, typed in the chat. Just the number? We list the banks it can belong to
   * (most likely first) and they tap one. Returns "number bank" when we have both, or null after asking.
   */
  private async withBank(phone: string, s: Session, state: State, text: string): Promise<string | null> {
    const digits = text.replace(/\D/g, '');
    const onlyNumber = /^\d{10}$/.test(digits) && !/[a-z]/i.test(text);
    if (onlyNumber) {
      const choices = bankChoices(digits, await this.o.provider.listBanks()).slice(0, 9);
      await this.save(phone, state, { ...s.data, bankNumber: digits });
      return this.send(phone, msg.pickBank(digits, choices)).then(() => null);
    }
    // a bank name after picking "Other": put the number back in front
    if (!/\d{10}/.test(text) && s.data.bankNumber) return `${s.data.bankNumber} ${text}`;
    return text;
  }

  /** A bank tapped from the list (or "Other"). */
  private async bankPicked(phone: string, user: User, s: Session, code: string) {
    if (!s.data.bankNumber) return this.send(phone, msg.didntUnderstand());
    if (code === 'other') return this.send(phone, msg.askBankName());
    const bank = (await this.o.provider.listBanks()).find((b) => b.code === code);
    if (!bank) return this.send(phone, msg.askBankName());
    const text = `${s.data.bankNumber} ${bank.name}`;
    return s.state === 'DISPATCH' ? this.dispatchTyped(phone, user, s, text, bank) : this.bankTyped(phone, s, text, bank, user);
  }

  private async bankTyped(phone: string, s: Session, typed: string, picked?: Bank, user?: User) {
    const text = picked ? typed : await this.withBank(phone, s, s.state as State, typed);
    if (text === null) return;
    const parsed = parseBankInput(text);
    if (!parsed) return this.send(phone, this.fix(phone, msg.badBank()));
    const bank = picked ?? matchBank(parsed.bankText, await this.o.provider.listBanks());
    if (!bank) return this.send(phone, this.fix(phone, msg.bankNotFound(parsed.bankText)));
    const name = await this.o.provider.resolveAccount(bank.code, parsed.accountNumber);
    if (!name) return this.send(phone, this.fix(phone, msg.accountNotFound()));
    // payouts (and a verified buyer's refunds) go only to an account in the name on their ID
    const refund = s.state === 'REFUND_BANK';
    if (user) {
      if (!refund && this.sellerNeedsKyc(user)) {
        const { bankNumber: _n, ...data } = s.data;
        return this.startKyc(phone, user, 'seller', { kind: 'ask', state: s.state, data, message: s.state === 'SELLER_BANK' ? msg.askSellerBank() : s.state === 'ACCOUNT_BANK' ? msg.askNewAccount() : msg.askBank() });
      }
      if (isVerified(user) && !this.o.deals.accountMatches(user.kyc_name, name)) {
        const { bankNumber: _n, ...data } = s.data;
        await this.save(phone, s.state as State, data);
        return this.send(phone, this.fix(phone, msg.accountNotTheirs(name, user.kyc_name ?? '', refund)));
      }
    }
    const next: State = s.state === 'SELL_BANK' ? 'SELL_BANK_CONFIRM' : s.state === 'ACCOUNT_BANK' ? 'ACCOUNT_BANK_CONFIRM'
      : s.state === 'SELLER_BANK' ? 'SELLER_BANK_CONFIRM' : 'REFUND_BANK_CONFIRM';
    await this.save(phone, next, { ...s.data, pendingAccount: { bank_code: bank.code, bank_name: bank.name, account_number: parsed.accountNumber, account_name: name } });
    return this.send(phone, msg.confirmBank(name, bank.name, parsed.accountNumber));
  }

  private async bankAnswer(phone: string, s: Session, user: User, yes: boolean) {
    if (!['SELL_BANK_CONFIRM', 'REFUND_BANK_CONFIRM', 'ACCOUNT_BANK_CONFIRM', 'SELLER_BANK_CONFIRM'].includes(s.state) || !s.data.pendingAccount) return this.send(phone, msg.didntUnderstand());
    const selling = s.state === 'SELL_BANK_CONFIRM';
    const changing = s.state === 'ACCOUNT_BANK_CONFIRM';
    const accepting = s.state === 'SELLER_BANK_CONFIRM';
    const { pendingAccount, ...rest } = s.data;
    if (!yes) {
      await this.save(phone, selling ? 'SELL_BANK' : changing ? 'ACCOUNT_BANK' : accepting ? 'SELLER_BANK' : 'REFUND_BANK', rest);
      return this.send(phone, selling ? msg.askBank() : changing ? msg.askNewAccount() : accepting ? msg.askSellerBank() : msg.askRefundBank());
    }
    const acct = await this.o.deals.saveBankAccount(user.id, pendingAccount);
    if (accepting) {
      await this.save(phone, 'IDLE');
      if (rest.counterMinor) return this.o.deals.counterAsSeller(rest.code, user, acct.id, rest.counterMinor, rest.counterReason ?? '');
      return this.o.deals.acceptAsSeller(rest.code, user, acct.id);
    }
    if (selling) { const { bankNumber: _n, ...draft } = rest; return this.continueBuying(phone, { ...(draft as BuyDraft), side: 'sell', accountId: acct.id }); }
    if (changing) {
      await this.save(phone, 'IDLE');
      await this.send(phone, msg.accountSaved(acct.bank_name, acct.account_number.slice(-4)));
      await this.o.deals.releaseHeldPayouts(user.id); // payouts waiting for an account in their own name go now
      // asked for it as a step of something else (an ambassador's setup): carry on there
      if (typeof rest.then === 'string' && /^amb:/.test(rest.then)) return this.handle({ id: `form-${Date.now()}`, phone, name: null, type: 'button', text: '', buttonId: rest.then, mediaId: null });
      return;
    }
    await this.save(phone, 'IDLE');
    if (rest.refundNow) { await this.o.deals.refundPaidOrder(rest.code, rest.refundNow, user, true); return; }
    return this.send(phone, msg.problemLogged(rest.code, caseRef(rest.caseId ?? ''), await this.sellerNameFor(rest.code)));
  }

  // ===== DISPATCH (chat version; the orders form does the same in one screen) =====
  private async startDispatch(phone: string, user: User, code: string): Promise<unknown> {
    const deal = await this.o.deals.findByCode(code);
    if (!deal || deal.seller_id !== user.id) throw new DealError('NOT_ALLOWED');
    if (deal.status !== 'FUNDED' || deal.dispatched_at) { await this.save(phone, 'IDLE'); return this.send(phone, msg.dealStatusNow(deal.code, deal.status)); }
    if (this.o.ordersForm) {
      const sent = await this.o.ordersForm.open(phone, user, { screen: 'dispatch', code: deal.code });
      if (sent) return;
    }
    const buyerName = await this.o.deals.nameOf(deal.buyer_id);
    await this.save(phone, 'DISPATCH', { code: deal.code, buyerAddress: deal.delivery_address, buyerPin: deal.delivery_pin ?? null, buyerName });
    return this.send(phone, msg.askDispatchMethod(deal.code, buyerName));
  }

  private async dispatchMethod(phone: string, user: User, s: Session, method: 'pickup' | 'rider' | 'waybill') {
    if (s.state !== 'DISPATCH' || !s.data.code) return this.send(phone, msg.didntUnderstand());
    return this.dispatchStep(phone, user, { code: s.data.code, buyerAddress: s.data.buyerAddress, buyerPin: s.data.buyerPin ?? null, buyerName: s.data.buyerName, method });
  }

  /** Asks for the next missing dispatch detail; when there's nothing left, dispatches. */
  private async dispatchStep(phone: string, user: User, d: Record<string, any>): Promise<unknown> {
    const role = d.method === 'waybill' ? 'driver' : 'rider';
    const ask = async (m: Outbound) => { await this.save(phone, 'DISPATCH', d); return this.send(phone, m); };
    if (!d.method) return ask(msg.askDispatchMethod(d.code, d.buyerName));
    if (d.method === 'pickup') {
      if (!d.pickupAddress) return ask(msg.askPickupAddress());
    } else {
      if (d.method === 'rider' && !d.name) return ask(msg.askRiderName());
      if (!d.phone) return ask(msg.askCourierPhone(role));
      if (d.fee === undefined) return ask(msg.askCourierFee(role));
      if (!d.location) return ask(msg.askCourierLocation(role, d.buyerAddress ?? null));
      if (d.fee > 0 && !d.account) return ask(msg.askCourierAccount(role));
    }
    await this.save(phone, 'IDLE');
    return this.o.deals.dispatch(d.code, user, {
      method: d.method === 'pickup' ? 'PICKUP' : d.method === 'rider' ? 'RIDER' : 'WAYBILL',
      pickupAddress: d.pickupAddress ?? null, courierName: d.name ?? null, courierPhone: d.phone ?? null,
      location: d.location ?? null, feeMinor: d.fee ?? 0, account: d.account ?? null, pin: d.pin ?? null,
    });
  }

  private async dispatchTyped(phone: string, user: User, s: Session, text: string, picked?: Bank): Promise<unknown> {
    const d = { ...s.data };
    const role = d.method === 'waybill' ? 'driver' : 'rider';
    if (!d.method) return this.send(phone, msg.askDispatchMethod(d.code, d.buyerName));
    if (d.method === 'pickup') return this.dispatchStep(phone, user, { ...d, pickupAddress: text.length >= 3 ? text.slice(0, 300) : undefined });
    if (d.method === 'rider' && !d.name) return this.dispatchStep(phone, user, { ...d, name: text.length >= 2 ? text.slice(0, 80) : undefined });
    if (!d.phone) {
      const p = normalizePhone(text);
      if (!p) return this.send(phone, msg.askCourierPhone(role));
      if (this.isHoolam(p)) return this.send(phone, this.fix(phone, msg.hoolamNumberTyped(role)));
      return this.dispatchStep(phone, user, { ...d, phone: p });
    }
    if (d.fee === undefined) {
      const major = /^(0|free|none|no)$/i.test(text) ? 0 : parseAmount(text);
      if (major === null || major === undefined) return this.send(phone, this.fix(phone, msg.badPrice()));
      const deal = await this.o.deals.findByCode(d.code);
      const fee = toMinor(major, this.o.currency);
      if (deal && fee >= deal.seller_gets_minor) return this.send(phone, this.fix(phone, msg.feeTooHigh({ minor: deal.seller_gets_minor, currency: this.o.currency })));
      return this.dispatchStep(phone, user, { ...d, fee });
    }
    if (!d.location) return this.dispatchStep(phone, user, { ...d, location: text.length >= 3 ? text.slice(0, 300) : undefined, pin: null });
    if (d.fee > 0 && !d.account) {
      const full = picked ? text : await this.withBank(phone, s, 'DISPATCH', text);
      if (full === null) return;
      const parsed = parseBankInput(full);
      if (!parsed) return this.send(phone, this.fix(phone, msg.badBank()));
      const bank = picked ?? matchBank(parsed.bankText, await this.o.provider.listBanks());
      if (!bank) return this.send(phone, this.fix(phone, msg.bankNotFound(parsed.bankText)));
      const name = await this.o.provider.resolveAccount(bank.code, parsed.accountNumber);
      if (!name) return this.send(phone, this.fix(phone, msg.accountNotFound()));
      const pendingAccount = { bank_code: bank.code, bank_name: bank.name, account_number: parsed.accountNumber, account_name: name };
      await this.save(phone, 'DISPATCH', { ...d, pendingAccount });
      return this.send(phone, msg.confirmCourierAccount(role, name, bank.name, parsed.accountNumber));
    }
    return this.dispatchStep(phone, user, d);
  }
}

/** The menu someone sees: selling only once they're a seller. */
export function modeOf(user: User): MenuMode {
  return user.seller_since && user.menu_mode === 'seller' ? 'seller' : 'buyer';
}

function caseRef(disputeId: string): string {
  return disputeId ? 'C-' + disputeId.replace(/-/g, '').slice(0, 6).toUpperCase() : 'C-NEW';
}

export { matchBank, parseBankInput } from './banks.js';
