import type { Db } from '../db.js';
import { formatMoney, parseAmount, toMinor, type Currency } from '../money.js';
import { FakeProvider } from '../payments/fake.js';
import type { Bank, PaymentProvider } from '../payments/provider.js';
import { DealError, type DealService, type User } from '../deals/service.js';
import type { Messenger, Outbound } from './client.js';
import type { Inbound } from './inbound.js';
import { msg, STATUS_WORDS } from './messages.js';

/**
 * The WhatsApp conversation. Each person has a small state (what we're waiting for from them)
 * stored in chat_sessions. Buttons carry the deal code, so most taps need no state at all.
 */

type State = 'IDLE' | 'SELL_ITEM' | 'SELL_PRICE' | 'SELL_BANK' | 'SELL_BANK_CONFIRM' | 'SELL_CONFIRM' | 'DISPUTE_DETAIL' | 'REFUND_BANK' | 'REFUND_BANK_CONFIRM';
interface Session { state: State; data: Record<string, any> }

export interface FlowOptions {
  db: Db;
  deals: DealService;
  provider: PaymentProvider;
  messenger: Messenger;
  currency: Currency;
  testMode?: boolean;
  log?: (line: string) => void;
}

const CODE_RE = /\bHL-?([A-Z2-9]{5})\b/i;

export class Conversation {
  constructor(private readonly o: FlowOptions) {}

  private async session(phone: string): Promise<Session> {
    const r = await this.o.db.query(
      `INSERT INTO chat_sessions (phone, last_inbound_at) VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE SET last_inbound_at=now() RETURNING state, data`, [phone]);
    return { state: r.rows[0].state, data: r.rows[0].data ?? {} };
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

  private async route(m: Inbound, s: Session, user: User): Promise<void> {
    const text = m.text.trim();
    const lower = text.toLowerCase();

    // ----- buttons that carry a deal code -----
    if (m.buttonId) {
      const [action, code] = m.buttonId.split(':');
      switch (action) {
        case 'menu':
          if (code === 'sell') return this.startSelling(m.phone);
          if (code === 'deals') return this.listDeals(m.phone, user);
          return this.send(m.phone, msg.help());
        case 'pay': return this.o.deals.requestPayment(code!, user);
        case 'newacct': return this.o.deals.requestPayment(code!, user, true);
        case 'cancel': return this.o.deals.cancelByBuyer(code!, user);
        case 'shipped': return this.o.deals.markShipped(code!, user);
        case 'happy': return this.o.deals.confirmHappy(code!, user);
        case 'problem':
          await this.o.deals.openDispute(code!, user);
          return this.save(m.phone, 'DISPUTE_DETAIL', { code });
        case 'bank': return this.bankAnswer(m.phone, s, user, code === 'yes');
        case 'sell':
          if (code === 'confirm') return this.finishSelling(m.phone, s, user);
          return this.startSelling(m.phone);
      }
    }

    // ----- voice notes: Phase 2 -----
    if (m.type === 'audio' && s.state !== 'DISPUTE_DETAIL') return this.send(m.phone, msg.voiceSoon());

    // ----- test mode: pretend the buyer's transfer landed -----
    if (this.o.provider instanceof FakeProvider && this.o.testMode && ['paid', 'i paid', 'i have paid', 'done'].includes(lower)) {
      const ref = await this.o.deals.latestPendingPaymentFor(user.id);
      if (!ref) return this.send(m.phone, msg.testNothingToPay());
      this.o.provider.pay(ref);
      await this.o.deals.handleCollection(ref);
      return;
    }

    // ----- anywhere: "menu", "hi", or a deal code -----
    if (['menu', 'hi', 'hello', 'start', 'help', 'hey'].includes(lower)) {
      await this.save(m.phone, 'IDLE');
      return this.send(m.phone, msg.menu(user.display_name));
    }
    const codeMatch = text.match(CODE_RE);
    if (codeMatch && (s.state === 'IDLE' || /^pay\b/i.test(text))) {
      await this.save(m.phone, 'IDLE');
      return this.o.deals.joinAsBuyer('HL-' + codeMatch[1]!.toUpperCase(), user);
    }

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
        return this.bankTyped(m.phone, s, text);
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

  // ----- bank accounts -----
  private async bankTyped(phone: string, s: Session, text: string) {
    const parsed = parseBankInput(text);
    if (!parsed) return this.send(phone, msg.badBank());
    const bank = matchBank(parsed.bankText, await this.o.provider.listBanks());
    if (!bank) return this.send(phone, msg.bankNotFound(parsed.bankText));
    const name = await this.o.provider.resolveAccount(bank.code, parsed.accountNumber);
    if (!name) return this.send(phone, msg.accountNotFound());
    const next: State = s.state === 'SELL_BANK' ? 'SELL_BANK_CONFIRM' : 'REFUND_BANK_CONFIRM';
    await this.save(phone, next, { ...s.data, pendingAccount: { bank_code: bank.code, bank_name: bank.name, account_number: parsed.accountNumber, account_name: name } });
    return this.send(phone, msg.confirmBank(name, bank.name, parsed.accountNumber.slice(-4)));
  }

  private async bankAnswer(phone: string, s: Session, user: User, yes: boolean) {
    if (!['SELL_BANK_CONFIRM', 'REFUND_BANK_CONFIRM'].includes(s.state) || !s.data.pendingAccount) return this.send(phone, msg.didntUnderstand());
    const selling = s.state === 'SELL_BANK_CONFIRM';
    const { pendingAccount, ...rest } = s.data;
    if (!yes) {
      await this.save(phone, selling ? 'SELL_BANK' : 'REFUND_BANK', rest);
      return this.send(phone, selling ? msg.askBank() : msg.askRefundBank());
    }
    const acct = await this.o.deals.saveBankAccount(user.id, pendingAccount);
    if (selling) return this.showSellSummary(phone, { ...rest, accountId: acct.id });
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
