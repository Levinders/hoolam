import type { Db } from '../db.js';
import { formatMoney, parseAmount, toMinor, type Currency } from '../money.js';
import { PRICING, quote } from '../pricing.js';
import { FakeProvider } from '../payments/fake.js';
import type { Bank, PaymentProvider } from '../payments/provider.js';
import { DealError, type BuyerDealInput, type DealService, type User } from '../deals/service.js';
import type { Messenger, Outbound } from './client.js';
import type { Inbound } from './inbound.js';
import { COMMANDS, ICE_BREAKER_STEPS, type MenuItem } from './automation.js';
import { msg, STATUS_WORDS } from './messages.js';
import { readBuyForm } from './buy-flow.js';
import { normalizePhone } from './inbound.js';
import { dayText } from '../deals/service.js';

/**
 * The WhatsApp conversation. Each person has a small state (what we're waiting for from them)
 * stored in chat_sessions. Buttons carry the deal code, so most taps need no state at all.
 */

type State =
  | 'IDLE' | 'SELL_ITEM' | 'SELL_PRICE' | 'SELL_BANK' | 'SELL_BANK_CONFIRM' | 'SELL_CONFIRM'
  | 'DISPUTE_DETAIL' | 'REFUND_BANK' | 'REFUND_BANK_CONFIRM'
  | 'BUY_CODE' | 'ACCOUNT_BANK' | 'ACCOUNT_BANK_CONFIRM' | 'HUMAN_MESSAGE'
  | 'BUY_FORM' | 'BUY_ITEM' | 'BUY_PRICE' | 'BUY_PHOTOS' | 'BUY_SELLER' | 'BUY_CONFIRM'
  | 'SELLER_BANK' | 'SELLER_BANK_CONFIRM';
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
  /** Called when WhatsApp refuses to send the form, so we stop trying until the next restart. */
  onFormRefused?: () => void;
  log?: (line: string) => void;
}

/** What a buyer has told us so far, kept in the chat session until they tap "Send to seller". */
interface BuyDraft { item?: string; priceMinor?: number; sellerPhone?: string | null; arriveBy?: string | null; photos?: { mediaId: string; mimeType?: string | null }[] }
const MAX_PHOTOS = 3;

const CODE_RE = /\bHL-?([A-Z2-9]{5})\b/i;


const clean = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s/-]/gu, '').replace(/\s+/g, ' ').trim();

/** "/sell" etc. Built from COMMANDS in automation.ts, so the two never drift apart. Works at any point. */
const SLASH: Record<string, MenuItem> = { start: 'open', ...Object.fromEntries(COMMANDS.map((c) => [c.name, c.goTo])) };
/** Words that always bring the menu back, whatever we were waiting for. */
const GREETINGS = ['menu', 'hi', 'hello', 'start', 'help', 'hey', 'main menu', 'good morning', 'good afternoon', 'good evening'];
/** Typed phrases (the ice breakers first) understood when nothing else is in progress. */
const PHRASES: Record<string, MenuItem> = {
  ...Object.fromEntries(ICE_BREAKER_STEPS.map((i) => [clean(i.text), i.goTo])),
  'i want to sell something': 'sell', 'sell': 'sell', 'sell something': 'sell',
  'i have a deal code to pay': 'pay', 'pay': 'pay', 'pay for a deal': 'pay', 'i have a deal code': 'pay', 'code': 'pay',
  'buy': 'buy', 'buy something': 'buy', 'i want to buy something': 'buy', 'buy safely': 'buy',
  'how does hoolam work': 'how', 'how it works': 'how', 'how hoolam works': 'how',
  'i need to talk to a person': 'human', 'i want to talk to a person': 'human', 'talk to a person': 'human', 'agent': 'human', 'support': 'human',
  'my deals': 'deals', 'deals': 'deals', 'fees': 'fees', 'fee': 'fees', 'price': 'fees',
  'report a problem': 'problem', 'problem': 'problem', 'my payout account': 'account', 'account': 'account',
};

export class Conversation {
  constructor(private readonly o: FlowOptions) {}

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

  async handle(m: Inbound): Promise<void> {
    const s = await this.session(m.phone);
    const user = await this.o.deals.upsertUser(m.phone, m.name);
    try {
      await this.route(m, s, user);
    } catch (e) {
      if (e instanceof DealError) {
        const map: Record<DealError['reason'], Outbound> = {
          NOT_FOUND: msg.dealNotFound(), NOT_ALLOWED: msg.notAllowed(), OWN_DEAL: msg.ownDeal(),
          TAKEN: msg.dealTaken(), CLOSED: msg.notAllowed(), TOO_BIG: msg.priceTooHigh({ minor: this.maxDeal(), currency: this.o.currency }),
        };
        await this.send(m.phone, map[e.reason]);
        return;
      }
      this.o.log?.(`flow error for ${m.phone}: ${(e as Error).stack ?? e}`);
      await this.send(m.phone, msg.somethingWrong());
    }
  }

  private async route(m: Inbound, s: Session, user: User): Promise<unknown> {
    const text = m.text.trim();
    const lower = text.toLowerCase();

    // ----- buttons that carry a deal code -----
    if (m.buttonId) {
      const [action, code] = m.buttonId.split(':');
      switch (action) {
        case 'menu':
          return this.openMenuItem(m.phone, user, (code === 'help' ? 'how' : code) as MenuItem);
        case 'account':
          await this.save(m.phone, 'ACCOUNT_BANK');
          return this.send(m.phone, msg.askNewAccount());
        case 'pay': return this.o.deals.requestPayment(code!, user);
        case 'newacct': return this.o.deals.requestPayment(code!, user, true);
        case 'cancel': return this.o.deals.cancelByBuyer(code!, user);
        case 'shipped': return this.o.deals.markShipped(code!, user);
        case 'happy': return this.o.deals.confirmHappy(code!, user);
        case 'problem':
          return this.startProblem(m.phone, user, code!);
        case 'bank': return this.bankAnswer(m.phone, s, user, code === 'yes');
        // ----- buyer's deal -----
        case 'buy':
          if (code === 'send') return this.finishBuying(m.phone, s, user);
          if (code === 'restart') return this.startBuying(m.phone);
          if (code === 'nophotos' || code === 'photosdone') return this.askForSeller(m.phone, s.data);
          if (code === 'nophone') return this.showBuySummary(m.phone, { ...s.data, sellerPhone: null });
          return;
        // ----- the seller's side of a buyer's deal -----
        case 'sview': await this.save(m.phone, 'IDLE'); return this.o.deals.showToSeller(code!, user);
        case 'saccept': return this.sellerAccepts(m.phone, user, code!);
        case 'sdecline': await this.save(m.phone, 'IDLE'); return this.o.deals.declineAsSeller(code!, user);
        case 'snotme': await this.save(m.phone, 'IDLE'); return this.o.deals.declineAsSeller(code!, user, true);
        case 'sell':
          if (code === 'confirm') return this.finishSelling(m.phone, s, user);
          return this.startSelling(m.phone);
      }
    }

    // ----- they opened the chat for the first time -----
    if (m.type === 'welcome') {
      await this.save(m.phone, 'IDLE');
      return this.send(m.phone, msg.welcome(user.display_name));
    }

    // ----- a submitted WhatsApp form -----
    if (m.type === 'form') return this.buyFormSubmitted(m.phone, m.form ?? {});

    // ----- voice notes: Phase 2 -----
    if (m.type === 'audio' && !['DISPUTE_DETAIL', 'HUMAN_MESSAGE'].includes(s.state)) return this.send(m.phone, msg.voiceSoon());

    // ----- test mode: pretend the buyer's transfer landed -----
    if (this.o.provider instanceof FakeProvider && this.o.testMode && ['paid', 'i paid', 'i have paid', 'done'].includes(lower)) {
      const ref = await this.o.deals.latestPendingPaymentFor(user.id);
      if (!ref) return this.send(m.phone, msg.testNothingToPay());
      this.o.provider.pay(ref);
      await this.o.deals.handleCollection(ref);
      return;
    }

    // ----- the very first message from someone new: tell the story once, unless they already know what they want -----
    const firstWords = clean(text);
    if (s.isNew && !m.buttonId && !text.match(CODE_RE) && !PHRASES[firstWords] && !firstWords.startsWith('/')) {
      await this.save(m.phone, 'IDLE');
      return this.send(m.phone, msg.welcome(user.display_name));
    }

    // ----- anywhere: a slash command, "menu"/"hi", or a deal code -----
    const words = clean(text);
    const slash = words.match(/^\/(\w+)/);
    if (slash) return this.openMenuItem(m.phone, user, SLASH[slash[1]!] ?? 'open');
    if (GREETINGS.includes(words)) return this.openMenuItem(m.phone, user, 'open');
    const codeMatch = text.match(CODE_RE);
    if (codeMatch && (['IDLE', 'BUY_CODE'].includes(s.state) || /^(pay|view)\b/i.test(text))) {
      await this.save(m.phone, 'IDLE');
      const code = 'HL-' + codeMatch[1]!.toUpperCase();
      const deal = await this.o.deals.findByCode(code);
      // A buyer's deal waiting for its seller: whoever opens it is shown it as the seller.
      if (deal?.status === 'AWAITING_SELLER' || (deal?.started_by === 'BUYER' && deal.buyer_id !== user.id)) return this.o.deals.showToSeller(code, user);
      return this.o.deals.joinAsBuyer(code, user);
    }
    if (s.state === 'IDLE' && PHRASES[words]) return this.openMenuItem(m.phone, user, PHRASES[words]!);

    // ----- typed answers, depending on what we asked -----
    switch (s.state) {
      case 'SELL_ITEM': {
        if (text.length < 2) return this.send(m.phone, msg.askItem());
        await this.save(m.phone, 'SELL_PRICE', { item: text.slice(0, 200) });
        return this.send(m.phone, msg.askPrice());
      }
      case 'SELL_PRICE': {
        const major = parseAmount(text);
        if (!major) return this.send(m.phone, msg.badPrice());
        const priceMinor = toMinor(major, this.o.currency);
        try { this.o.deals.previewDeal(priceMinor); } catch {
          return this.send(m.phone, msg.priceTooHigh({ minor: this.maxDeal(), currency: this.o.currency }));
        }
        const data = { ...s.data, priceMinor };
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (acct) return this.showSellSummary(m.phone, { ...data, accountId: acct.id });
        await this.save(m.phone, 'SELL_BANK', data);
        return this.send(m.phone, msg.askBank());
      }
      case 'SELL_BANK':
      case 'REFUND_BANK':
      case 'ACCOUNT_BANK':
      case 'SELLER_BANK':
        return this.bankTyped(m.phone, s, text);
      case 'BUY_CODE':
        return this.send(m.phone, msg.badDealCode());
      case 'BUY_FORM': // they typed instead of opening the form: that's fine, carry on in the chat
      case 'BUY_ITEM': {
        if (text.length < 2) return this.send(m.phone, msg.askBuyItem());
        await this.save(m.phone, 'BUY_PRICE', { item: text.slice(0, 200) });
        return this.send(m.phone, msg.askBuyPrice());
      }
      case 'BUY_PRICE': {
        const major = parseAmount(text);
        if (!major) return this.send(m.phone, msg.badPrice());
        const priceMinor = toMinor(major, this.o.currency);
        if (priceMinor > this.maxDeal()) return this.send(m.phone, msg.priceTooHigh({ minor: this.maxDeal(), currency: this.o.currency }));
        await this.save(m.phone, 'BUY_PHOTOS', { ...s.data, priceMinor, photos: [] });
        return this.send(m.phone, msg.askBuyPhotos());
      }
      case 'BUY_PHOTOS': {
        if (m.type === 'image' && m.mediaId) {
          const photos = [...(s.data.photos ?? []), { mediaId: m.mediaId, mimeType: m.mimeType ?? null }].slice(0, MAX_PHOTOS);
          if (photos.length >= MAX_PHOTOS) {
            await this.send(m.phone, msg.photoAdded(photos.length, MAX_PHOTOS));
            return this.askForSeller(m.phone, { ...s.data, photos });
          }
          await this.save(m.phone, 'BUY_PHOTOS', { ...s.data, photos });
          return this.send(m.phone, msg.photoAdded(photos.length, MAX_PHOTOS));
        }
        return this.askForSeller(m.phone, s.data); // "no", "done", anything typed: move on
      }
      case 'BUY_SELLER': {
        if (/^(skip|no|none|later)$/i.test(text)) return this.showBuySummary(m.phone, { ...s.data, sellerPhone: null });
        const phone = normalizePhone(text);
        if (!phone) return this.send(m.phone, msg.badSellerPhone());
        return this.showBuySummary(m.phone, { ...s.data, sellerPhone: phone });
      }
      case 'HUMAN_MESSAGE': {
        const body = m.type === 'image' || m.type === 'audio' ? `[${m.type} ${m.mediaId}] ${text}`.trim() : text;
        if (!body) return this.send(m.phone, msg.askHumanMessage());
        const r = await this.o.db.query(
          'INSERT INTO support_requests (user_id, phone, message) VALUES ($1,$2,$3) RETURNING id', [user.id, m.phone, body.slice(0, 2000)]);
        await this.save(m.phone, 'IDLE');
        this.o.log?.(`support request #${r.rows[0].id} from …${m.phone.slice(-4)}`);
        return this.send(m.phone, msg.humanLogged('S-' + r.rows[0].id));
      }
      case 'DISPUTE_DETAIL': {
        const detail = m.type === 'image' || m.type === 'audio' ? `[${m.type} ${m.mediaId}] ${text}`.trim() : text;
        const ref = await this.o.deals.addDisputeDetail(s.data.code, user, detail);
        const hasAccount = await this.o.deals.defaultBankAccount(user.id);
        if (hasAccount) {
          await this.save(m.phone, 'IDLE');
          return this.send(m.phone, msg.problemLogged(s.data.code, caseRef(ref)));
        }
        await this.save(m.phone, 'REFUND_BANK', { code: s.data.code, caseId: ref });
        return this.send(m.phone, msg.askRefundBank());
      }
      default:
        return this.send(m.phone, s.state === 'IDLE' ? msg.menu(user.display_name) : msg.didntUnderstand());
    }
  }

  private maxDeal(): number { return this.o.deals.maxDealMinor; }

  /** Everything the main menu (and the slash commands) can do. */
  private async openMenuItem(phone: string, user: User, item: MenuItem) {
    switch (item) {
      case 'sell': return this.startSelling(phone);
      case 'buy': return this.startBuying(phone);
      case 'pay':
        await this.save(phone, 'BUY_CODE');
        return this.send(phone, msg.askDealCode());
      case 'problem':
        await this.save(phone, 'IDLE');
        return this.pickProblemDeal(phone, user);
      case 'account': {
        const acct = await this.o.deals.defaultBankAccount(user.id);
        if (!acct) {
          await this.save(phone, 'ACCOUNT_BANK');
          return this.send(phone, msg.askBank());
        }
        await this.save(phone, 'IDLE');
        return this.send(phone, msg.accountInfo(acct.account_name, acct.bank_name, acct.account_number.slice(-4)));
      }
      case 'human':
        await this.save(phone, 'HUMAN_MESSAGE');
        return this.send(phone, msg.askHumanMessage());
    }
    await this.save(phone, 'IDLE');
    if (item === 'deals') return this.listDeals(phone, user);
    if (item === 'how') return this.send(phone, msg.help());
    if (item === 'fees') return this.send(phone, this.feesMessage());
    return this.send(phone, msg.menu(user.display_name));
  }

  private feesMessage(): Outbound {
    const c = this.o.currency;
    const r = PRICING[c];
    const unit = c === 'NGN' ? 100 : 1;
    const f = (major: number) => formatMoney(major * unit, c);
    const who = r.buyerShare >= 1 ? '💳 Buyer pays the fee\n🏷️ Seller gets the full price'
      : r.buyerShare <= 0 ? '🏷️ Seller pays the fee\n💳 Buyer pays just the price'
      : '🤝 Buyer and seller share the fee';
    const rules = `*${r.ratePercent}%* of the price\nMin ${f(r.min)} · Max ${f(r.max)} · rounded to ${f(r.roundTo)}\n\n${who}`;
    const examples = [5_000, 15_000, 50_000]
      .map((major) => major * unit)
      .filter((minor) => minor <= this.maxDeal())
      .map((minor) => {
        const q = quote(minor, c);
        return `${formatMoney(minor, c)} item → fee ${formatMoney(q.feeMinor, c)}`;
      });
    return msg.fees(rules, examples, { minor: this.maxDeal(), currency: c });
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
    await this.o.deals.openDispute(code, user);
    return this.save(phone, 'DISPUTE_DETAIL', { code });
  }

  private async startSelling(phone: string) {
    await this.save(phone, 'SELL_ITEM');
    return this.send(phone, msg.askItem());
  }

  private async showSellSummary(phone: string, data: Record<string, any>) {
    const q = this.o.deals.previewDeal(data.priceMinor);
    await this.save(phone, 'SELL_CONFIRM', data);
    const c = this.o.currency;
    return this.send(phone, msg.confirmDeal(data.item, { minor: q.priceMinor, currency: c }, { minor: q.feeMinor, currency: c }, { minor: q.buyerPaysMinor, currency: c }, { minor: q.sellerGetsMinor, currency: c }));
  }

  private async finishSelling(phone: string, s: Session, user: User) {
    if (s.state !== 'SELL_CONFIRM' || !s.data.item || !s.data.priceMinor || !s.data.accountId) return this.startSelling(phone);
    const { deal, link } = await this.o.deals.createDeal({ sellerId: user.id, item: s.data.item, priceMinor: s.data.priceMinor, sellerAccountId: s.data.accountId });
    await this.save(phone, 'IDLE');
    return this.send(phone, msg.dealCreated(deal.code, link));
  }

  private async listDeals(phone: string, user: User) {
    const deals = await this.o.deals.recentDeals(user.id);
    const lines = deals.map((d) => `${d.code} · ${d.item.slice(0, 28)} · ${formatMoney(d.buyer_pays_minor, d.currency)} · ${STATUS_WORDS[d.status] ?? d.status}`);
    return this.send(phone, msg.dealsList(lines));
  }


  // ===== BUYER STARTS A DEAL =====
  private async startBuying(phone: string) {
    const form = this.o.buyForm?.() ?? null;
    if (form) {
      await this.save(phone, 'BUY_FORM');
      const status = await this.send(phone, msg.buyForm(form.flowId, form.mode));
      if (status !== 'FAILED') return;
      this.o.onFormRefused?.();
      this.o.log?.('buyer form could not be sent; asking in the chat instead (form switched off until the next restart)');
    }
    await this.save(phone, 'BUY_ITEM');
    return this.send(phone, msg.askBuyItem());
  }

  /** The answers from the WhatsApp form. Anything missing or wrong is asked again in the chat. */
  private async buyFormSubmitted(phone: string, form: Record<string, unknown>) {
    const f = readBuyForm(form);
    const draft: BuyDraft = { photos: f.photos, arriveBy: f.arriveBy };
    if (!f.item) { await this.save(phone, 'BUY_ITEM', draft); return this.send(phone, msg.askBuyItem()); }
    draft.item = f.item.slice(0, 200);
    const major = f.price ? parseAmount(f.price) : null;
    const priceMinor = major ? toMinor(major, this.o.currency) : 0;
    if (!priceMinor || priceMinor > this.maxDeal()) {
      await this.save(phone, 'BUY_PRICE', draft);
      return this.send(phone, priceMinor ? msg.priceTooHigh({ minor: this.maxDeal(), currency: this.o.currency }) : msg.askBuyPrice());
    }
    draft.priceMinor = priceMinor;
    if (f.sellerPhone) {
      const p = normalizePhone(f.sellerPhone);
      if (!p) { await this.save(phone, 'BUY_SELLER', draft); return this.send(phone, msg.badSellerPhone()); }
      draft.sellerPhone = p;
    }
    return this.showBuySummary(phone, draft);
  }

  private async askForSeller(phone: string, data: BuyDraft) {
    await this.save(phone, 'BUY_SELLER', data as Record<string, any>);
    return this.send(phone, msg.askSellerPhone());
  }

  private async showBuySummary(phone: string, d: BuyDraft) {
    if (!d.item || !d.priceMinor) return this.startBuying(phone);
    const q = this.o.deals.previewDeal(d.priceMinor);
    await this.save(phone, 'BUY_CONFIRM', d as Record<string, any>);
    const c = this.o.currency;
    return this.send(phone, msg.buySummary({
      item: d.item, photos: d.photos?.length ?? 0, arriveBy: d.arriveBy ? dayText(d.arriveBy) : null, sellerPhone: d.sellerPhone ?? null,
      price: { minor: q.priceMinor, currency: c }, fee: { minor: q.feeMinor, currency: c }, total: { minor: q.buyerPaysMinor, currency: c },
    }));
  }

  private async finishBuying(phone: string, s: Session, user: User) {
    const d = s.data as BuyDraft;
    if (s.state !== 'BUY_CONFIRM' || !d.item || !d.priceMinor) return this.startBuying(phone);
    await this.save(phone, 'IDLE');
    const input: BuyerDealInput = { item: d.item, priceMinor: d.priceMinor, sellerPhone: d.sellerPhone ?? null, arriveBy: d.arriveBy ?? null, photos: d.photos ?? [] };
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
    await this.save(phone, 'SELLER_BANK', { code });
    return this.send(phone, msg.askSellerBank());
  }

  // ----- bank accounts -----
  private async bankTyped(phone: string, s: Session, text: string) {
    const parsed = parseBankInput(text);
    if (!parsed) return this.send(phone, msg.badBank());
    const bank = matchBank(parsed.bankText, await this.o.provider.listBanks());
    if (!bank) return this.send(phone, msg.bankNotFound(parsed.bankText));
    const name = await this.o.provider.resolveAccount(bank.code, parsed.accountNumber);
    if (!name) return this.send(phone, msg.accountNotFound());
    const next: State = s.state === 'SELL_BANK' ? 'SELL_BANK_CONFIRM' : s.state === 'ACCOUNT_BANK' ? 'ACCOUNT_BANK_CONFIRM'
      : s.state === 'SELLER_BANK' ? 'SELLER_BANK_CONFIRM' : 'REFUND_BANK_CONFIRM';
    await this.save(phone, next, { ...s.data, pendingAccount: { bank_code: bank.code, bank_name: bank.name, account_number: parsed.accountNumber, account_name: name } });
    return this.send(phone, msg.confirmBank(name, bank.name, parsed.accountNumber.slice(-4)));
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
      return this.o.deals.acceptAsSeller(rest.code, user, acct.id);
    }
    if (selling) return this.showSellSummary(phone, { ...rest, accountId: acct.id });
    if (changing) {
      await this.save(phone, 'IDLE');
      return this.send(phone, msg.accountSaved(acct.bank_name, acct.account_number.slice(-4)));
    }
    await this.save(phone, 'IDLE');
    return this.send(phone, msg.problemLogged(rest.code, caseRef(rest.caseId ?? '')));
  }
}

function caseRef(disputeId: string): string {
  return disputeId ? 'C-' + disputeId.replace(/-/g, '').slice(0, 6).toUpperCase() : 'C-NEW';
}

/** "0123456789 GTBank", "GTBank 0123456789", "0123456789 - opay" */
export function parseBankInput(text: string): { accountNumber: string; bankText: string } | null {
  const num = text.match(/\b(\d{10})\b/);
  if (!num) return null;
  const bankText = text.replace(num[1]!, ' ').replace(/[^a-zA-Z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!bankText) return null;
  return { accountNumber: num[1]!, bankText };
}

const ALIASES: Record<string, string[]> = {
  gtb: ['guaranty', 'gtbank'], gtbank: ['guaranty', 'gtbank'], gtco: ['guaranty', 'gtbank'], guaranty: ['guaranty'],
  opay: ['opay', 'paycom'], paycom: ['paycom', 'opay'], palmpay: ['palmpay'], moniepoint: ['moniepoint'], kuda: ['kuda'],
  uba: ['united bank for africa', 'uba'], firstbank: ['first bank'], fbn: ['first bank'], first: ['first bank'],
  zenith: ['zenith'], access: ['access'], diamond: ['access'], wema: ['wema'], alat: ['wema'], fcmb: ['first city', 'fcmb'],
  fidelity: ['fidelity'], sterling: ['sterling'], stanbic: ['stanbic'], union: ['union bank'], polaris: ['polaris'],
  keystone: ['keystone'], ecobank: ['ecobank'], providus: ['providus'], jaiz: ['jaiz'], unity: ['unity'], heritage: ['heritage'],
  globus: ['globus'], titan: ['titan'], taj: ['taj'], vfd: ['vfd'], carbon: ['carbon'], fairmoney: ['fairmoney'],
};

/** Finds the bank someone means from how they typed it. */
export function matchBank(input: string, banks: Bank[]): Bank | null {
  const clean = (s: string) => s.toLowerCase().replace(/\b(bank|plc|mfb|microfinance|limited|ltd|nigeria|of)\b/g, ' ').replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = clean(input);
  if (!q) return null;
  const key = q.replace(/\s/g, '');
  const targets = ALIASES[key] ?? ALIASES[q.split(' ')[0]!] ?? [q];
  const hits = banks.filter((b) => {
    const n = b.name.toLowerCase();
    return targets.some((t) => n.includes(t)) || clean(b.name) === q;
  });
  if (!hits.length) return null;
  // Prefer the shortest name ("Kuda" over "Kuda Microfinance Bank Ltd Lagos branch").
  return hits.sort((a, b) => a.name.length - b.name.length)[0]!;
}
