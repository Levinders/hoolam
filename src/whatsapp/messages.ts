import { formatMoney, type Currency } from '../money.js';
import type { ListSection, Outbound } from './client.js';
import { compact, shipText, shortBankName, type BuyerStats, type SellerStats } from '../trust.js';
import { SOCIAL_NAMES, type SocialKind } from '../socials.js';
import { CATEGORIES } from '../deals/categories.js';
import { localPhone } from '../phone.js';
import type { Art } from '../chat-art/index.js';
import { ART, CLIP, stepOf } from '../chat-art/build.js';

// Every message Hoolam sends, in one place. Plain words, short lines, and always answer
// the quiet question underneath: "where is my money right now?"

type Money = { minor: number; currency: Currency };
const m = (x: Money) => formatMoney(x.minor, x.currency);


/**
 * THE TWO MENUS: one for buying, one for selling. Everyone starts on the buying menu; becoming a seller
 * (a one-time setup that creates their trust card) unlocks the selling menu, and "Switch to …" moves between them.
 * To add an option: add a row (title up to 24 characters, description up to 72), then handle its id in
 * flow.ts (look for openMenuItem). WhatsApp allows 10 rows in total per menu.
 */
/**
 * Values from the console that messages mention: reply times and Hoolam's number (the example in "like 0…" hints).
 * app.ts points these at the live settings, so a change in the console shows in the very next message.
 */
const live = {
  repReplyMinutes: () => 30,
  problemReplyHours: () => 24,
  hoolamNumber: () => '' as string,
};
export function configureMessages(c: Partial<typeof live>) { Object.assign(live, c); }
const repText = (short = false) => { const n = live.repReplyMinutes(); return n < 60 ? `${n} ${short ? 'mins' : 'minutes'}` : n % 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n / 60} hour${n === 60 ? '' : 's'}`; };
const problemText = () => { const n = live.problemReplyHours(); return `${n} hour${n === 1 ? '' : 's'}`; };
/** Hoolam's number, the way people write it: the example number everywhere. */
export const exampleNumber = () => localPhone(live.hoolamNumber()) || '08012345678';

const HELP_ROWS = (switchTo: 'buyer' | 'seller') => [
  { id: 'menu:problem', title: '🚩 Report a problem', description: switchTo === 'seller' ? 'We hold the money until it’s sorted' : 'Get help with an order' },
  { id: 'menu:how', title: '💡 How it works', description: 'The steps and fees' },
  { id: 'menu:human', title: '🙋 Talk to a rep', description: `Live rep within ${repText(true)}` },
  switchTo === 'seller'
    ? { id: 'menu:tosell', title: '🔁 Switch to selling', description: 'Sell safely, get paid for sure' }
    : { id: 'menu:tobuy', title: '🔁 Switch to buying', description: 'Buy safely from any seller' },
];

export const buyerMenu = (): ListSection[] => [
  {
    title: 'Buying',
    rows: [
      { id: 'menu:buy', title: '🛒 Buy something', description: 'Your money’s held until you’re happy' },
      { id: 'menu:pay', title: '🔑 I have an order code', description: 'A seller sent you a code? Start here' },
      { id: 'menu:orders', title: '📋 My orders', description: 'All transactions · track your orders' },
      { id: 'menu:check', title: '🔍 Check a seller', description: 'See their record before you buy' },
    ],
  },
  { title: 'Help', rows: HELP_ROWS('seller') },
];

export const sellerMenu = (): ListSection[] => [
  {
    title: 'Selling',
    rows: [
      { id: 'menu:sell', title: '🏷️ Sell something', description: 'Your buyer pays Hoolam first, safely' },
      { id: 'menu:orders', title: '📋 My orders', description: 'Track your sales and payouts' },
      { id: 'menu:card', title: '🛡️ My trust card', description: 'Your public brand image' },
      { id: 'menu:account', title: '🏦 Payout account', description: 'Where we send your money' },
    ],
  },
  { title: 'Help', rows: HELP_ROWS('buyer') },
];

export type MenuMode = 'buyer' | 'seller';
/** The menu for a side. `extra`: one more row at the very end (the ambassador row, when it applies to this person). */
export const menuFor = (mode: MenuMode, extra?: ListRowLite | null): ListSection[] => {
  const sections = mode === 'seller' ? sellerMenu() : buyerMenu();
  if (extra) sections[sections.length - 1]!.rows.push(extra);
  return sections;
};
type ListRowLite = { id: string; title: string; description?: string };
export const BUYER_MENU = buyerMenu();
export const SELLER_MENU = sellerMenu();

/** The whole idea in four lines. Used in the welcome and in "How it works". */
const STORY =
  '💳  Buyer pays\n' +
  '🛡️  Hoolam holds the money\n' +
  '📦  Seller delivers\n' +
  '✅  Buyer is happy → seller gets paid';

/** A message with a "Main menu" button under it, so nobody is left at a dead end. */
/** "+2348012345678" → "+234 801 ••• 5678" */
const maskPhone = (p: string) => p.length > 8 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ••• ${p.slice(-4)}` : p;
export { localPhone };
const first = (name: string | null) => (name ? ` *${name.split(' ')[0]}*` : '');
/** "*Ada* · Order *HL-7K2QF*": the other person's name always comes before the order ID. */
const ref = (code: string, name?: string | null) => (name ? `*${name}* · Order *${code}*` : `Order *${code}*`);
/** A buyer's or seller's name, in bold. Every name in the chat is bold. */
const b = (name: string) => `*${name}*`;

/** The seller's money, line by line: total price, Hoolam's or the transaction fee, the rider's fee, then what's left. */
export interface SellerSum { price: Money; fee: Money; feeLabel: string; gets: Money; delivery?: Money | null; role?: 'rider' | 'driver' }
const sellerSum = (s: SellerSum, last = 'You receive'): string => {
  const net = { minor: s.gets.minor - (s.delivery?.minor ?? 0), currency: s.gets.currency };
  return `Total price  ${m(s.price)}\n` +
    (s.fee.minor > 0 ? `${s.feeLabel}  −${m(s.fee)}\n` : '') +
    (s.delivery && s.delivery.minor > 0 ? `${s.role === 'driver' ? 'Driver' : 'Rider'}'s fee  −${m(s.delivery)}\n` : '') +
    `*${last}  ${m(net)}*`;
};
/** The buyer's money, line by line: total price, their fee, what they pay. */
export interface BuyerSum { price: Money; fee: Money; feeLabel: string; pay: Money }
const buyerSum = (s: BuyerSum, last = 'You pay'): string =>
  `Total price  ${m(s.price)}\n` + (s.fee.minor > 0 ? `${s.feeLabel}  ${m(s.fee)}\n` : '') + `*${last}  ${m(s.pay)}*`;
/** "3:45 PM today", "9:10 AM tomorrow" or "9:10 AM, 14 Oct": Lagos time. */
export function expiryText(at: Date, now = new Date()): string {
  const tz = 'Africa/Lagos';
  const time = at.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
  if (day(at) === day(now)) return `${time} today`;
  if (day(at) === day(new Date(now.getTime() + 86400_000))) return `${time} tomorrow`;
  return `${time}, ${at.toLocaleDateString('en-GB', { timeZone: tz, day: 'numeric', month: 'short' })}`;
}
/** Under every address question in the chat: a pin is welcome, typing stays the main way. */
const PIN_HINT = '\n\n📍 Or share your location: tap 📎 → *Location*.';
/** A map link anyone can open: the exact pin when one was shared, else a search for the typed address. */
export function mapsLink(address: string | null | undefined, pin?: string | null): string | null {
  if (pin && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(pin)) return `https://www.google.com/maps/search/?api=1&query=${pin}`;
  const a = (address ?? '').trim();
  return a.length >= 5 ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}` : null;
}

const withMenu = (text: string): Outbound => ({ kind: 'buttons', text, buttons: [{ id: 'menu:open', title: 'Main menu' }] });
/** withMenu with a picture on top. */
const withArt = (art: Art | undefined, text: string): Outbound => ({ ...withMenu(text), ...(art ? { art } : {}) });

/** What someone was doing when the ID check came up. */
export type KycWhy = 'order' | 'accept' | 'pay' | 'seller' | 'payout' | 'ambassador';
const kycWhyText = (why: KycWhy, l: { noId: Money; verified: Money }): string => ({
  order: `🪪 *Quick ID check, once*\n\nOrders above *${m(l.noId)}* need your ID checked. You do it once, then you can do orders up to *${m(l.verified)}*.`,
  accept: `🪪 *Quick ID check, once*\n\nThis order is above *${m(l.noId)}*, so we check your ID before you accept. You do it once. The order waits for you.`,
  pay: `🪪 *Quick ID check, once*\n\nThis order is above *${m(l.noId)}*, so we check your ID before you pay. You do it once. The order waits for you.`,
  seller: '🪪 *One step before your payout account*\n\nWe check every seller\'s ID once. Then your payout account must be in the same name. Buyers see *Verified seller* on your trust card.',
  payout: '🪪 *One step before we pay you*\n\nWe check every seller\'s ID once. Then your money goes to an account in your name.',
  ambassador: '🪪 *First, a quick ID check*\n\nEvery Hoolam ambassador checks their ID once. It keeps the programme safe, and people you invite see you as a *Verified Hoolam ambassador*.',
}[why]);

export const msg = {
  moneyText: (x: Money): string => m(x),
  /** First time we meet someone: the story in four lines, and one question: buying or selling? */
  welcome: (name: string | null): Outbound => ({
    kind: 'buttons',
    text: `Hi${first(name)} 👋 *Welcome to Hoolam*\n\nBuy and sell on WhatsApp without fear. Your money waits with Hoolam until you get what you ordered.\n\nWhat brings you here?`,
    buttons: [{ id: 'menu:tobuy', title: '🛒 I’m buying' }, { id: 'menu:sell', title: '🏷️ I’m selling' }, { id: 'menu:how', title: '💡 How it works' }],
    art: ART.picture('how-it-works'),
  }),

  /** Everyone after that: short, straight to the options for the side they're on. */
  menu: (name: string | null, mode: MenuMode = 'buyer', note?: string, extra?: ListRowLite | null): Outbound => ({
    kind: 'list',
    header: mode === 'seller' ? '🏷️ Selling' : '🛒 Buying',
    text: note ? `${note}\n\nWhat would you like to do?` : `Hi${first(name)} 👋 What would you like to do?`,
    footer: 'Your money stays safe with Hoolam',
    button: 'Open menu',
    sections: menuFor(mode, extra),
  }),

  // ----- becoming a seller (once) -----
  setupIntro: (whatsappName: string | null): Outbound => ({
    kind: whatsappName ? 'buttons' : 'text',
    text:
      '🏷️ *Set up as a seller*\n\nOne time, two quick questions. This creates your *trust card*, like the one above: the record buyers see before they pay you.\n\n' +
      'What name should buyers see? Your shop or brand name.' + (whatsappName ? `\n\nOr keep the name from your WhatsApp: *${whatsappName}*` : '\n\nFor example: _Bayo Kicks_'),
    ...(whatsappName ? { buttons: [{ id: 'setup:wname', title: 'Use this name' }] } : {}),
    art: ART.picture('sample-trust'),
  } as Outbound),
  setupCity: (): Outbound => ({ kind: 'buttons', text: '📍 Which city do you sell from?\n\nFor example: _Port Harcourt_', buttons: [{ id: 'setup:nocity', title: 'Skip' }] }),
  setupDone: (card: string, thenSell: boolean, art?: Art): Outbound => thenSell
    ? { kind: 'text', text: art ? '✅ *Your trust card is ready* 🎉\n\nIt grows with every order you complete. Now, your first sale 👇' : `✅ *Your trust card is ready*\n\n${card}\n\nIt grows with every order you complete. Now, your first sale 👇`, ...(art ? { art } : {}) }
    : {
      kind: 'buttons',
      text: art ? '✅ *Your trust card is ready* 🎉\n\nIt grows with every order you complete. Add a photo and your Instagram any time under *My trust card*.'
        : `✅ *Your trust card is ready*\n\n${card}\n\nIt grows with every order you complete. Add a photo and your Instagram any time under *My trust card*.`,
      buttons: [{ id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:open', title: 'Main menu' }],
      ...(art ? { art } : {}),
    },
  switchedTo: (mode: MenuMode): string => (mode === 'seller' ? '🔁 You’re on the *selling* menu now.' : '🔁 You’re on the *buying* menu now.'),

  help: (): Outbound => ({
    kind: 'buttons',
    text:
      '💡 *How it works*\n\n' +
      'You pay Hoolam, not the seller. We hold the money while the seller delivers. You check the item, tap *I\'m happy*, and the seller is paid.\n\n' +
      '🚩 A problem? The money stays frozen until it\'s sorted.',
    buttons: [{ id: 'menu:buy', title: '🛒 Buy something' }, { id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:fees', title: '🧾 Fees' }],
    art: ART.picture('how-it-works'), clips: CLIP.how,
  }),

  fees: (rules: string, examples: string[], maxDeal: Money, art?: Art): Outbound => ({
    ...withMenu(art
      ? `🧾 *Fees*\n\n${rules}\n\nNo hidden charges. Orders up to ${m(maxDeal)} for now. Cancelled before payment? No fee.`
      : `🧾 Fees\n\n${rules}\n\n${examples.join('\n')}\n\nOrders up to ${m(maxDeal)} for now. Cancelled before payment? No fee.`),
    ...(art ? { art } : {}),
  }),

  // ----- buyer starts from the menu -----
  askDealCode: (): Outbound => ({ kind: 'text', text: '💳 Send the order code from your seller.\n\nIt starts with *HL-*, like *HL-7K2QF*.', art: ART.picture('code-where') }),
  badDealCode: (): Outbound => withMenu('🤔 That doesn\'t look like an order code.\n\nIt starts with *HL-*, like HL-7K2QF. Check with your seller and send it again.'),

  // ----- problems from the menu -----
  noDealsToReport: (): Outbound => ({
    kind: 'buttons',
    text: '🛡️ No paid orders open right now, so there\'s no money to freeze.\n\nSomething else on your mind? Talk to us.',
    buttons: [{ id: 'menu:human', title: '🙋 Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  noOrdersToReport: (): Outbound => ({
    kind: 'buttons',
    text: '📋 You have no open orders right now.\n\nSomething else on your mind? Talk to a rep.',
    buttons: [{ id: 'menu:human', title: '🙋 Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  pickOrderForSellerProblem: (rows: { code: string; item: string }[]): Outbound => ({
    kind: 'list',
    text: '🚩 Which order is the problem about?',
    button: 'Choose order',
    sections: [{ title: 'Your open orders', rows: rows.slice(0, 10).map((r) => ({ id: `sproblem:${r.code}`, title: r.code, description: r.item.slice(0, 72) })) }],
  }),
  askSellerProblem: (code: string, buyerName?: string | null): Outbound => ({ kind: 'text', text: `🚩 ${ref(code, buyerName)}: what's wrong? Type it, or send a photo.\n\nA live rep replies right here within ${repText()}.` }),
  pickDealForProblem: (rows: { code: string; item: string }[]): Outbound => ({
    kind: 'list',
    text: '🚩 Which order has a problem?\n\nWe\'ll freeze its money while we sort it out.',
    button: 'Choose order',
    sections: [{ title: 'Your paid orders', rows: rows.slice(0, 10).map((r) => ({ id: `problem:${r.code}`, title: r.code, description: r.item.slice(0, 72) })) }],
  }),

  // ----- payout account -----
  accountInfo: (accountName: string, bankName: string, last4: string): Outbound => ({
    kind: 'buttons',
    text: `🏦 We send your money here:\n\n*${accountName}*\n${bankName} ••••${last4}`,
    buttons: [{ id: 'account:change', title: '✏️ Change account' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askNewAccount: (): Outbound => ({ kind: 'text', text: '🏦 Send the new account number. We\'ll show you the banks to pick from.\n\nFor example: _0123456789_' }),
  accountSaved: (bankName: string, last4: string): Outbound => withMenu(`✅ Saved. New orders pay into ${bankName} ••••${last4}.\n\nOrders already running keep their account.`),

  // ----- talk to a person -----
  askHumanMessage: (): Outbound => ({ kind: 'text', text: `🙋 Type your message for the team. A photo works too.\n\nA live rep replies right here, within ${repText()}.` }),
  humanLogged: (ref: string, replyTo?: string | null): Outbound => ({
    ...withMenu(`A rep will reply here within ${repText()}. (Ref ${ref})`),
    ...(replyTo ? { react: { to: replyTo, emoji: '✅' } } : {}),
  }),

  testNothingToPay: (): Outbound => ({ kind: 'text', text: 'TEST MODE: there is no payment waiting. Open an order link and tap "Pay now" first.' }),
  voiceSoon: (): Outbound => ({ kind: 'buttons', text: 'I can\'t listen to voice notes yet 🙏 Please type it, or talk to a rep.', buttons: [{ id: 'menu:human', title: '🙋 Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }] }),



  // ===== TRUST CARD =====
  /** One line, shown right above "Pay now". */
  trustLine: (t: SellerStats): string => {
    const parts = [`🛡️ *${t.name}*`];
    if (t.verified) parts.push('☑️ *Verified seller*');
    if (t.isNew) parts.push('🌱 New on Hoolam');
    if (t.completed) parts.push(`✅ ${t.completed} order${t.completed === 1 ? '' : 's'}`);
    if (t.rated >= 5) parts.push(`👍 ${Math.round((100 * t.happy) / t.rated)}%`);
    if (t.refunded) parts.push(`⚖️ ${t.refunded} refunded`);
    return parts.join(' · ');
  },

  /** The full card, as text. */
  trustCardText: (t: SellerStats): string => {
    const lines = [`🛡️ *${t.name}*${t.city ? ' · ' + t.city : ''}`, `On Hoolam since ${t.since.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`];
    if (t.verified) lines.push('☑️ *Verified seller*: ID and bank account name checked by Hoolam');
    lines.push('');
    if (t.isNew) lines.push(`🌱 New on Hoolam: ${t.completed ? `${t.completed} order${t.completed === 1 ? '' : 's'} so far` : 'no completed orders yet'}`);
    else lines.push(`✅ ${t.completed} orders completed`);
    if (t.buyers > 1) lines.push(`👥 ${t.buyers} different buyers`);
    if (t.shipHours != null) lines.push(`📦 Ships ${shipText(t.shipHours)}`);
    if (t.problems) {
      const open = t.problems - t.refunded - t.released;
      const how = [t.refunded ? `${t.refunded} refunded after review` : '', t.released ? `${t.released} settled in the seller's favour` : '', open > 0 ? `${open} being reviewed` : ''].filter(Boolean);
      lines.push(`⚖️ ${t.problems} problem${t.problems === 1 ? '' : 's'} reported${how.length ? ' · ' + how.join(' · ') : ''}`);
    } else if (t.completed) lines.push('⚖️ No problems reported');
    if (t.rated >= 5) lines.push(`👍 ${Math.round((100 * t.happy) / t.rated)}% of buyers happy (${t.rated} ratings)`);
    else if (t.rated) lines.push(`👍 ${t.happy} of ${t.rated} buyer${t.rated === 1 ? '' : 's'} happy`);
    if (t.bankName) lines.push(`🏦 Paid out to ${shortBankName(t.bankName)}, bank-verified${t.bankMatches ? ' ✓ matches their name' : ''}`);
    if (t.pageViews) lines.push(`👀 ${compact(t.pageViews)} page views`);
    if (t.socials.length) lines.push(`🔗 ${t.socials.map((s) => `${s.kind === 'website' ? '' : SOCIAL_NAMES[s.kind] + ' '}${s.label}`).join(' · ')}`);
    lines.push('', '_Counted from real orders paid through Hoolam._');
    return lines.join('\n');
  },

  /** A buyer's record, for sellers. */
  buyerLine: (b: BuyerStats): string => {
    if (!b.purchases && !b.problems) return `👤 *${b.name}* · 🌱 new buyer on Hoolam`;
    const bits = [`👤 *${b.name}*`, `🛍️ ${b.purchases} purchase${b.purchases === 1 ? '' : 's'}`];
    bits.push(b.problems ? `⚖️ ${b.problems} problem${b.problems === 1 ? '' : 's'} reported${b.refunded ? ` (${b.refunded} refunded)` : ''}` : 'no problems reported');
    return bits.join(' · ');
  },

  /** A buyer looks at a seller's record (from an order, or "Check a seller"). */
  sellerRecord: (card: string, payCode: string | null, buyFromId: string | null, acceptCode: string | null = null, art?: Art): Outbound => ({
    kind: 'buttons',
    text: card,
    ...(art ? { art } : {}),
    buttons: acceptCode
      ? [{ id: `baccept:${acceptCode}`, title: '✅ Accept order' }, { id: 'menu:open', title: 'Main menu' }]
      : payCode
      ? [{ id: `pay:${payCode}`, title: '💳 Pay now' }, { id: 'menu:open', title: 'Main menu' }]
      : [...(buyFromId ? [{ id: `buyfrom:${buyFromId}`, title: '🛒 Buy from them' }] : []), { id: 'menu:check', title: '🔍 Check another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askCheckSeller: (): Outbound => ({ kind: 'text', text: `🔍 Send the seller's WhatsApp number, or an order code they gave you.\n\nFor example: _${exampleNumber()}_ or _HL-7K2QF_` }),
  noSellerRecord: (): Outbound => ({
    kind: 'buttons',
    text: '🌱 No Hoolam record for that number yet. That doesn\'t mean they\'re bad, just new here.\n\nStay safe either way: with a Hoolam order, your money is held until you\'re happy.',
    buttons: [{ id: 'menu:buy', title: '🛒 Buy something' }, { id: 'menu:check', title: '🔍 Check another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyingFrom: (name: string, trust: string): Outbound => ({ kind: 'text', text: `🛒 You're buying from *${name}*\n${trust}\n\nWhat are you buying?\nFor example: _Black sneakers, size 42_\n\n💡 You only pay after *${name}* accepts.` }),

  /** A seller looks at their own card. */
  myTrustCard: (card: string, url: string | null, stats: { views30: number; buys30: number } | null = null, art?: Art): Outbound => ({
    kind: 'buttons',
    ...(art ? { art } : {}),
    text: `${card}\n\n👀 This is what buyers see before they pay.` + (url ? `\n\n🔗 Your page: ${url}` : '')
      + (stats && url ? `\n📊 Last 30 days: *${compact(stats.views30)}* ${stats.views30 === 1 ? 'view' : 'views'} · *${compact(stats.buys30)}* tapped Buy` : ''),
    buttons: url
      ? [{ id: 'card:share', title: '🔗 Share my link' }, { id: 'card:edit', title: '✏️ Edit my page' }, { id: 'card:hide', title: '🙈 Hide my page' }]
      : [{ id: 'card:share', title: '🔗 Share my card' }, { id: 'card:edit', title: '✏️ Edit my page' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askBusinessName: (current: string): Outbound => ({
    kind: 'buttons',
    text: `🏷️ What name should buyers see? Your shop or brand name.\n\nNow: *${current}*`,
    buttons: [{ id: 'card:wname', title: 'Keep this name' }],
  }),
  /** What a seller can change on their page. */
  editMyPage: (t: SellerStats, hasPhoto: boolean, proof: { video: { live: boolean; pending: boolean } | null } = { video: null }): Outbound => {
    const now = (k: SocialKind) => t.socials.find((s) => s.kind === k)?.label;
    const row = (k: SocialKind, icon: string) => ({ id: `card:s-${k}`, title: `${icon} ${SOCIAL_NAMES[k]}`.slice(0, 24), description: now(k) ? `Now: ${now(k)}`.slice(0, 72) : `Add your ${k === 'website' ? 'website or online store' : SOCIAL_NAMES[k]}` });
    return {
      kind: 'list',
      text: '✏️ *Edit my page*\n\nA photo and your links help buyers trust you before they pay. Pick what to change.',
      button: 'Choose',
      sections: [
        { title: 'About you', rows: [
          { id: 'card:photo', title: '📸 Photo', description: hasPhoto ? 'Change or remove your photo' : 'Add your face or your shop' },
          { id: 'card:name', title: '🏷️ Name & city', description: `Now: ${t.name}${t.city ? ', ' + t.city : ''}`.slice(0, 72) },
        ] },
        { title: 'Where you sell', rows: [row('instagram', '📷'), row('tiktok', '🎵'), row('facebook', '👥'), row('website', '🌐')] },
        { title: 'Proof for buyers', rows: [
          ...(proof.video ? [{ id: 'card:video', title: '🎥 Video', description: proof.video.pending ? 'Waiting for Hoolam\'s check' : proof.video.live ? 'On your page. Change or remove it' : 'Let buyers see and hear you' }] : []),
          { id: 'card:delivered', title: '📦 Delivered photos', description: t.showDelivered ? 'On: your delivered items show. Tap to hide' : 'Off: show items you\'ve delivered' },
        ] },
      ],
    };
  },
  askProfilePhoto: (hasPhoto: boolean): Outbound => ({
    kind: 'buttons',
    art: ART.picture('photo-tips'),
    text: '📸 Send a clear photo of *you* or *your shop*.\n\nIt shows in a circle on your page, so keep the face or the shop in the middle.',
    buttons: [...(hasPhoto ? [{ id: 'card:rmphoto', title: '🗑️ Remove photo' }] : []), { id: 'card:cancel', title: 'Cancel' }],
  }),
  // ===== MY PAGE: VIDEO AND DELIVERED PHOTOS =====
  askSellerVideo: (state: { live: boolean; pending: boolean }): Outbound => ({
    kind: 'buttons',
    text: `🎥 *A short video for your page*\n\nBuyers trust a face and a voice. Record 30 seconds or less on your phone, then send it here.\n\n1️⃣ Say your name and what you sell\n2️⃣ Show your shop or your products\n3️⃣ Say: _"Pay through Hoolam, your money is safe"_\n\nHoolam checks every video before buyers see it.${state.pending ? '\n\n⏳ Your last video is still being checked. A new one replaces it.' : ''}`,
    buttons: [...(state.live || state.pending ? [{ id: 'card:rmvideo', title: '🗑️ Remove video' }] : []), { id: 'card:cancel', title: 'Cancel' }],
  }),
  videoNeeded: (): Outbound => ({ kind: 'buttons', text: '🎥 Please send a video (not a photo, file or link). 30 seconds or less.', buttons: [{ id: 'card:cancel', title: 'Cancel' }] }),
  videoTooBig: (): Outbound => ({ kind: 'buttons', text: '😕 That video is too long. Please send one of 30 seconds or less.', buttons: [{ id: 'card:cancel', title: 'Cancel' }] }),
  videoFailed: (): Outbound => ({ kind: 'buttons', text: '😕 We couldn\'t use that video. Please try again.', buttons: [{ id: 'card:cancel', title: 'Cancel' }] }),
  videoReceived: (): Outbound => withMenu('✅ Got it! Hoolam checks your video, usually within a day. We\'ll tell you here once it\'s on your page.'),
  videoApproved: (url: string | null): Outbound => withMenu(`🎉 Your video is on your page now. Buyers can see and hear you before they pay.${url ? `\n\n${url}` : ''}`),
  videoRejected: (reason: string): Outbound => withMenu(`😕 We couldn't put your video on your page.\n\n*Why:* ${reason}\n\nYou can send a new one any time: My page → Edit my page → Video.`),
  deliveredOn: (count: number): Outbound => withMenu(count
    ? `📦 Done. Photos of items you've delivered now show on your page (your own order photos only, never a buyer's).`
    : `📦 Done. Once you complete an order with photos you added, they'll show on your page (your own photos only, never a buyer's).`),
  deliveredOff: (): Outbound => withMenu('📦 Done. Delivered photos are hidden from your page.'),
  photoNeeded: (): Outbound => ({ kind: 'buttons', text: '📸 Please send a photo (not a file or a link).', buttons: [{ id: 'card:cancel', title: 'Cancel' }] }),
  photoFailed: (): Outbound => ({ kind: 'buttons', text: '😕 We couldn\'t use that photo. Please try another one.', buttons: [{ id: 'card:cancel', title: 'Cancel' }] }),
  askSocial: (kind: SocialKind, current: string | null): Outbound => ({
    kind: 'buttons',
    text: (kind === 'website'
      ? '🌐 Send your website or online store link.\n\nFor example: _bayokicks.com_'
      : `${kind === 'instagram' ? '📷' : kind === 'tiktok' ? '🎵' : '👥'} Send your ${SOCIAL_NAMES[kind]} ${kind === 'facebook' ? 'page link or name' : 'username or link'}.\n\nFor example: _${kind === 'facebook' ? 'facebook.com/bayokicks' : '@bayokicks'}_`)
      + (current ? `\n\nNow: *${current}*` : ''),
    buttons: [...(current ? [{ id: `card:rm-${kind}`, title: '🗑️ Remove it' }] : []), { id: 'card:cancel', title: 'Cancel' }],
  }),
  socialRefused: (error: string, kind: SocialKind): Outbound => ({ kind: 'buttons', text: `😕 ${error}`, buttons: [{ id: `card:s-${kind}`, title: 'Try again' }, { id: 'card:cancel', title: 'Cancel' }] }),
  pageUpdated: (what: string, url: string | null): Outbound => ({
    kind: 'buttons',
    text: `✅ ${what}` + (url ? `\n\n👀 See it: ${url}` : '\n\nShare your page so buyers can see it.'),
    buttons: [{ id: 'card:edit', title: '✏️ Edit more' }, { id: 'card:share', title: url ? '🔗 Share my link' : '🔗 Share my card' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askCity: (): Outbound => ({ kind: 'buttons', text: '📍 Which city are you in?', buttons: [{ id: 'card:nocity', title: 'Skip' }] }),
  cardShared: (url: string, art?: Art): Outbound => ({
    ...withMenu(art
      ? `🔗 Your page is live:\n${url}\n\n📲 Save the picture above and post it on your WhatsApp status. Then forward the next message to buyers. Anyone who taps *Buy safely* starts a protected order with you.`
      : `🔗 Your page is live:\n${url}\n\nPost it on Instagram, your WhatsApp status, or send it to buyers. Anyone who taps *Buy safely* starts a protected order with you.\n\nTip: forward the next message as it is.`),
    ...(art ? { art } : {}),
  }),
  cardForwardText: (name: string, url: string): Outbound => ({ kind: 'text', noMenu: true, text: `🛡️ Buy from *${name}* safely with Hoolam. Your money is held until you're happy with your order.\n\n${url}` }),
  cardHidden: (): Outbound => withMenu('🙈 Your page is hidden. Buyers still see your record on your orders, to keep them safe.'),

  // ===== RATINGS =====
  ratedUp: (sellerName: string): Outbound => ({ ...withMenu(`🙏 Thanks! It's on *${sellerName}*'s record now, and it helps the next buyer.`), sticker: 'thanks' }),
  askReview: (sellerName: string, code: string): Outbound => ({
    kind: 'buttons',
    text: `🙏 Thanks! It's on *${sellerName}*'s record now.\n\nWant to say a few words for the next buyer? (Optional)`,
    buttons: [{ id: `revw:${code}`, title: '✍️ Say a few words' }, { id: `revno:${code}`, title: 'No thanks' }],
    sticker: 'thanks',
  }),
  askReviewText: (sellerName: string): Outbound => ({
    kind: 'text', noMenu: true,
    text: `✍️ Type a few words about *${sellerName}* (up to 160 letters).\n\nFor example: _"Fast delivery, exactly like the pictures."_`,
  }),
  reviewNotOk: (why: 'short' | 'long' | 'contact'): Outbound => ({
    kind: 'text', noMenu: true,
    text: why === 'long' ? '✂️ That\'s a bit long. Please keep it to 160 letters.'
      : why === 'contact' ? '🔒 Please leave out links, phone numbers and usernames. Just a few words about the order.'
      : '✍️ Please type a few words, or send *skip*.',
  }),
  askReviewConsent: (text: string, name: string, area: string | null, code: string): Outbound => ({
    kind: 'buttons',
    text: `Can we show this on the seller's Hoolam page?\n\n_"${text}"_\n— ${name}${area ? `, ${area}` : ''}\n\nOnly your first name${area ? ' and area' : ''} show. Never your number.`,
    buttons: [{ id: `revyes:${code}`, title: '✅ Yes, show it' }, { id: `revpriv:${code}`, title: '🔒 Keep it private' }],
  }),
  reviewShown: (sellerName: string): Outbound => withMenu(`💚 Thank you! Your words are on *${sellerName}*'s page now.`),
  reviewPrivate: (): Outbound => withMenu('🙏 Thank you. Only the Hoolam team will see it.'),
  reviewSkipped: (): Outbound => withMenu('👍 No problem. Thanks for buying safely!'),
  askRatingComment: (code: string): Outbound => ({
    kind: 'buttons',
    text: '😕 Sorry it wasn\'t great. What went wrong? (Optional. Only our team sees this.)',
    buttons: [{ id: `ratenote:${code}`, title: 'Skip' }],
  }),
  ratingCommentThanks: (): Outbound => withMenu('🙏 Thanks. A real person on our team reads every one.'),
  alreadyRated: (): Outbound => withMenu('🙏 You\'ve already rated this order. Thanks!'),

  // ===== BUYER STARTS A DEAL =====
  /** The button that opens the WhatsApp form. */
  buyForm: (flowId: string, mode: 'draft' | 'published', first = false): Outbound => ({
    kind: 'form',
    header: '🛒 Buy safely',
    text: 'Tell us what you\'re buying. It takes a minute.\n\n💡 You only pay after the seller accepts, and your money stays with Hoolam until you\'re happy.',
    footer: 'Prefer typing? Just send the item name.',
    cta: 'Start my order',
    flowId, flowToken: 'buy:v1', screen: 'ITEM', mode, data: { first },
  }),
  // chat version, for phones or accounts where the form isn't available
  askBuyItem: (): Outbound => ({ kind: 'text', text: '🛒 What are you buying?\n\nFor example: _Black sneakers, size 42_\n\n💡 You only pay after the seller accepts.' }),
  askBuyPrice: (): Outbound => ({ kind: 'text', text: '💰 What price did you agree with the seller? (in naira)\n\nFor example: _15000_' }),
  askBuyPhotos: (): Outbound => ({
    kind: 'buttons',
    text: '📷 Got a photo of the item? Send up to 3.\n\nA screenshot of the seller\'s post works. It\'s your proof of what was promised.',
    buttons: [{ id: 'buy:nophotos', title: 'No photos' }],
  }),
  photoAdded: (n: number, max: number, flow: 'buy' | 'sell' = 'buy'): Outbound => n >= max
    ? { kind: 'text', text: `📷 ${n} photos saved.` }
    : { kind: 'buttons', text: `📷 ${n === 1 ? 'Photo' : n + ' photos'} saved. Send another, or tap Done.`, buttons: [{ id: `${flow}:photosdone`, title: 'Done' }] },
  askSellerPhone: (): Outbound => ({ kind: 'text', text: `📨 What's the *seller's WhatsApp number*?\n\nWe'll send them your order. For example: _${exampleNumber()}_` }),
  badSellerPhone: (): Outbound => ({ kind: 'text', text: `🤔 I couldn't read that number. Type the seller's WhatsApp number like _${exampleNumber()}_.` }),
  /** Their own number, typed as the other person's. */
  ownNumberTyped: (who: 'seller' | 'buyer'): Outbound => ({ kind: 'text', text: `🤔 That's your own number. Please type the *${who}'s* WhatsApp number.` }),

  /** Check before sending. The Hoolam fee is added once the seller accepts (they may update the price). */
  buySummary: (d: { item: string; description?: string | null; category?: string | null; address?: string | null; photos: number; arriveBy: string | null; sellerPhone: string | null; total: Money; feeRule: string }): Outbound => ({
    kind: 'buttons',
    art: ART.summary({
      side: 'buyer', title: 'Check your order', item: d.item, big: { label: 'Total price', value: m(d.total) },
      lines: [
        ...(d.sellerPhone ? [{ icon: 'store', text: `Seller: ${localPhone(d.sellerPhone)}` }] : []),
        ...(d.address ? [{ icon: 'mapPin', text: d.address }] : []), ...(d.arriveBy ? [{ icon: 'calendar', text: `Expected by ${d.arriveBy}` }] : []),
      ],
      note: 'Nothing to pay yet. You pay after the seller accepts.',
    }),
    text:
      `🛒 *Check your order*\n\n*${d.item}*\n` +
      (d.description ? `${d.description}\n` : '') +
      (d.category ? `🏷️ ${d.category}\n` : '') +
      (d.photos ? `📷 ${d.photos} photo${d.photos > 1 ? 's' : ''}\n` : '') +
      (d.address ? `📍 Deliver to: *${d.address}*\n` : '') +
      (d.arriveBy ? `📅 Expected by *${d.arriveBy}*\n` : '') +
      `📨 Seller's WhatsApp: *${localPhone(d.sellerPhone ?? '')}*\n\n` +
      `*💰 Total price  ${m(d.total)}*\n_Delivery included, if any._\n\n` +
      `🧾 Hoolam's fee is added when the seller accepts: ${d.feeRule}.\n\n💡 Nothing to pay yet. You pay after the seller accepts.\n\nIs everything right?`,
    buttons: [{ id: 'buy:send', title: '📨 Send to seller' }, { id: 'buy:edit', title: '✏️ Edit order' }, { id: 'buy:restart', title: '🔄 Start again' }],
  }),
  /** The order to check, in the form: photos, details, then Send / Edit / Start again. */
  buyReview: (flowId: string, mode: 'draft' | 'published', flowToken: string, item: string, total: Money): Outbound => ({
    kind: 'form',
    header: '🛒 Check your order',
    text: `*${item}*\n💰 Total price *${m(total)}*\n\nLook over the photos and details, then send it to the seller. You can still change anything.\n\n💡 Nothing to pay yet.`,
    cta: 'Review order',
    flowId, flowToken, screen: 'ORDER', mode, live: true,
  }),
  /** The buyer's form again, filled in with their answers. */
  buyEditForm: (flowId: string, mode: 'draft' | 'published', data: Record<string, string>): Outbound => ({
    kind: 'form',
    header: '✏️ Edit your order',
    text: 'Your answers are filled in. Change what you need, then tap *Review my order*.',
    cta: 'Edit order',
    flowId, flowToken: 'buyedit:v1', screen: 'ITEM', mode, data,
  }),
  /** Chat version of "Edit order": pick the one thing to change. */
  askWhatToChange: (side: 'buy' | 'sell' = 'buy'): Outbound => ({
    kind: 'list', text: '✏️ What do you want to change?', button: 'Choose',
    sections: [{
      title: 'Your order',
      rows: [
        { id: 'bfix:item', title: 'Item name' }, { id: 'bfix:description', title: 'Description' }, { id: 'bfix:category', title: 'Category' },
        { id: 'bfix:price', title: 'Total price' }, { id: 'bfix:address', title: side === 'sell' ? 'Buyer\'s address' : 'Delivery address' },
        { id: 'bfix:date', title: side === 'sell' ? 'Ready by' : 'Expected date' }, { id: 'bfix:photos', title: 'Photos' },
        { id: 'bfix:seller', title: side === 'sell' ? 'Buyer\'s WhatsApp' : 'Seller\'s WhatsApp' },
      ],
    }],
  }),

  // chat version of the new questions (when the form can't be used)
  askBuyDescription: (): Outbound => ({ kind: 'text', text: '📝 Describe it: size, colour, model, condition.\n\nFor example: _White, size 43, brand new in box_' }),
  askCategory: (): Outbound => ({
    kind: 'list', text: '🏷️ What kind of item is it?', button: 'Choose',
    sections: [{ title: 'Category', rows: CATEGORIES.map((c) => ({ id: `cat:${c.id}`, title: c.title })) }],
  }),
  askArriveBy: (): Outbound => ({
    kind: 'buttons',
    text: '📅 When are you expecting it?\n\nTap below, or type a date like _25 Oct_ or _25/10_.',
    buttons: [{ id: 'bdate:1', title: 'Tomorrow' }, { id: 'bdate:3', title: 'In 3 days' }, { id: 'bdate:7', title: 'In a week' }],
  }),
  badArriveBy: (): Outbound => ({
    kind: 'buttons',
    text: '🤔 I couldn\'t read that date, or it has passed. Type it like _25 Oct_ or _25/10_, or tap below.',
    buttons: [{ id: 'bdate:1', title: 'Tomorrow' }, { id: 'bdate:3', title: 'In 3 days' }, { id: 'bdate:7', title: 'In a week' }],
  }),
  /** Someone typed Hoolam's own number as the other person's. */
  hoolamNumberTyped: (who: 'seller' | 'buyer' | 'rider' | 'driver'): Outbound => ({
    kind: 'buttons',
    text: `🤔 That's Hoolam's number. Please type the *${who}'s* WhatsApp number.`,
    buttons: [{ id: 'menu:open', title: 'Main menu' }],
  }),
  askDeliveryAddress: (): Outbound => ({ kind: 'text', text: '📍 What\'s the delivery address?\n\nStreet, area and city. For example: _12 Woji Road, Port Harcourt_' + PIN_HINT }),

  buyDealReady: (code: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed', hours: number, page: string | null = null, sellerLabel?: string | null): Outbound => ({
    kind: 'buttons',
    art: ART.status(1),
    text:
      `✅ ${sellerLabel ? `*${sellerLabel}* · ` : ''}Order *${code}* is sent.\n\n` +
      (alert === 'sent' ? '📨 We\'ve alerted the seller.\n\nSend them this link too, just in case:\n'
        : alert === 'own-number' ? '📨 That\'s your own number, so we didn\'t alert it. Send this link to the seller:\n'
        : alert === 'opted-out' ? '📨 That number said it isn\'t your seller last time, so we didn\'t alert it. If it is, send them this link yourself:\n'
        : 'Send this link to the seller:\n') +
      `${link}\n\n⏳ They have ${hours} hours to accept. We'll tell you the moment they do.` + (page ? `\n\n🔗 Your order: ${page}` : ''),
    buttons: [{ id: `cancel:${code}`, title: 'Cancel order' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerAlertFailed: (): Outbound => ({ kind: 'text', text: '📵 We couldn\'t reach that WhatsApp number. Please send the seller the link above.' }),
  ownBuyDeal: (code: string, link: string): Outbound => withMenu(`🛒 This is your order ${code}. It's waiting for the seller.\n\nSend them this link:\n${link}`),

  buyerSellerAccepted: (code: string, sellerName: string, item: string, amt: { price: Money; fee: Money; pay: Money; feeLabel?: string }, trust?: string, cardUrl?: string | null, art?: Art): Outbound => ({
    kind: 'buttons',
    ...(art ? { art } : {}),
    text: `🎉 *${sellerName}* *accepted your order!*\n` + (trust && !art ? `${trust}\n` : '') + (cardUrl ? `🔗 Their trust card: ${cardUrl}\n` : '') +
      `\n*${item}*\n${buyerSum({ ...amt, feeLabel: amt.feeLabel ?? 'Hoolam fee' })}\n\n` +
      `🛡️ *Your money stays with Hoolam until you have your item and you're happy.* (Order *${code}*)`,
    buttons: [{ id: `pay:${code}`, title: '💳 Pay now' }, { id: `record:${code}`, title: '🛡️ Seller\'s record' }, { id: `cancel:${code}`, title: '✕ Cancel order' }],
  }),
  buyerSellerDeclined: (code: string, sellerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `😕 ${ref(code, sellerName)}: the seller declined. No money moved.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerNotMe: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📵 The number you gave says it isn't the seller, so order *${code}* is closed. No money moved.\n\nCheck the number and start again.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start again' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerSellerExpired: (code: string, sellerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `⏳ ${ref(code, sellerName)}: the seller didn't accept in time, so it's closed. No money moved.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start another' }, { id: 'menu:open', title: 'Main menu' }],
  }),

  // ===== WHAT THE SELLER SEES (seller flow comes later; this is the small part buyers need) =====
  sellerDealCard: (d: { code: string; buyerName: string; item: string; description?: string | null; category?: string | null; address?: string | null; price: Money; sellerGets: Money; txnFee?: Money | null; arriveBy: string | null; hoursLeft: number; invited: boolean; buyerLine?: string; dealId?: string }): Outbound => ({
    kind: 'buttons',
    art: ART.summary({
      side: 'seller', code: d.code, title: 'New order request', item: d.item, dealId: d.dealId ?? null, big: { label: 'You receive', value: m(d.sellerGets) },
      lines: [{ icon: 'user', text: `Buyer: ${d.buyerName}` }, ...(d.address ? [{ icon: 'mapPin', text: d.address }] : []), ...(d.arriveBy ? [{ icon: 'calendar', text: `Expected by ${d.arriveBy}` }] : [])],
      note: d.txnFee && d.txnFee.minor ? `Total ${m(d.price)}, minus a ${m(d.txnFee)} transaction fee` : null,
    }),
    clips: CLIP.sellerFirst,
    text:
      `🛒 *New order request* · *${d.buyerName}*\n` + (d.buyerLine ? `${d.buyerLine}\n` : '') +
      `\n📦 *${d.item}*\n` + (d.description ? `${d.description}\n` : '') +
      (d.address ? `📍 Deliver to: *${d.address}*\n` : '') + (d.arriveBy ? `📅 Expected by *${d.arriveBy}*\n` : '') +
      `\nTotal price  ${m(d.price)} (delivery included)\n` +
      (d.txnFee && d.txnFee.minor ? `Transaction fee  −${m(d.txnFee)}\n` : '') +
      `*You receive  ${m(d.sellerGets)}*\n\n` +
      `💳 ${d.buyerName} pays Hoolam first. You send it once the money is held, and you're paid when they're happy.\n\n` +
      `⏳ Accept within ${d.hoursLeft} hour${d.hoursLeft === 1 ? '' : 's'}. (Order *${d.code}*)`,
    buttons: [
      { id: `saccept:${d.code}`, title: '✅ Accept' },
      { id: `scounter:${d.code}`, title: '✏️ Update price' },
      { id: `sdecline:${d.code}`, title: '✕ Decline' },
    ],
  }),
  askSellerBank: (): Outbound => ({ kind: 'text', text: '🏦 Last step: where should we pay you when the buyer is happy?\n\nSend your account number. We\'ll show you the banks to pick from.\nFor example: _0123456789_' }),
  sellerAcceptedOk: (code: string, buyerName: string, bankName: string, last4: string, sum?: SellerSum): Outbound => withArt(ART.status(2),
    `✅ *${buyerName}* · Order *${code}* accepted.\n\n` +
    (sum ? `${sellerSum(sum)}\n_Minus the rider's fee, if you send one._\n\n` : '') +
    `⏳ We've asked *${buyerName}* to pay. We'll tell you the moment the money is held. *Don't ship before then.*\n\n🏦 You'll be paid into ${bankName} ••••${last4}.`,
  ),

  // ----- Update price -----
  askCounterPrice: (current: Money): Outbound => ({ kind: 'text', text: `✏️ What price works for you? (in naira)\n\nThe buyer offered *${m(current)}*.` }),
  askCounterReason: (price: Money): Outbound => ({ kind: 'text', text: `💬 Why *${m(price)}*? Tell the buyer in a few words (max 150 characters).\n\nFor example: _The price went up at the market_` }),
  badCounterReason: (): Outbound => ({ kind: 'text', text: '💬 Please type a short reason for the buyer (3 to 150 characters).' }),
  counterSent: (code: string, buyerName: string, price: Money, sum?: SellerSum): Outbound => withMenu(
    `✏️ Sent. We've asked *${buyerName}* if *${m(price)}* works.\n\n` +
    (sum ? `If they accept:\n${sellerSum(sum)}\n_Minus the rider's fee, if you send one._\n\n` : '') +
    `We'll tell you when they answer. (Order *${code}*)`),
  counterWaiting: (code: string, buyerName?: string | null): Outbound => withMenu(`⏳ ${ref(code, buyerName)}: we're waiting for ${buyerName ? `*${buyerName}*` : 'the buyer'} to answer your price.`),
  buyerCounterOffer: (code: string, sellerName: string, item: string, oldPrice: Money, newPrice: Money, newTotal: Money, reason = '', fee?: Money, dealId?: string): Outbound => ({
    kind: 'buttons',
    ...(dealId ? { art: ART.summary({ side: 'buyer', code, title: `${sellerName} updated the price`, item, dealId, lines: [{ icon: 'store', text: `Seller: ${sellerName}` }], big: { label: 'You\'d pay', value: m(newTotal) }, note: 'You only pay if you accept.' }) } : {}),
    text: `✏️ *${sellerName}* updated the price\n\n*${item}*\n~${m(oldPrice)}~ → *${m(newPrice)}*\n` +
      (reason ? `💬 Reason: ${reason}\n` : '') +
      `\n${buyerSum({ price: newPrice, fee: fee ?? { minor: 0, currency: newPrice.currency }, feeLabel: 'Hoolam fee', pay: newTotal }, "You'd pay")}\n\n💡 You only pay if you accept. (Order *${code}*)`,
    buttons: [{ id: `cyes:${code}`, title: '✅ Accept new price' }, { id: `cancel:${code}`, title: '✕ Cancel order' }],
  }),
  sellerCounterAccepted: (code: string, buyerName: string, sum: SellerSum): Outbound => withArt(ART.status(2),
    `🎉 *${buyerName}* accepted your new price for order *${code}*.\n\n${sellerSum(sum)}\n_Minus the rider's fee, if you send one._\n\n` +
    `⏳ We've asked them to pay. *Don't ship before we confirm the money is held.*`,
  ),
  askDeclineReason: (code: string): Outbound => ({
    kind: 'buttons',
    text: 'No problem. Which is it?',
    buttons: [{ id: `sno:${code}`, title: 'Not interested' }, { id: `snotme:${code}`, title: '🚫 Wrong number' }],
  }),
  cancelledByHoolam: (code: string, otherName?: string | null): Outbound => withMenu(`${ref(code, otherName)} has been closed by the Hoolam team. No money moved.\n\nQuestions? Tap Main menu → Talk to a rep.`),
  fromTeam: (text: string): Outbound => withMenu(`🙋 From the Hoolam team:\n\n${text}`),
  /** A console message sent as a chat message (no order to attach it to, or the template isn't approved yet). */
  fromSupport: (text: string, code: string | null): Outbound => withMenu(`🙋 *Hoolam support*${code ? `: an update about your order *${code}*` : ''}\n\n${text}\n\nReply here if you have any questions.`),
  accountPaused: (): Outbound => ({
    kind: 'buttons',
    text: '⏸️ Your Hoolam account is paused while our team looks into something. You can still talk to us.',
    buttons: [{ id: 'menu:human', title: '🙋 Talk to a rep' }],
  }),
  sellerDeclinedOk: (code: string, buyerName?: string | null): Outbound => withMenu(`Done. ${ref(code, buyerName)} is declined. No money moved.`),
  sellerNotMeOk: (): Outbound => ({ kind: 'text', text: '🙏 Sorry about that. We\'ve closed it, and that person can\'t send you order alerts again.' }),
  dealHasSeller: (code: string): Outbound => withMenu(`🔒 Order ${code} already has a seller. If you're selling to this buyer, ask them for a new order.`),
  dealStatusNow: (code: string, status: string): Outbound => withArt(ART.status(stepOf(status)), `Order ${code}: ${STATUS_WORDS[status] ?? status}.`),

  // ----- seller creates an order (the mirror of Buy something) -----
  askItem: (): Outbound => ({ kind: 'text', text: '🏷️ What are you selling?\n\nFor example: _Black sneakers, size 42_\n\n💡 The buyer pays Hoolam first. You get paid when they\'re happy.' }),
  askPrice: (): Outbound => ({ kind: 'text', text: '💰 What\'s the *total price*? (in naira)\n\nDelivery included, if any. For example: _15000_' }),
  badPrice: (): Outbound => ({ kind: 'text', text: 'I didn\'t get that price. Please type just the amount, like 15000.' }),
  priceTooHigh: (max: Money): Outbound => ({ kind: 'text', text: `For now, orders can be up to *${m(max)}*. Please type a smaller price, or contact us for bigger orders.` }),
  askBank: (): Outbound => ({ kind: 'text', text: '🏦 Where should we pay you? Send your *account number*. We\'ll show you the banks to pick from.\n\nFor example: _0123456789_\n\nYou only do this once.' }),
  /** Banks an account number can belong to, most likely first, plus "Other". */
  pickBank: (accountNumber: string, banks: { code: string; name: string }[]): Outbound => ({
    kind: 'list',
    text: `🏦 Which bank is *${accountNumber}* with?`,
    button: 'Choose bank',
    sections: [{ title: 'Banks', rows: [...banks.map((b) => ({ id: `bpick:${b.code}`, title: b.name.slice(0, 24) })), { id: 'bpick:other', title: 'Other bank', description: 'Type the bank name' }] }],
  }),
  askBankName: (): Outbound => ({ kind: 'text', text: '🏦 Type the bank name. For example: _Fidelity_' }),
  badBank: (): Outbound => ({ kind: 'text', text: 'I couldn\'t read that. Please send the 10-digit account number (and the bank, if you like), like: 0123456789 Opay' }),
  bankNotFound: (bank: string): Outbound => ({ kind: 'text', text: `I couldn't find a bank called "${bank}". Try the usual name, like GTBank, Access, Zenith, Opay, Moniepoint or Kuda.` }),
  accountNotFound: (): Outbound => ({ kind: 'text', text: 'That account number didn\'t match the bank. Please check it and send it again.' }),
  confirmBank: (accountName: string, bankName: string, accountNumber: string): Outbound => ({
    kind: 'buttons',
    text: `Is this your account?\n\n*${accountName}*\n${bankName} *${accountNumber}*`,
    buttons: [{ id: 'bank:yes', title: 'Yes, that\'s me' }, { id: 'bank:no', title: 'No, change it' }],
  }),
  /** The seller's form (a mirror of the buyer's). */
  sellForm: (flowId: string, mode: 'draft' | 'published', first = false): Outbound => ({
    kind: 'form',
    header: '🏷️ Sell safely',
    text: 'Tell us what you\'re selling. It takes a minute.\n\n💡 The buyer pays Hoolam first, and we pay you when they\'re happy.',
    footer: 'Prefer typing? Just send the item name.',
    cta: 'Start my order',
    flowId, flowToken: 'sell:v2', screen: 'ITEM', mode, data: { first },
  }),
  sellEditForm: (flowId: string, mode: 'draft' | 'published', data: Record<string, string>): Outbound => ({
    kind: 'form',
    header: '✏️ Edit your order',
    text: 'Your answers are filled in. Change what you need, then tap *Review my order*.',
    cta: 'Edit order',
    flowId, flowToken: 'selledit:v1', screen: 'ITEM', mode, data,
  }),
  askSellAddress: (): Outbound => ({
    kind: 'buttons',
    text: '📍 Where is it going? Send the *buyer\'s delivery address*, if you know it.\n\nStreet, area and city. Or tap below and the buyer adds it when they accept.' + PIN_HINT,
    buttons: [{ id: 'sell:noaddress', title: 'Buyer will add it' }],
  }),
  askReadyBy: (): Outbound => ({
    kind: 'buttons',
    text: '📅 When will it be *ready to send*?\n\nTap below, or type a date like _25 Oct_ or _25/10_.',
    buttons: [{ id: 'bdate:0', title: 'Today' }, { id: 'bdate:1', title: 'Tomorrow' }, { id: 'bdate:3', title: 'In 3 days' }],
  }),
  badReadyBy: (): Outbound => ({
    kind: 'buttons',
    text: '🤔 I couldn\'t read that date, or it has passed. Type it like _25 Oct_ or _25/10_, or tap below.',
    buttons: [{ id: 'bdate:0', title: 'Today' }, { id: 'bdate:1', title: 'Tomorrow' }, { id: 'bdate:3', title: 'In 3 days' }],
  }),
  askSellPhotos: (): Outbound => ({
    kind: 'buttons',
    text: '📷 Send up to 3 *photos* of the item.\n\nBuyers trust real photos, and they\'re your proof of what you sold.',
    buttons: [{ id: 'sell:nophotos', title: 'No photos' }],
  }),
  askBuyerPhone: (): Outbound => ({ kind: 'text', text: `📨 What's the *buyer's WhatsApp number*?\n\nWe'll send them your order. For example: _${exampleNumber()}_` }),
  badBuyerPhone: (): Outbound => ({ kind: 'text', text: `🤔 I couldn't read that number. Type the buyer's WhatsApp number like _${exampleNumber()}_.` }),
  /** Check before sending (chat version; the form shows the same). */
  sellSummary: (d: { item: string; description?: string | null; category?: string | null; address?: string | null; photos: number; readyBy: string | null; buyerPhone: string; sum: SellerSum; bank?: string | null }): Outbound => ({
    kind: 'buttons',
    art: ART.summary({
      side: 'seller', title: 'Check your order', item: d.item, big: { label: 'You receive', value: m({ minor: d.sum.gets.minor - (d.sum.delivery?.minor ?? 0), currency: d.sum.gets.currency }) },
      lines: [{ icon: 'user', text: `Buyer: ${localPhone(d.buyerPhone)}` }, ...(d.address ? [{ icon: 'mapPin', text: d.address }] : []), ...(d.readyBy ? [{ icon: 'calendar', text: `Ready by ${d.readyBy}` }] : [])],
      note: 'Nothing is paid yet. The buyer accepts, then pays Hoolam.',
    }),
    text:
      `🏷️ *Check your order*\n\n*${d.item}*\n` +
      (d.description ? `${d.description}\n` : '') +
      (d.category ? `🏷️ ${d.category}\n` : '') +
      (d.photos ? `📷 ${d.photos} photo${d.photos > 1 ? 's' : ''}\n` : '') +
      (d.address ? `📍 Deliver to: *${d.address}*\n` : '📍 The buyer adds the delivery address\n') +
      (d.readyBy ? `📅 Ready by *${d.readyBy}*\n` : '') +
      `📨 Buyer's WhatsApp: *${localPhone(d.buyerPhone)}*\n\n` +
      `${sellerSum(d.sum)}\n_Minus the rider's fee, if you send one._\n` +
      (d.bank ? `🏦 Paid into ${d.bank}\n` : '') +
      `\n💡 Nothing is paid yet. The buyer accepts, then pays Hoolam.\n\nIs everything right?`,
    buttons: [{ id: 'sell:send', title: '📨 Send to buyer' }, { id: 'sell:edit', title: '✏️ Edit order' }, { id: 'sell:restart', title: '🔄 Start again' }],
  }),
  /** The order to check, in the form. */
  sellReview: (flowId: string, mode: 'draft' | 'published', flowToken: string, item: string, sum: SellerSum): Outbound => ({
    kind: 'form',
    header: '🏷️ Check your order',
    text: `*${item}*\n💰 Total price *${m(sum.price)}*\n💸 You receive *${m(sum.gets)}*\n\nLook over the photos and details, then send it to the buyer. You can still change anything.`,
    cta: 'Review order',
    flowId, flowToken, screen: 'ORDER', mode, live: true,
  }),
  /** The order is with the buyer. */
  sellDealReady: (code: string, buyerLabel: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed', hours: number, page: string | null = null): Outbound => ({
    kind: 'buttons',
    art: ART.status(1),
    text:
      `✅ *${buyerLabel}* · Order *${code}* is sent.\n\n` +
      (alert === 'sent' ? '📨 We\'ve sent the buyer your order. They accept it, then pay Hoolam.\n\nSend them this link too, just in case:\n'
        : alert === 'opted-out' ? '📨 That number said it isn\'t your buyer last time, so we didn\'t alert it. If it is, send them this link yourself:\n'
        : alert === 'failed' ? '📵 We couldn\'t reach that WhatsApp number. Send this link to your buyer:\n'
        : 'Send this link to your buyer:\n') +
      `${link}\n\n⏳ They have *${hours} hours* to accept. We'll tell you the moment they do. *Don't send anything before the money is held.*` +
      (page ? `\n\n🔗 Your order: ${page}` : ''),
    buttons: [{ id: `scancel:${code}`, title: 'Cancel order' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  ownSellDeal: (code: string, link: string): Outbound => withMenu(`🏷️ This is your own order *${code}*. It's waiting for the buyer to accept.\n\nSend them this link:\n${link}`),
  sellerBuyerNotMe: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📵 The number you gave says it isn't your buyer, so order *${code}* is closed. No money moved.\n\nCheck the number and start again.`,
    buttons: [{ id: 'menu:sell', title: '🏷️ Start again' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  /** A buyer looks at a seller's order: photos first, then this. Accept, then pay. */
  buyerOrderCard: (d: { code: string; sellerName: string; trust?: string; cardUrl?: string | null; item: string; description?: string | null; category?: string | null; address?: string | null; readyBy?: string | null; sum: BuyerSum; hoursLeft: number; dealId?: string }): Outbound => ({
    kind: 'buttons',
    art: ART.summary({
      side: 'buyer', code: d.code, title: `${d.sellerName} sent you an order`, item: d.item, dealId: d.dealId ?? null, big: { label: 'You pay', value: m(d.sum.pay) },
      lines: [{ icon: 'store', text: `Seller: ${d.sellerName}` }, ...(d.address ? [{ icon: 'mapPin', text: d.address }] : []), ...(d.readyBy ? [{ icon: 'calendar', text: `Ready by ${d.readyBy}` }] : [])],
      note: 'Your money stays with Hoolam until you\'re happy.',
    }),
    clips: CLIP.firstOrder,
    text:
      `🛍️ *${d.sellerName}* · New order for you\n` + (d.trust ? `${d.trust}\n` : '') + (d.cardUrl ? `🔗 Their trust card: ${d.cardUrl}\n` : '') +
      `\n📦 *${d.item}*\n` + (d.description ? `${d.description}\n` : '') +
      (d.address ? `📍 Deliver to: *${d.address}*\n` : '📍 You add the delivery address when you accept\n') +
      (d.readyBy ? `📅 Ready by *${d.readyBy}*\n` : '') +
      `\n${buyerSum(d.sum)}\n\n` +
      '🛡️ *Your money stays with Hoolam, not the seller,* until you\'re happy. If it never comes, you get it back.\n\n' +
      `⏳ Accept within *${d.hoursLeft} hour${d.hoursLeft === 1 ? '' : 's'}*. (Order *${d.code}*)`,
    buttons: [{ id: `baccept:${d.code}`, title: '✅ Accept order' }, { id: `bdecline:${d.code}`, title: '✕ Decline' }, { id: `record:${d.code}`, title: '🛡️ Seller\'s record' }],
  }),
  /** Accepting: confirm, change or add where it goes. */
  askBuyerAddress: (code: string, current: string | null): Outbound => current
    ? { kind: 'buttons', text: `📍 Deliver to:\n*${current}*\n\nIs that right? Tap below, or type another address.` + PIN_HINT, buttons: [{ id: `baddr:${code}`, title: 'Yes, deliver here' }] }
    : { kind: 'text', text: '📍 Where should it be delivered?\n\nStreet, area and city. For example: _12 Woji Road, Port Harcourt_' + PIN_HINT },
  askBuyerDeclineReason: (code: string): Outbound => ({
    kind: 'buttons',
    text: 'No problem. Which is it?',
    buttons: [{ id: `bno:${code}`, title: 'Not interested' }, { id: `bnotme:${code}`, title: '🚫 Wrong number' }],
  }),
  buyerDeclinedOk: (code: string, sellerName: string): Outbound => withMenu(`Done. *${sellerName}* · Order *${code}* is declined. No money moved.`),
  /** To the seller: the buyer accepted their order. */
  sellerBuyerAccepted: (code: string, buyerName: string, sum: SellerSum, buyerLine?: string): Outbound => withArt(ART.status(2),
    `✅ *${buyerName}* · Order *${code}* accepted.\n` + (buyerLine ? `${buyerLine}\n` : '') + `\n${sellerSum(sum)}\n_Minus the rider's fee, if you send one._\n\n` +
    `⏳ We've asked them to pay. *Don't ship before we confirm the money is held.*`,
  ),
  sellerBuyerDeclined: (code: string, buyerName: string): Outbound => ({
    kind: 'buttons',
    text: `😕 *${buyerName}* · Order *${code}* declined. No money moved.`,
    buttons: [{ id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellerBuyerExpired: (code: string, buyerLabel?: string | null): Outbound => ({
    kind: 'buttons',
    text: `⏳ ${ref(code, buyerLabel)}: the buyer didn't accept in time, so it's closed. No money moved.`,
    buttons: [{ id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellerCancelledOk: (code: string, buyerLabel: string): Outbound => withMenu(`Done. *${buyerLabel}* · Order *${code}* is cancelled. No money moved.`),
  buyerSellerCancelled: (code: string, sellerName: string): Outbound => withMenu(`😕 *${sellerName}* cancelled order *${code}*. No money moved.`),
  // the old seller route (orders created before the redesign): kept until they've all finished
  dealCreated: (code: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed' = 'none'): Outbound => withMenu(
    `✅ Order *${code}* is ready.\n\n` +
    (alert === 'sent' ? '📨 We\'ve sent the buyer the order.\n\nSend them this link too, just in case:\n' : 'Send this link to your buyer:\n') +
    `${link}\n\n⏳ We'll tell you the moment they pay. Don't ship before then.`,
  ),

  // ----- buyer -----
  dealNotFound: (): Outbound => ({ kind: 'text', text: 'I couldn\'t find that order. Please check the code with the seller.' }),
  ownDeal: (): Outbound => ({ kind: 'text', text: 'This is your own order. Send the link to your buyer.' }),
  dealTaken: (): Outbound => ({ kind: 'text', text: 'Someone else is already paying for this order. Ask the seller for a new link.' }),
  dealClosed: (code: string): Outbound => ({ kind: 'text', text: `Order ${code} is already closed.` }),
  dealForBuyer: (code: string, item: string, sellerName: string, price: Money, fee: Money, total: Money, trust?: string, feeLabel = 'Transaction fee', cardUrl?: string | null, art?: Art): Outbound => ({
    kind: 'buttons',
    ...(art ? { art } : {}),
    text:
      `🛒 Order *${code}* from *${sellerName}*\n` + (trust && !art ? `${trust}\n` : '') + (cardUrl ? `🔗 Their trust card: ${cardUrl}\n` : '') + `\n*${item}*\n` +
      `${buyerSum({ price, fee, feeLabel, pay: total })}\n\n` +
      '🛡️ *Your money stays with Hoolam, not the seller.* They only get paid after you receive your item and say you\'re happy. If it never comes, you get your money back.',
    buttons: [{ id: `pay:${code}`, title: '💳 Pay now' }, { id: `record:${code}`, title: '🛡️ Seller\'s record' }, { id: `cancel:${code}`, title: '✕ Cancel order' }],
  }),
  payInstructions: (total: Money, accountNumber: string, bankName: string, accountName: string, expiresAt: Date | null, code: string, hint: 'fake' | 'sandbox' | null = null, intro?: string): Outbound => ({
    kind: 'buttons',
    art: ART.payment({ amount: m(total), accountNumber, bankName, accountName, validUntil: expiresAt ? expiryText(expiresAt) : null, code }),
    clips: CLIP.firstPay,
    text:
      (intro ? `${intro}\n\n` : '') +
      `💳 Transfer exactly *${m(total)}* to:\n\n*${accountNumber}*\n${bankName}\n${accountName}\n\n` +
      '🛡️ This account is for this order only. Your money goes to *Hoolam, not the seller.*\n\n' +
      (expiresAt ? `⏳ It works until *${expiryText(expiresAt)}* (Nigeria time). After that, tap *New account number*.\n\n` : '') +
      'Pay from any bank app, Opay, Moniepoint or PalmPay. We\'ll confirm the moment it lands. (Order *' + code + '*)' +
      (hint === 'fake' ? '\n\nTEST MODE: no real money. Reply "paid" to pretend you made the transfer.' : '') +
      (hint === 'sandbox' ? '\n\nTEST MODE: no real money. Pay this account with Monnify\'s test bank: websim.sdk.monnify.com' : ''),
    buttons: [{ id: `newacct:${code}`, title: 'New account number' }],
  }),
  paymentPartial: (paid: Money, due: Money): Outbound => ({
    kind: 'text',
    text: `We received ${m(paid)}, but the total is ${m(due)}. Your money is safe with us. A person from Hoolam will contact you to sort it out.`,
  }),
  // the receipt picture (sent just before) is this moment's picture; the card rides on the template, when no receipt can go
  buyerFunded: (total: Money, code: string, sellerName = 'the seller', sum?: BuyerSum): Outbound => withMenu(
    `✅ ${ref(code, sellerName)}: your *${m(total)}* is held safely by Hoolam.\n\n` +
    (sum && sum.fee.minor > 0 ? `${buyerSum(sum, 'You paid')}\n\n` : '') +
    `We've told *${sellerName}* to send your item. Nothing moves until you say you're happy.`,
  ),

  // ----- seller ships -----
  sellerFunded: (code: string, yours: Money, buyerName = 'The buyer', sum?: SellerSum): Outbound => ({
    kind: 'buttons',
    clips: CLIP.sellerHeld,
    text: `💰 Good news: *${buyerName}* has paid for order *${code}*. Your *${m(yours)}* is held safely by Hoolam.\n\n` +
      (sum ? `${sellerSum(sum)}\n\n` : '') + 'Ship the item now, then tap below.',
    buttons: [{ id: `shipped:${code}`, title: 'I\'ve sent it' }],
  }),
  sellerShippedOk: (code: string, buyerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `📦 Thanks. We've told ${buyerName ? `*${buyerName}*` : 'the buyer'} that order *${code}* is on the way.\n\nWant to add proof? Send a photo of the package or receipt, or type a tracking number. It protects you if there's a problem.`,
    buttons: [{ id: `noproof:${code}`, title: 'No thanks' }],
  }),
  shippingProofSaved: (code: string): Outbound => withMenu(`✅ Proof saved for order ${code} and shown to the buyer.`),
  buyerShippingNote: (code: string, note: string): Outbound => ({ kind: 'text', text: `📦 From the seller, about order ${code}:\n\n${note}` }),
  buyerShipped: (code: string, sellerName?: string | null): Outbound => ({
    kind: 'buttons',
    art: ART.status(4),
    text: `📦 ${ref(code, sellerName)}: your item is on the way.\n\nWhen it arrives, open it and check it. Then tell us:`,
    buttons: [{ id: `happy:${code}`, title: 'I\'m happy' }, { id: `problem:${code}`, title: 'Problem' }],
  }),
  buyerNudge: (code: string, sellerName?: string | null): Outbound => ({
    kind: 'buttons',
    art: ART.status(4),
    text: `📦 ${ref(code, sellerName)}: has your item arrived? *Your money is still safe with us.*`,
    buttons: [{ id: `happy:${code}`, title: 'I\'m happy' }, { id: `problem:${code}`, title: 'Problem' }],
  }),

  // ===== DISPATCH (buyer orders) =====
  /** The buyer paid: the seller dispatches (or says they can't fulfil it). */
  sellerFundedDispatch: (code: string, yours: Money, page: string | null = null, buyerName = 'The buyer', sum?: SellerSum, deliver?: { address: string; map: string | null } | null): Outbound => ({
    kind: 'buttons',
    clips: CLIP.sellerHeld,
    text: `💰 *${buyerName}* has paid for order *${code}*. Your *${m(yours)}* is held safely by Hoolam. It's confirmed by Hoolam, not a bank alert.\n\n` +
      (sum ? `${sellerSum(sum)}\n_Minus the rider's fee, if you send one._\n\n` : '') +
      (deliver ? `📍 Deliver to: ${deliver.address}${deliver.map ? `\n🗺️ Map: ${deliver.map}` : ''}\n\n` : '') +
      `Dispatch it now: tell us if it's a pickup, a rider or a waybill.` + (page ? `\n\n🔗 Order details: ${page}` : ''),
    buttons: [{ id: `dispatch:${code}`, title: '🚚 Dispatch now' }, { id: `srefund:${code}`, title: '❌ Can\'t fulfil' }],
  }),
  askDispatchMethod: (code: string, buyerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `🚚 ${ref(code, buyerName)}: how is it getting to ${buyerName ? `*${buyerName}*` : 'the buyer'}?`,
    buttons: [{ id: 'dm:pickup', title: '📍 Pickup' }, { id: 'dm:rider', title: '🛵 Dispatch rider' }, { id: 'dm:waybill', title: '🚌 Waybill' }],
  }),
  askPickupAddress: (): Outbound => ({ kind: 'text', text: '📍 Where will the buyer pick it up?\n\nFor example: _Shop 4, Rumuola Plaza, Port Harcourt_' }),
  askRiderName: (): Outbound => ({ kind: 'text', text: '🛵 What\'s the rider\'s name?' }),
  askCourierPhone: (role: 'rider' | 'driver'): Outbound => ({ kind: 'text', text: `📞 What's the ${role}'s phone number?\n\nWe show it to the buyer so they can reach the ${role}.` }),
  askCourierFee: (role: 'rider' | 'driver'): Outbound => ({ kind: 'text', text: `💸 How much is the ${role}'s delivery fee? (in naira)\n\nWe pay it to the ${role} from the order money once the handover code is right. It comes out of what you receive.\n\nFor example: _2000_` }),
  askCourierLocation: (role: 'rider' | 'driver', buyerAddress: string | null): Outbound => buyerAddress
    ? { kind: 'buttons', text: `📍 Where is the ${role} delivering to?\n\nThe buyer gave: _${buyerAddress.slice(0, 200)}_\n\nTap below to use it, or type another place${role === 'driver' ? ' (e.g. the park)' : ''}.` + PIN_HINT, buttons: [{ id: 'dloc:buyer', title: 'Use this address' }] }
    : { kind: 'text', text: `📍 Where is the ${role} delivering to?` + PIN_HINT },
  askCourierAccount: (role: 'rider' | 'driver'): Outbound => ({
    kind: 'text',
    text: `🏦 The ${role}'s account number, for their delivery fee. We'll show you the banks to pick from.\n\nFor example: _0123456789_\n\n⚠️ Please check it carefully. We pay exactly the account you give, and Hoolam can't recover money sent to a wrong account.`,
  }),
  confirmCourierAccount: (role: 'rider' | 'driver', accountName: string, bankName: string, accountNumber: string): Outbound => ({
    kind: 'buttons',
    text: `Is this the ${role}'s account?\n\n*${accountName}*\n${bankName} ${accountNumber}\n\n⚠️ The delivery fee goes to this account. Wrong details are the seller's responsibility.`,
    buttons: [{ id: 'dacct:yes', title: 'Yes, that\'s right' }, { id: 'dacct:no', title: 'No, change it' }],
  }),
  sellerDispatched: (d: { code: string; method: 'PICKUP' | 'RIDER' | 'WAYBILL'; pickupAddress: string | null; courierName: string | null; courierPhone: string | null; location: string | null; fee: Money | null; page?: string | null; buyerName?: string; courierAlerted?: boolean; sum?: SellerSum }): Outbound => {
    const role = d.method === 'RIDER' ? 'rider' : 'driver';
    const who = d.method === 'RIDER' && d.courierName ? `*${d.courierName}*` : `your ${role}`;
    // inside a bold sentence the names are already bold (WhatsApp can't nest *…*)
    const Who = d.method === 'RIDER' && d.courierName ? d.courierName : `Your ${role}`;
    return {
      kind: 'buttons',
      art: ART.status(4), clips: CLIP.handoverSeller,
      text: (d.method === 'PICKUP'
        ? `✅ ${ref(d.code, d.buyerName ?? 'Buyer')} is ready for pickup at:\n*${d.pickupAddress ?? ''}*\n\n🔑 *When the buyer comes, ask them for their 4-digit handover code before you give them the item.* Then tap *Enter code*.`
        : `✅ ${ref(d.code, d.buyerName ?? 'Buyer')} is dispatched${d.method === 'RIDER' && d.courierName ? ` with *${d.courierName}*` : ' by waybill'}.\n` +
          (d.fee ? `💸 ${d.method === 'RIDER' ? 'Rider' : 'Driver'}'s fee: ${m(d.fee)}, paid by Hoolam once the code is right.\n` : '') +
          (d.sum ? `\n${sellerSum({ ...d.sum, delivery: d.fee, role })}\n` : '') +
          `\n🔑 *${Who} must get the 4-digit handover code from ${d.buyerName ?? 'the buyer'}* before handing over the item. It proves it's the right person.\n\n` +
          (d.courierAlerted
            ? `📲 We've sent ${who} a WhatsApp message, so they can enter the code themselves${d.fee ? ' and get their fee straight away' : ''}. Or they can share it with you, and you tap *Enter code*.`
            : `When ${who} shares the code with you, tap *Enter code*.`))
        + (d.page ? `\n\n🔗 Order details: ${d.page}` : ''),
      buttons: [{ id: `hcode:${d.code}`, title: '🔑 Enter code' }, { id: 'menu:open', title: 'Main menu' }],
    };
  },
  buyerDispatched: (d: { code: string; method: 'PICKUP' | 'RIDER' | 'WAYBILL'; pickupAddress: string | null; courierName: string | null; courierPhone: string | null; location: string | null; handover: string; page?: string | null; sellerName?: string }): Outbound => ({
    kind: 'buttons',
    art: ART.handover(d.handover, d.code, d.method === 'PICKUP' ? 'seller' : d.method === 'RIDER' ? 'rider' : 'driver'), clips: CLIP.handoverBuyer,
    text:
      (d.method === 'PICKUP'
        ? `📍 ${ref(d.code, d.sellerName)} is ready for pickup at:\n*${d.pickupAddress ?? ''}*\n`
        : d.method === 'RIDER'
          ? `🛵 ${ref(d.code, d.sellerName)} is on its way with a rider.\n${d.courierName ? `Rider: *${d.courierName}*\n` : ''}${d.courierPhone ? `📞 ${localPhone(d.courierPhone)}\n` : ''}${d.location ? `📍 To: ${d.location}\n` : ''}`
          : `🚌 ${ref(d.code, d.sellerName)} is on its way by waybill.\n${d.courierPhone ? `Driver: 📞 ${localPhone(d.courierPhone)}\n` : ''}${d.location ? `📍 To: ${d.location}\n` : ''}`) +
      `\n🔑 Your handover code: *${d.handover}*\n\n` +
      (d.method === 'PICKUP'
        ? '*Give it to the seller only when the item is in your hands.*'
        : `*Give your code to the ${d.method === 'RIDER' ? 'rider' : 'driver'} when you have the item.* Not before. It confirms you got it.`) +
      ` Your money stays with Hoolam until you're happy.` +
      (d.page ? `\n\n🔗 Order details: ${d.page}` : ''),
    buttons: [{ id: `hcodeshow:${d.code}`, title: '🔑 Show my code' }, { id: `problem:${d.code}`, title: '🚩 Problem' }],
  }),
  handoverCode: (code: string, handover: string, method: string | null): Outbound => ({
    kind: 'text',
    art: ART.handover(handover, code, method === 'PICKUP' ? 'seller' : method === 'WAYBILL' ? 'driver' : 'rider'),
    text: `🔑 Handover code for order ${code}: *${handover}*\n\nGive it to the ${method === 'PICKUP' ? 'seller' : method === 'WAYBILL' ? 'driver' : 'rider'} when you have the item. Not before.`,
  }),
  /** To the rider or driver, at dispatch (their number is on WhatsApp). The template version has no code in it. */
  courierJob: (d: { code: string; role: 'rider' | 'driver'; sellerName: string; buyerName: string; buyerPhone: string; address: string | null; fee: Money | null; account: { name: string; bank: string; number: string } | null; map?: string | null }): Outbound => ({
    kind: 'buttons',
    art: ART.picture('rider'),
    text:
      `${d.role === 'rider' ? '🛵' : '🚌'} *Delivery on Hoolam* from *${d.sellerName}*\n\n` +
      `👤 Receiver: *${d.buyerName}*\n📞 ${localPhone(d.buyerPhone)}\n` + (d.address ? `📍 Deliver to: ${d.address}\n` : '') + (d.map ? `🗺️ Map: ${d.map}\n` : '') +
      (d.fee && d.fee.minor > 0
        ? `\n💸 Your delivery fee: *${m(d.fee)}*\n🏦 Paid to: *${d.account?.name ?? ''}*, ${d.account?.bank ?? ''} ${d.account?.number ?? ''}\n`
        : '') +
      `\n🔑 *Ask ${d.buyerName} for their 4-digit handover code when you hand over the item.* It proves you have the right person. Then tap *Enter code*` +
      (d.fee && d.fee.minor > 0 ? ' and we pay your fee straight away.' : '.') +
      `\n\n_Not expecting this? You can ignore it._ (Order ${d.code})`,
    buttons: [{ id: `hcode:${d.code}`, title: '🔑 Enter code' }],
  }),
  /** The rider/driver entered the right code. */
  courierConfirmed: (code: string, buyerName: string, fee: Money | null, account: { name: string; bank: string; number: string } | null): Outbound => withMenu(
    `✅ *Delivery confirmed.* *${buyerName}* has the item. (Order ${code})` +
    (fee && fee.minor > 0 && account ? `\n\n💸 We're sending your *${m(fee)}* to *${account.name}*, ${account.bank} ${account.number} now.` : '') +
    '\n\nThank you for delivering safely with Hoolam.',
  ),
  courierFeeSent: (buyerName: string, fee: Money, account: { name: string; bank: string; number: string }): Outbound => ({
    ...withMenu(`💸 *Your delivery fee is sent:* ${m(fee)} to *${account.name}*, ${account.bank} ${account.number}, for *${buyerName}*'s order.`),
    sticker: 'paid',
  }),
  /** The rider/driver tapped Enter code, but the handover is already done (or the order moved on). */
  courierNothingToDo: (code: string, done: boolean, buyerName?: string | null): Outbound => withMenu(done
    ? `✅ ${ref(code, buyerName)}: this delivery is already confirmed.`
    : `${ref(code, buyerName)}: this order isn't waiting for a handover code right now.`),
  feeTooHigh: (max: Money): Outbound => ({ kind: 'text', text: `The delivery fee has to be less than what you receive (${m(max)}). Please type a smaller amount.` }),
  askHandoverCode: (code: string, buyerName?: string | null): Outbound => ({ kind: 'text', text: `🔑 ${ref(code, buyerName)}: type the 4-digit handover code ${buyerName ? `*${buyerName}*` : 'the receiver'} gave you.` }),
  handoverWrong: (code: string, left: number, buyerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `❌ ${ref(code, buyerName)}: that code doesn't match. *${left} ${left === 1 ? 'try' : 'tries'} left.*\n\nCheck with the receiver and try again. Don't hand over the item until it's right.`,
    buttons: [{ id: `hcode:${code}`, title: '🔑 Try again' }],
  }),
  handoverLocked: (code: string, buyerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `🔒 ${ref(code, buyerName)}: too many wrong codes, so we've paused it. A rep will help you finish the handover.`,
    buttons: [{ id: 'menu:human', title: '🙋 Talk to a rep' }],
  }),
  sellerHandedOver: (code: string, courierFee: Money | null, courierName: string | null, wait: string, more: { buyerName?: string; byCourier?: boolean; role?: 'rider' | 'driver'; sum?: SellerSum } = {}): Outbound => {
    const courier = courierName ? `*${courierName}*` : `your ${more.role ?? 'rider'}`;
    const buyer = more.buyerName ? `*${more.buyerName}*` : 'the buyer';
    return withArt(ART.status(5),
      `✅ ${ref(code, more.buyerName)}: ` + (more.byCourier ? `${courier} entered the right code.` : 'code correct.') + ` It's with ${buyer}.\n` +
      (courierFee ? `🛵 We're paying ${courier} ${m(courierFee)} now.\n` : '') +
      (more.sum ? `\n${sellerSum({ ...more.sum, delivery: courierFee, role: more.role })}\n` : '') +
      `\n💸 You'll be paid when ${buyer} taps "I'm happy", or automatically after ${wait} if they don't report a problem.`,
    );
  },
  buyerHandedOver: (code: string, wait: string, sellerName?: string | null): Outbound => ({
    kind: 'buttons',
    art: ART.status(5),
    text: `📦 ${ref(code, sellerName)}: it's with you.\n\n*Check it now.* Happy? Tap *I'm happy*. Something wrong? Tap *Problem* within *${wait}*, and your money stays frozen.\n\nNo reply in ${wait} = ${sellerName ? `*${sellerName}*` : 'the seller'} is paid.`,
    buttons: [{ id: `happy:${code}`, title: '✅ I\'m happy' }, { id: `problem:${code}`, title: '🚩 Problem' }],
  }),
  courierPaid: (code: string, amount: Money, name: string, bank: string, buyerName?: string | null): Outbound => ({ kind: 'text', text: `🛵 Delivery fee sent: ${m(amount)} to *${name}* (${bank}) for ${buyerName ? `*${buyerName}* · ` : ''}order *${code}*.` }),
  sellerDispatchReminder: (code: string, item: string, fromBuyer: boolean, buyerName = 'Buyer'): Outbound => ({
    kind: 'buttons',
    text: `⏰ ${ref(code, buyerName)} (${item.slice(0, 60)}) is paid and *waiting to be dispatched*.` + (fromBuyer ? `\n\n*${buyerName}* sent you a reminder.` : ''),
    buttons: [{ id: `dispatch:${code}`, title: '🚚 Dispatch now' }, { id: `srefund:${code}`, title: '❌ Can\'t fulfil' }],
  }),
  buyerOverdue: (code: string, item: string, readyBy = false, sellerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `⏰ ${ref(code, sellerName)} (${item.slice(0, 60)}) hasn't been dispatched yet, and ${readyBy ? 'the date the seller said it would be ready' : 'the date you expected it'} has passed.\n\nYour money is still held safely by Hoolam. What would you like to do?`,
    buttons: [{ id: `remind:${code}`, title: '🔔 Send reminder' }, { id: `refundme:${code}`, title: '💸 Refund me' }, { id: 'menu:open', title: 'Wait a bit' }],
  }),
  reminderSent: (code: string, sellerName?: string | null): Outbound => withMenu(`🔔 ${ref(code, sellerName)}: reminder sent to ${sellerName ? `*${sellerName}*` : 'the seller'}.`),
  confirmSellerRefund: (code: string, buyerName?: string | null): Outbound => ({
    kind: 'buttons',
    text: `❌ ${ref(code, buyerName)}: can't fulfil it?\n\n${buyerName ? `*${buyerName}*` : 'The buyer'} gets all their money back, Hoolam's fee included. *This can't be undone.*`,
    buttons: [{ id: `srefundok:${code}`, title: 'Yes, refund buyer' }, { id: 'menu:open', title: 'Keep the order' }],
  }),
  askRefundAccountNow: (code: string, by: 'seller' | 'buyer', sellerName?: string | null): Outbound => ({
    kind: 'text',
    text: (by === 'seller' ? `😕 ${ref(code, sellerName)}: the seller can't fulfil it. *You'll get all your money back.*` : `💸 ${ref(code, sellerName)}: okay, we'll refund it.`) +
      '\n\nWhere should we send it? Send your account number, like _0123456789_. We\'ll show you the banks to pick from.',
  }),
  sellerRefundStarted: (code: string, now: boolean, buyerName?: string | null): Outbound => withMenu(now
    ? `Done. ${ref(code, buyerName)}: the buyer is being refunded.`
    : `Done. ${ref(code, buyerName)}: we've asked the buyer where to send their refund. It goes out as soon as they reply.`),
  sellerBuyerTookRefund: (code: string, buyerName?: string | null): Outbound => ({ kind: 'text', text: `💸 ${ref(code, buyerName)} wasn't dispatched by the expected date, so the buyer asked for a refund. The order is closed.` }),
  buyerRefundStarted: (code: string, by: 'seller' | 'buyer', sellerName?: string | null): Outbound => withMenu(
    (by === 'seller' ? `😕 ${ref(code, sellerName)}: the seller can't fulfil it, so we're refunding you.` : `💸 ${ref(code, sellerName)}: we're refunding you.`) + '\n\nYou\'ll get a message the moment it lands.'),

  autoReleased: (code: string, sellerName?: string | null): Outbound => withMenu(`✅ ${ref(code, sellerName)}: we didn't hear of any problem, so we've paid ${sellerName ? `*${sellerName}*` : 'the seller'}. Thanks for buying safely with Hoolam.`),

  // ----- release -----
  buyerReleased: (code: string, sellerName = 'the seller', art?: Art): Outbound => ({
    kind: 'buttons',
    ...(art ? { art } : {}),
    text: `✅ ${ref(code, sellerName)}: done. We're paying *${sellerName}* now. Thanks for trading safely.\n\nTo help other buyers like you, how was *${sellerName}*?`,
    buttons: [{ id: `rateup:${code}`, title: '👍 Great' }, { id: `ratedown:${code}`, title: '👎 Not great' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellerPaid: (code: string, amount: Money, bankName: string, buyerName?: string | null, sum?: SellerSum): Outbound => ({
    kind: 'buttons',
    clips: CLIP.firstPayout,
    text: `💸 *You've been paid* for ${buyerName ? `*${buyerName}* · ` : ''}order *${code}*.\n\n` +
      (sum ? `${sellerSum(sum, 'Paid to you')}\n\n` : `*${m(amount)}*\n\n`) +
      `It's on its way to your ${bankName} account. Want more buyers to trust you? Share your trust card.`,
    buttons: [{ id: 'card:share', title: '🔗 Share my card' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellerPayoutDelayed: (code: string, buyerName?: string | null): Outbound => ({
    kind: 'text', text: `⏳ ${ref(code, buyerName)}: the buyer is happy. Your payout is on its way; it usually lands within 30 minutes. We'll message you when it does.`,
  }),

  // ----- problems -----
  askProblem: (code: string, sellerName?: string | null, amount?: Money): Outbound => ({
    kind: 'text',
    ...(amount ? { art: ART.frozen('buyer', m(amount), code, live.problemReplyHours()) } : {}),
    text: `🚩 ${ref(code, sellerName)}: sorry about this. *Your money is frozen and safe.*\n\nTell us what's wrong: type it, or send photos of the item.`,
  }),
  askRefundBank: (): Outbound => ({
    kind: 'text',
    text: 'Just in case we refund you, which account should it go to? Send the account number, like _0123456789_. We\'ll show you the banks to pick from.',
  }),
  problemLogged: (code: string, caseRef: string, otherName?: string | null): Outbound => withMenu(`✅ ${ref(code, otherName)}: got it. Case *${caseRef}* is open. A real person will reply within *${problemText()}*. The money stays frozen until it's sorted.`),
  sellerProblem: (code: string, buyerName?: string | null, amount?: Money): Outbound => ({
    kind: 'text',
    ...(amount ? { art: ART.frozen('seller', m(amount), code, live.problemReplyHours()) } : {}),
    text: `🚩 ${ref(code, buyerName)}: ${buyerName ? `*${buyerName}*` : 'the buyer'} reported a problem. Your money is *paused, not taken.* A rep will hear your side within ${problemText()}. Send any proof you have here: photos, the rider's receipt.`,
  }),
  buyerRefunded: (code: string, amount: Money, bankName: string, sellerName?: string | null): Outbound => withMenu(
    `💸 ${ref(code, sellerName)}: your *${m(amount)}* is on its way back to your ${bankName} account. Sorry this one didn't work out. Next time, Hoolam has your back again.`),
  sellerRefunded: (code: string, buyerName?: string | null): Outbound => ({ kind: 'text', text: `💸 ${ref(code, buyerName)} has been refunded to the buyer.` }),

  // ===== FEELING LIVE =====
  /** The other side opened the order (read the alert, or tapped View order). Once, to the person waiting. */
  orderSeen: (code: string, name: string, who: 'seller' | 'buyer'): Outbound => withMenu(
    `👀 *${name}* has seen your order *${code}*.\n\nWe'll tell you as soon as ${who === 'seller' ? 'they accept, update the price or decline' : 'they accept or decline'}.`),
  /** After a shared location: a landmark helps the rider (optional). */
  askPinNote: (place: string | null): Outbound => ({
    kind: 'buttons',
    text: `📍 Got your location${place ? `: _${place.slice(0, 120)}_` : ''}.\n\nAdd a short landmark so the rider finds you easily. For example: _Blue gate, opposite First Bank_`,
    buttons: [{ id: 'pin:skip', title: 'Skip' }],
  }),
  /** First arrival: why save Hoolam's number (the contact card follows). */
  saveHoolam: (): Outbound => ({ kind: 'text', noMenu: true, art: ART.picture('real-hoolam'), text: '📇 Save Hoolam so you always know it\'s really us. Our messages only ever come from this number, and we never ask for your PIN or OTP.' }),

  // ===== ID CHECK (KYC): once per person =====
  /** Why we're asking, then BVN or NIN. `why`: what they were doing when the check came up. */
  kycIntro: (why: KycWhy, limits: { noId: Money; verified: Money }, test = false): Outbound => ({
    kind: 'buttons',
    art: ART.picture('id-check'), clips: CLIP.idCheck,
    text: `${kycWhyText(why, limits)}\n\nChoose *BVN* or *NIN*. You'll need the number and your date of birth.\n\n🔒 We store only the result, never your BVN or NIN.${test ? '\n\n_TEST MODE: any 11 digits pass. 00000000000 is not found._' : ''}`,
    buttons: [{ id: 'kyc:bvn', title: 'Use BVN' }, { id: 'kyc:nin', title: 'Use NIN' }, { id: 'kyc:later', title: 'Not now' }],
  }),
  /** The same, as the WhatsApp form (BVN or NIN, the number and date of birth on one screen). */
  kycForm: (flowId: string, mode: 'draft' | 'published', why: KycWhy, limits: { noId: Money; verified: Money }, test = false): Outbound => ({
    kind: 'form',
    art: ART.picture('id-check'), clips: CLIP.idCheck,
    header: '🪪 Quick ID check',
    text: `${kycWhyText(why, limits)}\n\n🔒 We store only the result, never your BVN or NIN.${test ? '\n\n_TEST MODE: any 11 digits pass. 00000000000 is not found._' : ''}`,
    footer: 'Prefer typing? Reply BVN or NIN.',
    cta: 'Check my ID',
    flowId, flowToken: 'kyc:v1', screen: 'WHY', mode,
  }),
  kycAskDob: (method: 'BVN' | 'NIN'): Outbound => ({ kind: 'text', text: `📅 What's your *date of birth*, as it is on your ${method}?\n\nFor example: _25/12/1995_` }),
  kycBadDob: (): Outbound => ({ kind: 'text', text: 'Please type your date of birth like this: _25/12/1995_ (day, month, year).' }),
  kycAskNumber: (method: 'BVN' | 'NIN'): Outbound => ({
    kind: 'text',
    text: `🔢 Now type your *11-digit ${method}*.\n\n${method === 'BVN' ? 'Don\'t know it? Dial *565*0# from the number linked to your bank.' : 'Don\'t know it? Dial *346# from the number you registered your NIN with.'}\n\n🔒 We store only the result, never your BVN or NIN.`,
  }),
  kycBadNumber: (method: 'BVN' | 'NIN'): Outbound => ({ kind: 'text', text: `A ${method} has *11 digits*. Please check it and type it again.` }),
  kycDone: (name: string, verifiedMax: Money, seller: boolean): Outbound => ({
    kind: 'text',
    sticker: 'verified',
    text: `✅ *You're verified, ${name}.*\n\nYou can now do orders up to *${m(verifiedMax)}*.${seller ? ' Your trust card now shows *Verified seller*.' : ''}`,
  }),
  kycFailed: (reason: 'BAD_NUMBER' | 'NOT_FOUND' | 'DOB_MISMATCH' | 'UNAVAILABLE' | 'NO_TRIES', method: 'BVN' | 'NIN', triesLeft: number): Outbound => {
    const why = {
      BAD_NUMBER: `😕 A ${method} has *11 digits*. Please check it.`,
      NOT_FOUND: `😕 *We couldn't find that ${method}.* Check the 11 digits, or try your ${method === 'BVN' ? 'NIN' : 'BVN'} instead.`,
      DOB_MISMATCH: `😕 *The date of birth doesn't match* what's on your ${method}. Check it and try again.`,
      UNAVAILABLE: '⏳ *We can\'t check IDs right now.* Please try again in a few minutes. Nothing is lost.',
      NO_TRIES: '😕 *You\'ve used your 3 tries for today.* Try again tomorrow, or talk to a rep and we\'ll help you.',
    }[reason];
    const left = reason === 'NOT_FOUND' || reason === 'DOB_MISMATCH' ? `\n\n${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left today.` : '';
    return {
      kind: 'buttons', text: why + left,
      buttons: reason === 'NO_TRIES' || triesLeft <= 0 ? [{ id: 'kyc:rep', title: 'Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }]
        : [{ id: 'kyc:retry', title: 'Try again' }, { id: 'kyc:rep', title: 'Talk to a rep' }],
    };
  },
  /**
   * The ID was flagged by its issuer (or the team is still looking at it): no more checks, the team decides.
   * `fresh`: it was flagged just now. Never says why (watchlist, suspension): that's for the team only.
   */
  kycInReview: (fresh: boolean, why: KycWhy, noId: Money, draft: boolean): Outbound => ({
    kind: 'buttons',
    text: (fresh ? '🕵️ *We couldn\'t confirm your ID right away.* Our team will check it and message you.'
      : '🕵️ *Your ID is with our team for checking.* We\'ll message you once it\'s done.')
      + (why === 'seller' || why === 'payout' ? '\n\nYour payouts wait until then. Your money stays safe with Hoolam.' : why === 'ambassador' ? '\n\nYour ambassador setup carries on once it\'s done.' : '')
      + `\n\nMeanwhile, you can do orders up to *${m(noId)}*.${draft ? ' Type a smaller price to carry on.' : ''}`,
    buttons: [{ id: 'menu:human', title: 'Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  /** The team declined a flagged ID: they stay at the limit without ID. */
  kycDeclined: (why: KycWhy, noId: Money, draft: boolean): Outbound => ({
    kind: 'buttons',
    text: `😕 *We couldn't confirm your ID.* You can keep using Hoolam for orders up to *${m(noId)}*.${draft ? ' Type a smaller price to carry on.' : ''}`
      + (why === 'seller' || why === 'payout' ? '\n\nFor your payouts, please talk to a rep.' : ''),
    buttons: [{ id: 'menu:human', title: 'Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  /** Sent from the console when the team approves an ID (a support message, so it arrives even outside 24 hours). */
  kycApprovedText: (name: string, verifiedMax: Money): string =>
    `✅ Your ID is confirmed, ${name}. You can now do orders up to ${m(verifiedMax)}.`,
  /** Sent from the console when the team declines a flagged ID. */
  kycDeclinedText: (noId: Money): string =>
    `We couldn't confirm your ID. You can keep using Hoolam for orders up to ${m(noId)}.`,
  /** ID checks aren't switched on: the limit without ID is the most for now. */
  kycOff: (noId: Money): Outbound => ({
    kind: 'buttons',
    text: `For now, orders can be up to *${m(noId)}*. Please use a smaller price, or talk to a rep about a bigger order.`,
    buttons: [{ id: 'menu:human', title: 'Talk to a rep' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  kycLater: (noId: Money, draft: boolean): Outbound => draft
    ? { kind: 'buttons', text: `👍 No problem. Orders up to *${m(noId)}* don't need an ID check.\n\nType a smaller price to carry on, or check your ID any time.`, buttons: [{ id: 'kyc:retry', title: 'Check my ID' }, { id: 'menu:open', title: 'Main menu' }] }
    : withMenu(`👍 No problem. You can check your ID any time: just tap the order again.\n\nOrders up to *${m(noId)}* don't need it.`),
  /** A seller's payout is ready, but we check their ID first (once). */
  sellerPayoutNeedsKyc: (code: string, amount: Money, buyerName?: string | null): Outbound => ({
    kind: 'buttons',
    art: ART.paid('ready', m(amount), { code }),
    text: `💰 ${ref(code, buyerName)}: *your money is ready.*\n\nBefore we pay you, we check your ID once. It takes a minute. Then *${m(amount)}* goes straight to your account.\n\n🔒 We store only the result, never your BVN or NIN.`,
    buttons: [{ id: 'kyc:payout', title: 'Check my ID' }, { id: 'menu:human', title: 'Talk to a rep' }],
  }),
  /** Verified, but the payout account is in another name. */
  payoutAccountMismatch: (code: string, amount: Money, accountName: string, idName: string, buyerName?: string | null): Outbound => ({
    kind: 'text',
    text: `💰 ${ref(code, buyerName)}: *${m(amount)}* is ready for you.\n\nYour payout account is in the name *${accountName}*, but your ID says *${idName}*. We pay only into an account in your own name: it protects you if your phone is ever stolen.\n\nSend the *account number* of an account in your name, and we'll pay you right away. For example: _0123456789_`,
  }),
  /** A payout or refund account that isn't in the person's ID name. */
  accountNotTheirs: (accountName: string, idName: string, refund: boolean): Outbound => ({
    kind: 'buttons',
    text: `⚠️ *This account is in another name.*\n\nIt belongs to *${accountName}*, but your ID says *${idName}*. ${refund ? 'Refunds' : 'Payouts'} go only to an account in your own name: it protects you if your phone is ever stolen.\n\nSend another account number, like _0123456789_.`,
    buttons: [{ id: 'menu:human', title: 'Talk to a rep' }],
  }),

  // ----- misc -----
  cancelled: (code: string, otherName?: string | null): Outbound => withMenu(`${ref(code, otherName)} is cancelled. No money moved.`),
  sellerBuyerCancelled: (code: string, buyerName = 'The buyer'): Outbound => withMenu(`😕 *${buyerName}* cancelled order *${code}*. No money moved.`),
  sellerBuyerJoined: (code: string, buyerLine?: string): Outbound => ({ kind: 'text', text: `👀 Your buyer opened order ${code}.` + (buyerLine ? `\n${buyerLine}` : '') + `\n\nWe'll tell you as soon as they pay.` }),
  notAllowed: (): Outbound => ({ kind: 'text', text: 'That step isn\'t available for this order right now.' }),
  ordersList: (lines: string[], mode: MenuMode): Outbound => lines.length
    ? withMenu(`📋 ${mode === 'seller' ? 'Orders you’re selling' : 'Your orders'}:\n\n${lines.join('\n\n')}`)
    : mode === 'seller'
      ? { kind: 'buttons', text: '📋 No orders yet.\n\nCreate one and send your buyer the link.', buttons: [{ id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:open', title: 'Main menu' }] }
      : { kind: 'buttons', text: '📋 You haven’t bought anything with Hoolam yet.', buttons: [{ id: 'menu:buy', title: '🛒 Buy something' }, { id: 'menu:open', title: 'Main menu' }] },
  didntUnderstand: (): Outbound => withMenu('Sorry, I didn\'t get that. Tap "Main menu" or type "menu" to see what you can do.'),
  somethingWrong: (): Outbound => ({ kind: 'text', text: 'Something went wrong on our side. Please try again in a moment. Your money is safe.' }),
};

export const STATUS_WORDS: Record<string, string> = {
  AWAITING_SELLER: 'waiting for the seller to accept',
  AWAITING_BUYER: 'waiting for the buyer to accept',
  AWAITING_PAYMENT: 'waiting for payment',
  FUNDED: 'paid, money held',
  SHIPPED: 'on the way, money held',
  RELEASING: 'paying the seller',
  PAYOUT_PENDING: 'payout processing',
  COMPLETED: 'done',
  DISPUTED: 'problem reported, money frozen',
  REFUNDING: 'refunding the buyer',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};
