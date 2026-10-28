import type { SellerStats } from '../trust.js';
import type { Art, Clip } from './index.js';

/**
 * Short ways for messages to ask for a picture or a clip. The data here is what the card shows; nothing is drawn
 * until the message is sent (and never in dry run).
 */
export const HELD_WITH = 'Moniepoint MFB, licensed by the CBN';

/** An order's step (1–6) from its status. */
export function stepOf(status: string): number {
  return ({
    AWAITING_SELLER: 1, AWAITING_BUYER: 1, AWAITING_PAYMENT: 2, FUNDED: 3, SHIPPED: 4, RELEASING: 6, PAYOUT_PENDING: 6, COMPLETED: 6,
    DISPUTED: 3, REFUNDING: 3, REFUNDED: 3,
  } as Record<string, number>)[status] ?? 0;
}

const shortShip = (h: number | null) => h == null ? null : h < 1 ? '< 1 hour' : h < 20 ? `${Math.round(h)} hours` : h < 36 ? '1 day' : `${Math.round(h / 24)} days`;
const monthYear = (d: Date) => new Date(d).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

export const ART = {
  picture: (id: string): Art => ({ picture: id }),
  status: (step: number): Art | undefined => (step >= 1 && step <= 6 ? { picture: `status-${step}` } : undefined),
  trust: (t: SellerStats, userId?: string | null): Art => ({ card: 'trust', data: {
    name: t.name, city: t.city, since: monthYear(t.since), verified: t.verified, isNew: t.isNew, completed: t.completed,
    happyPct: t.rated ? Math.round((100 * t.happy) / t.rated) : null, rated: t.rated, ships: shortShip(t.shipHours), buyers: t.buyers, photoUser: userId ?? null,
  } }),
  trustStatus: (t: SellerStats, link: string, userId?: string | null): Art => ({ card: 'trustStatus', data: {
    name: t.name, city: t.city, verified: t.verified, isNew: t.isNew, completed: t.completed,
    happyPct: t.rated ? Math.round((100 * t.happy) / t.rated) : null, rated: t.rated, link, photoUser: userId ?? null,
  } }),
  moneyHeld: (side: 'buyer' | 'seller', amount: string, code: string, other?: string | null): Art => ({ card: 'moneyHeld', data: { side, amount, code, other: other ?? null, bank: HELD_WITH } }),
  payment: (d: { amount: string; accountNumber: string; bankName: string; accountName: string; validUntil?: string | null; code: string }): Art => ({ card: 'payment', data: { ...d } }),
  handover: (digits: string, code: string, to: 'rider' | 'driver' | 'seller'): Art => ({ card: 'handover', data: { digits, code, to } }),
  paid: (state: 'paid' | 'ready' | 'ambassador', amount: string, o: { bank?: string | null; code?: string | null; month?: string | null } = {}): Art => ({ card: 'paid', data: { state, amount, ...o } }),
  refund: (amount: string, code: string, bank?: string | null): Art => ({ card: 'refund', data: { amount, code, bank: bank ?? null } }),
  frozen: (side: 'buyer' | 'seller', amount: string, code: string, hours: number): Art => ({ card: 'frozen', data: { side, amount, code, hours } }),
  summary: (d: { side: 'buyer' | 'seller'; code?: string | null; title: string; item: string; lines: { icon: string; text: string }[]; big: { label: string; value: string }; note?: string | null; dealId?: string | null }): Art =>
    ({ card: 'summary', data: { side: d.side, code: d.code ?? null, title: d.title, item: d.item, lines: d.lines, big: d.big, note: d.note ?? null, photoDeal: d.dealId ?? null } }),
  complete: (item: string, n: number, other: string | null, dealId: string): Art => ({ card: 'complete', data: { item, n, other, photoDeal: dealId } }),
  fees: (rows: { price: string; hoolam: string; txn: string }[]): Art => ({ card: 'fees', data: { rows } }),
  ambMonth: (d: { name: string; month: string; amount: string; bars: { label: string; value: number }[]; people: number; activeSellers: number }): Art => ({ card: 'ambMonth', data: { ...d } }),
  ambWelcome: (name: string, link: string | null): Art => ({ card: 'ambWelcome', data: { name, link } }),
  /** The order before Send, inside the form: the photo, what to check, the real total (or what the seller receives). */
  formCheck: (d: { side: 'buyer' | 'seller'; item: string; lines: { icon: string; text: string }[]; big: { label: string; value: string }; note: string; photo?: Buffer | null }): Art =>
    ({ card: 'formCheck', data: { side: d.side, code: null, title: 'Check your order', item: d.item, lines: d.lines, big: d.big, note: d.note, photoBytes: d.photo ?? null } }),
  /** The picture on a new order alert (to a seller or a buyer who may not know Hoolam yet). Always shows how it works, in four steps. */
  orderRequest: (d: { to: 'seller' | 'buyer'; who: string; item: string; amount: string; code: string; check: string; dealId: string }): Art =>
    ({ card: 'orderRequest', data: { to: d.to, who: d.who, item: d.item, amount: d.amount, code: d.code, check: d.check, photoDeal: d.dealId } }),
  /** One order in My orders: where the money is, with the real amount. */
  formStatus: (d: { step: number; title: string; item: string; code: string; amountLabel: string; amount: string; money: string; tone?: 'teal' | 'gold' | 'green' | 'red'; photo?: Buffer | null; dealId?: string | null }): Art =>
    ({ card: 'formStatus', data: { step: d.step, title: d.title, item: d.item, code: d.code, amountLabel: d.amountLabel, amount: d.amount, money: d.money, tone: d.tone ?? 'teal', photoBytes: d.photo ?? null, photoDeal: d.dealId ?? null } }),
  ambShare: (firstName: string, link: string, area: string | null, userId: string): Art => ({ card: 'ambShare', data: { firstName, link, area, photoAmb: userId } }),
};

/** Voice notes and videos: sent only once the owner uploads them. `once`: the first time a person reaches it. */
export const CLIP = {
  how: [{ slot: 'voice-how' }, { slot: 'video-how' }] as Clip[],
  firstPay: [{ slot: 'voice-first-pay', once: true }, { slot: 'video-pay', once: true }] as Clip[],
  sellerHeld: [{ slot: 'voice-seller-held', once: true }] as Clip[],
  handoverBuyer: [{ slot: 'voice-handover', once: true }, { slot: 'video-handover', once: true }] as Clip[],
  handoverSeller: [{ slot: 'video-handover', once: true }] as Clip[],
  firstPayout: [{ slot: 'voice-first-payout', once: true }] as Clip[],
  idCheck: [{ slot: 'voice-id-check', once: true }] as Clip[],
  sellerFirst: [{ slot: 'video-seller', once: true }] as Clip[],
  firstOrder: [{ slot: 'video-how', once: true }] as Clip[],
  ambShare: [{ slot: 'video-amb-status' }] as Clip[],
};
