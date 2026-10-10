import { formatMoney, type Currency } from '../money.js';
import type { ListSection, Outbound } from './client.js';
import { shipText, shortBankName, type BuyerStats, type SellerStats } from '../trust.js';
import { SOCIAL_NAMES, type SocialKind } from '../socials.js';
import { CATEGORIES } from '../deals/categories.js';

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
const HELP_ROWS = (switchTo: 'buyer' | 'seller') => [
  { id: 'menu:problem', title: '🚩 Report a problem', description: switchTo === 'seller' ? 'We hold the money until it’s sorted' : 'Get help with an order' },
  { id: 'menu:how', title: '💡 How it works', description: 'The steps and fees' },
  { id: 'menu:human', title: '🙋 Talk to a rep', description: 'Live rep within 30 mins' },
  switchTo === 'seller'
    ? { id: 'menu:tosell', title: '🔁 Switch to selling', description: 'Sell safely, get paid for sure' }
    : { id: 'menu:tobuy', title: '🔁 Switch to buying', description: 'Buy safely from any seller' },
];

export const BUYER_MENU: ListSection[] = [
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

export const SELLER_MENU: ListSection[] = [
  {
    title: 'Selling',
    rows: [
      { id: 'menu:sell', title: '🏷️ Sell something', description: 'Send your buyer a safe-pay link' },
      { id: 'menu:orders', title: '📋 My orders', description: 'Track your sales and payouts' },
      { id: 'menu:card', title: '🛡️ My trust card', description: 'Your public brand image' },
      { id: 'menu:account', title: '🏦 Payout account', description: 'Where we send your money' },
    ],
  },
  { title: 'Help', rows: HELP_ROWS('buyer') },
];

export type MenuMode = 'buyer' | 'seller';
export const menuFor = (mode: MenuMode): ListSection[] => (mode === 'seller' ? SELLER_MENU : BUYER_MENU);

/** The whole idea in four lines. Used in the welcome and in "How it works". */
const STORY =
  '💳  Buyer pays\n' +
  '🛡️  Hoolam holds the money\n' +
  '📦  Seller delivers\n' +
  '✅  Buyer is happy → seller gets paid';

/** A message with a "Main menu" button under it, so nobody is left at a dead end. */
/** "+2348012345678" → "+234 801 ••• 5678" */
const maskPhone = (p: string) => p.length > 8 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ••• ${p.slice(-4)}` : p;
const first = (name: string | null) => (name ? ' ' + name.split(' ')[0] : '');
const withMenu = (text: string): Outbound => ({ kind: 'buttons', text, buttons: [{ id: 'menu:open', title: 'Main menu' }] });

export const msg = {
  moneyText: (x: Money): string => m(x),
  /** First time we meet someone: the story in four lines, and one question: buying or selling? */
  welcome: (name: string | null): Outbound => ({
    kind: 'buttons',
    text: `Hi${first(name)} 👋 *Welcome to Hoolam*\n\nBuy and sell on WhatsApp without fear.\n\n${STORY}\n\nWhat brings you here?`,
    buttons: [{ id: 'menu:tobuy', title: '🛒 I’m buying' }, { id: 'menu:sell', title: '🏷️ I’m selling' }, { id: 'menu:how', title: '💡 How it works' }],
  }),

  /** Everyone after that: short, straight to the options for the side they're on. */
  menu: (name: string | null, mode: MenuMode = 'buyer', note?: string): Outbound => ({
    kind: 'list',
    header: mode === 'seller' ? '🏷️ Selling' : '🛒 Buying',
    text: note ? `${note}\n\nWhat would you like to do?` : `Hi${first(name)} 👋 What would you like to do?`,
    footer: 'Your money stays safe with Hoolam',
    button: 'Open menu',
    sections: menuFor(mode),
  }),

  // ----- becoming a seller (once) -----
  setupIntro: (whatsappName: string | null): Outbound => ({
    kind: whatsappName ? 'buttons' : 'text',
    text:
      '🏷️ *Set up as a seller*\n\nOne time, two quick questions. This creates your *trust card*: the record buyers see before they pay you.\n\n' +
      'What name should buyers see? Your shop or brand name.' + (whatsappName ? `\n\nOr keep the name from your WhatsApp: *${whatsappName}*` : '\n\nFor example: _Bayo Kicks_'),
    ...(whatsappName ? { buttons: [{ id: 'setup:wname', title: 'Use this name' }] } : {}),
  } as Outbound),
  setupCity: (): Outbound => ({ kind: 'buttons', text: '📍 Which city do you sell from?\n\nFor example: _Port Harcourt_', buttons: [{ id: 'setup:nocity', title: 'Skip' }] }),
  setupDone: (card: string, thenSell: boolean): Outbound => thenSell
    ? { kind: 'text', text: `✅ *Your trust card is ready*\n\n${card}\n\nIt grows with every order you complete. Now, your first sale 👇` }
    : {
      kind: 'buttons',
      text: `✅ *Your trust card is ready*\n\n${card}\n\nIt grows with every order you complete. Add a photo and your Instagram any time under *My trust card*.`,
      buttons: [{ id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:open', title: 'Main menu' }],
    },
  switchedTo: (mode: MenuMode): string => (mode === 'seller' ? '🔁 You’re on the *selling* menu now.' : '🔁 You’re on the *buying* menu now.'),

  help: (): Outbound => ({
    kind: 'buttons',
    text:
      'One payment, start to finish 👇\n\n' +
      '🏷️  Seller creates an order here\n' +
      '💳  Buyer pays. Hoolam holds it\n' +
      '📦  Seller ships. Money already safe\n' +
      '✅  Buyer checks it, taps "I\'m happy"\n' +
      '💸  Seller gets paid\n\n' +
      '🚩 Problem? The money stays frozen until it\'s sorted.',
    buttons: [{ id: 'menu:buy', title: '🛒 Buy something' }, { id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:fees', title: '🧾 Fees' }],
  }),

  fees: (rules: string, examples: string[], maxDeal: Money): Outbound => withMenu(
    `🧾 Fees\n\n${rules}\n\n${examples.join('\n')}\n\nOrders up to ${m(maxDeal)} for now. Cancelled before payment? No fee.`,
  ),

  // ----- buyer starts from the menu -----
  askDealCode: (): Outbound => ({ kind: 'text', text: '💳 Send the order code from your seller.\n\nIt looks like this: *HL-7K2QF*' }),
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
  askSellerProblem: (code: string): Outbound => ({ kind: 'text', text: `🚩 What's wrong with order ${code}? Type it, or send a photo.\n\nA live rep replies right here within 30 minutes.` }),
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
  askNewAccount: (): Outbound => ({ kind: 'text', text: '🏦 Send the new account number and bank.\n\nFor example: _0123456789 GTBank_' }),
  accountSaved: (bankName: string, last4: string): Outbound => withMenu(`✅ Saved. New orders pay into ${bankName} ••••${last4}.\n\nOrders already running keep their account.`),

  // ----- talk to a person -----
  askHumanMessage: (): Outbound => ({ kind: 'text', text: '🙋 Type your message for the team. A photo works too.\n\nA live rep replies right here, within 30 minutes.' }),
  humanLogged: (ref: string): Outbound => withMenu(`✅ Got it. Your message is with the team.\n\nA rep will reply here within 30 minutes. (Ref ${ref})`),

  testNothingToPay: (): Outbound => ({ kind: 'text', text: 'TEST MODE: there is no payment waiting. Open an order link and tap "Pay now" first.' }),
  voiceSoon: (): Outbound => ({ kind: 'text', text: 'Voice notes are coming soon. For now, please type your answer.' }),



  // ===== TRUST CARD =====
  /** One line, shown right above "Pay now". */
  trustLine: (t: SellerStats): string => {
    const parts = [`🛡️ ${t.name}`];
    if (t.isNew) parts.push('🌱 New on Hoolam');
    if (t.completed) parts.push(`✅ ${t.completed} order${t.completed === 1 ? '' : 's'}`);
    if (t.rated >= 5) parts.push(`👍 ${Math.round((100 * t.happy) / t.rated)}%`);
    if (t.refunded) parts.push(`⚖️ ${t.refunded} refunded`);
    return parts.join(' · ');
  },

  /** The full card, as text. */
  trustCardText: (t: SellerStats): string => {
    const lines = [`🛡️ *${t.name}*${t.city ? ' · ' + t.city : ''}`, `On Hoolam since ${t.since.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`, ''];
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
    if (t.socials.length) lines.push(`🔗 ${t.socials.map((s) => `${s.kind === 'website' ? '' : SOCIAL_NAMES[s.kind] + ' '}${s.label}`).join(' · ')}`);
    lines.push('', '_Counted from real orders paid through Hoolam._');
    return lines.join('\n');
  },

  /** A buyer's record, for sellers. */
  buyerLine: (b: BuyerStats): string => {
    if (!b.purchases && !b.problems) return `👤 ${b.name} · 🌱 new buyer on Hoolam`;
    const bits = [`👤 ${b.name}`, `🛍️ ${b.purchases} purchase${b.purchases === 1 ? '' : 's'}`];
    bits.push(b.problems ? `⚖️ ${b.problems} problem${b.problems === 1 ? '' : 's'} reported${b.refunded ? ` (${b.refunded} refunded)` : ''}` : 'no problems reported');
    return bits.join(' · ');
  },

  /** A buyer looks at a seller's record (from an order, or "Check a seller"). */
  sellerRecord: (card: string, payCode: string | null, buyFromId: string | null): Outbound => ({
    kind: 'buttons',
    text: card,
    buttons: payCode
      ? [{ id: `pay:${payCode}`, title: '💳 Pay now' }, { id: 'menu:open', title: 'Main menu' }]
      : [...(buyFromId ? [{ id: `buyfrom:${buyFromId}`, title: '🛒 Buy from them' }] : []), { id: 'menu:check', title: '🔍 Check another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askCheckSeller: (): Outbound => ({ kind: 'text', text: '🔍 Send the seller\'s WhatsApp number, or an order code they gave you.\n\nFor example: _08012345678_ or _HL-7K2QF_' }),
  noSellerRecord: (): Outbound => ({
    kind: 'buttons',
    text: '🌱 No Hoolam record for that number yet. That doesn\'t mean they\'re bad, just new here.\n\nStay safe either way: with a Hoolam order, your money is held until you\'re happy.',
    buttons: [{ id: 'menu:buy', title: '🛒 Buy something' }, { id: 'menu:check', title: '🔍 Check another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyingFrom: (name: string, trust: string): Outbound => ({ kind: 'text', text: `🛒 You're buying from *${name}*\n${trust}\n\nWhat are you buying?\nFor example: _Black sneakers, size 42_\n\n💡 You only pay after ${name} accepts.` }),

  /** A seller looks at their own card. */
  myTrustCard: (card: string, url: string | null): Outbound => ({
    kind: 'buttons',
    text: `${card}\n\n👀 This is what buyers see before they pay.` + (url ? `\n\n🔗 Your page: ${url}` : ''),
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
  editMyPage: (t: SellerStats, hasPhoto: boolean): Outbound => {
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
      ],
    };
  },
  askProfilePhoto: (hasPhoto: boolean): Outbound => ({
    kind: 'buttons',
    text: '📸 Send a clear photo of *you* or *your shop*.\n\nIt shows in a circle on your page, so keep the face or the shop in the middle.',
    buttons: [...(hasPhoto ? [{ id: 'card:rmphoto', title: '🗑️ Remove photo' }] : []), { id: 'card:cancel', title: 'Cancel' }],
  }),
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
  cardShared: (url: string): Outbound => withMenu(`🔗 Your page is live:\n${url}\n\nPost it on Instagram, your WhatsApp status, or send it to buyers. Anyone who taps *Buy safely* starts a protected order with you.\n\nTip: forward the next message as it is.`),
  cardForwardText: (name: string, url: string): Outbound => ({ kind: 'text', text: `🛡️ Buy from ${name} safely with Hoolam. Your money is held until you're happy with your order.\n\n${url}` }),
  cardHidden: (): Outbound => withMenu('🙈 Your page is hidden. Buyers still see your record on your orders, to keep them safe.'),

  // ===== RATINGS =====
  ratedUp: (sellerName: string): Outbound => withMenu(`🙏 Thanks! It's on ${sellerName}'s record now, and it helps the next buyer.`),
  askRatingComment: (code: string): Outbound => ({
    kind: 'buttons',
    text: '😕 Sorry it wasn\'t great. What went wrong? (Optional. Only our team sees this.)',
    buttons: [{ id: `ratenote:${code}`, title: 'Skip' }],
  }),
  ratingCommentThanks: (): Outbound => withMenu('🙏 Thanks. A real person on our team reads every one.'),
  alreadyRated: (): Outbound => withMenu('🙏 You\'ve already rated this order. Thanks!'),

  // ===== BUYER STARTS A DEAL =====
  /** The button that opens the WhatsApp form. */
  buyForm: (flowId: string, mode: 'draft' | 'published'): Outbound => ({
    kind: 'form',
    header: '🛒 Buy safely',
    text: 'Tell us what you\'re buying. It takes a minute.\n\n💡 You only pay after the seller accepts, and your money stays with Hoolam until you\'re happy.',
    footer: 'Prefer typing? Just send the item name.',
    cta: 'Start my order',
    flowId, flowToken: 'buy:v1', screen: 'ITEM', mode,
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
  askSellerPhone: (): Outbound => ({
    kind: 'buttons',
    text: '📨 What\'s the seller\'s WhatsApp number?\n\nWe\'ll alert them for you. Or skip, and we\'ll give you a link to send them.',
    buttons: [{ id: 'buy:nophone', title: 'Skip' }],
  }),
  badSellerPhone: (): Outbound => ({
    kind: 'buttons',
    text: '🤔 I couldn\'t read that number. Try it like _08012345678_ or _+229 90 00 00 00_.',
    buttons: [{ id: 'buy:nophone', title: 'Skip' }],
  }),

  /** Check before sending. The Hoolam fee is added once the seller accepts (they may change the price). */
  buySummary: (d: { item: string; description?: string | null; category?: string | null; address?: string | null; photos: number; arriveBy: string | null; sellerPhone: string | null; total: Money; feeRule: string }): Outbound => ({
    kind: 'buttons',
    text:
      `🛒 *Check your order*\n\n*${d.item}*\n` +
      (d.description ? `${d.description}\n` : '') +
      (d.category ? `🏷️ ${d.category}\n` : '') +
      (d.photos ? `📷 ${d.photos} photo${d.photos > 1 ? 's' : ''}\n` : '') +
      (d.address ? `📍 ${d.address}\n` : '') +
      (d.arriveBy ? `📅 Expecting it by ${d.arriveBy}\n` : '') +
      `📨 ${d.sellerPhone ? `We'll send it to ${maskPhone(d.sellerPhone)}` : 'You\'ll get a link for the seller'}\n\n` +
      `*Total price  ${m(d.total)}*\n_Delivery included, if any._\n\n` +
      `🧾 Hoolam's fee is added when the seller accepts: ${d.feeRule}.\n\n💡 Nothing to pay yet.`,
    buttons: [{ id: 'buy:send', title: '📨 Send to seller' }, { id: 'buy:restart', title: '✏️ Start again' }],
  }),

  // chat version of the new questions (when the form can't be used)
  askBuyDescription: (): Outbound => ({ kind: 'text', text: '📝 Describe it: size, colour, model, condition.\n\nFor example: _White, size 43, brand new in box_' }),
  askCategory: (): Outbound => ({
    kind: 'list', text: '🏷️ What kind of item is it?', button: 'Choose',
    sections: [{ title: 'Category', rows: CATEGORIES.map((c) => ({ id: `cat:${c.id}`, title: c.title })) }],
  }),
  askDeliveryAddress: (): Outbound => ({ kind: 'text', text: '📍 What\'s the delivery address?\n\nStreet, area and city. For example: _12 Woji Road, Port Harcourt_' }),

  buyDealReady: (code: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed', hours: number): Outbound => ({
    kind: 'buttons',
    text:
      `✅ Order *${code}* is ready.\n\n` +
      (alert === 'sent' ? '📨 We\'ve alerted the seller.\n\nSend them this link too, just in case:\n'
        : alert === 'own-number' ? '📨 That\'s your own number, so we didn\'t alert it. Send this link to the seller:\n'
        : alert === 'opted-out' ? '📨 That number asked us not to message it. Send this link to the seller yourself:\n'
        : 'Send this link to the seller:\n') +
      `${link}\n\n⏳ They have ${hours} hours to accept. We'll tell you the moment they do.`,
    buttons: [{ id: `cancel:${code}`, title: 'Cancel order' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerAlertFailed: (): Outbound => ({ kind: 'text', text: '📵 We couldn\'t reach that WhatsApp number. Please send the seller the link above.' }),
  ownBuyDeal: (code: string, link: string): Outbound => withMenu(`🛒 This is your order ${code}. It's waiting for the seller.\n\nSend them this link:\n${link}`),

  buyerSellerAccepted: (code: string, sellerName: string, item: string, amt: { price: Money; fee: Money; pay: Money }, trust?: string): Outbound => ({
    kind: 'buttons',
    text: `🎉 ${sellerName} accepted your order!\n` + (trust ? `${trust}\n` : '') +
      `\n*${item}*\nTotal price    ${m(amt.price)}\nHoolam fee     ${m(amt.fee)}\n*You pay        ${m(amt.pay)}*\n\n` +
      `🛡️ Your money stays with Hoolam until you have your item and you're happy. (Order ${code})`,
    buttons: [{ id: `pay:${code}`, title: '💳 Pay now' }, { id: `record:${code}`, title: '🛡️ Seller\'s record' }, { id: `cancel:${code}`, title: 'Not now' }],
  }),
  buyerSellerDeclined: (code: string): Outbound => ({
    kind: 'buttons',
    text: `😕 The seller declined order ${code}. No money moved.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerNotMe: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📵 The number you gave says it isn't the seller, so order ${code} is closed. No money moved.\n\nCheck the number and start again, or send the seller the link yourself.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start again' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerSellerExpired: (code: string): Outbound => ({
    kind: 'buttons',
    text: `⏳ The seller didn't accept order ${code} in time, so it's closed. No money moved.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start another' }, { id: 'menu:open', title: 'Main menu' }],
  }),

  // ===== WHAT THE SELLER SEES (seller flow comes later; this is the small part buyers need) =====
  sellerDealCard: (d: { code: string; buyerName: string; item: string; description?: string | null; category?: string | null; address?: string | null; price: Money; sellerGets: Money; arriveBy: string | null; hoursLeft: number; invited: boolean; buyerLine?: string }): Outbound => ({
    kind: 'buttons',
    text:
      `🛒 *${d.buyerName} wants to buy from you*\n` + (d.buyerLine ? `${d.buyerLine}\n` : '') +
      `\n*${d.item}*\n` + (d.description ? `${d.description}\n` : '') + (d.category ? `🏷️ ${d.category}\n` : '') +
      (d.address ? `📍 ${d.address}\n` : '') + (d.arriveBy ? `📅 Expecting it by ${d.arriveBy}\n` : '') +
      `\n💰 Total price ${m(d.price)} (delivery included)\n💸 You receive *${m(d.sellerGets)}*, minus the rider's fee if you send one\n` +
      `\n💳 ${d.buyerName} pays Hoolam first\n📦 You dispatch once the money is held\n💸 You get paid when they're happy\n\n` +
      `⏳ Accept within ${d.hoursLeft} hour${d.hoursLeft === 1 ? '' : 's'}. (Order ${d.code})`,
    buttons: [
      { id: `saccept:${d.code}`, title: '✅ Accept' },
      { id: `scounter:${d.code}`, title: '✏️ Change price' },
      { id: `sdecline:${d.code}`, title: '✕ Decline' },
    ],
  }),
  askSellerBank: (): Outbound => ({ kind: 'text', text: '🏦 Last step: where should we pay you when the buyer is happy?\n\nSend your account number and bank.\nFor example: _0123456789 GTBank_' }),
  sellerAcceptedOk: (code: string, buyerName: string, bankName: string, last4: string): Outbound => withMenu(
    `✅ Order ${code} accepted.\n\n⏳ We've asked ${buyerName} to pay. We'll tell you the moment the money is held. Don't ship before then.\n\n🏦 You'll be paid into ${bankName} ••••${last4}.`,
  ),

  // ----- Change price -----
  askCounterPrice: (current: Money): Outbound => ({ kind: 'text', text: `✏️ What price works for you? (in naira)\n\nThe buyer offered ${m(current)}.` }),
  counterSent: (code: string, buyerName: string, price: Money): Outbound => withMenu(`✏️ Sent. We've asked ${buyerName} if ${m(price)} works.\n\nWe'll tell you when they answer. (Order ${code})`),
  counterWaiting: (code: string): Outbound => withMenu(`⏳ Order ${code}: we're waiting for the buyer to answer your price.`),
  buyerCounterOffer: (code: string, sellerName: string, item: string, oldPrice: Money, newPrice: Money, newTotal: Money): Outbound => ({
    kind: 'buttons',
    text: `✏️ ${sellerName} suggests a different price\n\n*${item}*\n~${m(oldPrice)}~ → *${m(newPrice)}*\nYou'd pay *${m(newTotal)}*\n\n💡 You only pay if you accept. (Order ${code})`,
    buttons: [{ id: `cyes:${code}`, title: '✅ Accept new price' }, { id: `cancel:${code}`, title: '✕ Cancel order' }],
  }),
  sellerCounterAccepted: (code: string, buyerName: string, youGet: Money): Outbound => withMenu(
    `🎉 ${buyerName} accepted your price for order ${code}. You'll receive ${m(youGet)}.\n\n⏳ We've asked them to pay. Don't ship before we confirm the money is held.`,
  ),
  askDeclineReason: (code: string): Outbound => ({
    kind: 'buttons',
    text: 'No problem. Which is it?',
    buttons: [{ id: `sno:${code}`, title: 'Not interested' }, { id: `snotme:${code}`, title: '🚫 Wrong number' }],
  }),
  cancelledByHoolam: (code: string): Outbound => withMenu(`Order ${code} has been closed by the Hoolam team. No money moved.\n\nQuestions? Tap Main menu → Talk to a rep.`),
  fromTeam: (text: string): Outbound => withMenu(`🙋 From the Hoolam team:\n\n${text}`),
  accountPaused: (): Outbound => ({
    kind: 'buttons',
    text: '⏸️ Your Hoolam account is paused while our team looks into something. You can still talk to us.',
    buttons: [{ id: 'menu:human', title: '🙋 Talk to a rep' }],
  }),
  sellerDeclinedOk: (code: string): Outbound => withMenu(`Done. Order ${code} is declined. No money moved.`),
  sellerNotMeOk: (): Outbound => ({ kind: 'text', text: '🙏 Sorry about that. We won\'t send you order alerts again.' }),
  dealHasSeller: (code: string): Outbound => withMenu(`🔒 Order ${code} already has a seller. If you're selling to this buyer, ask them for a new order.`),
  dealStatusNow: (code: string, status: string): Outbound => withMenu(`Order ${code}: ${STATUS_WORDS[status] ?? status}.`),

  // ----- seller creates an order -----
  askItem: (): Outbound => ({ kind: 'text', text: '🏷️ What are you selling?\n\nFor example: _2 pairs of sneakers, size 42_' }),
  askPrice: (): Outbound => ({ kind: 'text', text: 'What\'s the price in naira? (For example: 15000)' }),
  badPrice: (): Outbound => ({ kind: 'text', text: 'I didn\'t get that price. Please type just the amount, like 15000.' }),
  priceTooHigh: (max: Money): Outbound => ({ kind: 'text', text: `For now, orders can be up to ${m(max)}. Please type a smaller price, or contact us for bigger orders.` }),
  askBank: (): Outbound => ({ kind: 'text', text: 'Where should we pay you? Send your account number and bank.\n\nFor example: 0123456789 GTBank' }),
  badBank: (): Outbound => ({ kind: 'text', text: 'I couldn\'t read that. Please send a 10-digit account number and your bank name, like: 0123456789 Opay' }),
  bankNotFound: (bank: string): Outbound => ({ kind: 'text', text: `I couldn't find a bank called "${bank}". Try the usual name, like GTBank, Access, Zenith, Opay, Moniepoint or Kuda.` }),
  accountNotFound: (): Outbound => ({ kind: 'text', text: 'That account number didn\'t match the bank. Please check it and send it again.' }),
  confirmBank: (accountName: string, bankName: string, last4: string): Outbound => ({
    kind: 'buttons',
    text: `Is this your account?\n\n${accountName}\n${bankName} ••••${last4}`,
    buttons: [{ id: 'bank:yes', title: 'Yes, that\'s me' }, { id: 'bank:no', title: 'No, change it' }],
  }),
  confirmDeal: (d: { item: string; photos: number; buyerPhone: string | null; price: Money; fee: Money; buyerPays: Money; sellerGets: Money }): Outbound => ({
    kind: 'buttons',
    text:
      `🏷️ *Check your order*\n\n*${d.item}*\n` +
      (d.photos ? `📷 ${d.photos} photo${d.photos > 1 ? 's' : ''}\n` : '') +
      `📨 ${d.buyerPhone ? `We'll send it to ${maskPhone(d.buyerPhone)}` : 'You\'ll get a link for the buyer'}\n\n` +
      `Price         ${m(d.price)}\nHoolam fee   −${m(d.fee)}\n*You receive  ${m(d.sellerGets)}*\n\n` +
      `💳 The buyer pays ${m(d.buyerPays)}. You started the order, so you pay the fee.`,
    buttons: [{ id: 'sell:confirm', title: '✅ Create order' }, { id: 'sell:restart', title: '✏️ Start again' }],
  }),
  askSellPhotos: (): Outbound => ({
    kind: 'buttons',
    text: '📷 Add photos of the item? Send up to 3.\n\nBuyers trust real photos, and they\'re your proof of what you sold.',
    buttons: [{ id: 'sell:nophotos', title: 'No photos' }],
  }),
  askBuyerPhone: (): Outbound => ({
    kind: 'buttons',
    text: '📨 What\'s the buyer\'s WhatsApp number?\n\nWe\'ll send them the order. Or skip, and we\'ll give you a link to send them.',
    buttons: [{ id: 'sell:nophone', title: 'Skip' }],
  }),
  badBuyerPhone: (): Outbound => ({
    kind: 'buttons',
    text: '🤔 I couldn\'t read that number. Try it like _08012345678_ or _+229 90 00 00 00_.',
    buttons: [{ id: 'sell:nophone', title: 'Skip' }],
  }),
  sellerBuyerNotMe: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📵 The number you gave says it isn't your buyer, so order ${code} is closed. No money moved.\n\nCheck the number and start again, or send the buyer the link yourself.`,
    buttons: [{ id: 'menu:sell', title: '🏷️ Start again' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellForm: (flowId: string, mode: 'draft' | 'published'): Outbound => ({
    kind: 'form',
    header: '🏷️ Sell safely',
    text: 'Tell us what you\'re selling. It takes a minute.\n\n💡 The buyer pays Hoolam, and we pay you when they\'re happy.',
    footer: 'Prefer typing? Just send the item name.',
    cta: 'Start my order',
    flowId, flowToken: 'sell:v1', screen: 'ITEM', mode,
  }),
  dealCreated: (code: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed' = 'none'): Outbound => withMenu(
    `✅ Order *${code}* is ready.\n\n` +
    (alert === 'sent' ? '📨 We\'ve sent the buyer the order.\n\nSend them this link too, just in case:\n'
      : alert === 'own-number' ? '📨 That\'s your own number, so we didn\'t alert it. Send this link to your buyer:\n'
      : alert === 'opted-out' ? '📨 That number asked us not to message it. Send this link to your buyer yourself:\n'
      : alert === 'failed' ? '📵 We couldn\'t reach that WhatsApp number. Send this link to your buyer:\n'
      : 'Send this link to your buyer:\n') +
    `${link}\n\n⏳ We'll tell you the moment they pay. Don't ship before then.`,
  ),

  // ----- buyer -----
  dealNotFound: (): Outbound => ({ kind: 'text', text: 'I couldn\'t find that order. Please check the code with the seller.' }),
  ownDeal: (): Outbound => ({ kind: 'text', text: 'This is your own order. Send the link to your buyer.' }),
  dealTaken: (): Outbound => ({ kind: 'text', text: 'Someone else is already paying for this order. Ask the seller for a new link.' }),
  dealClosed: (code: string): Outbound => ({ kind: 'text', text: `Order ${code} is already closed.` }),
  dealForBuyer: (code: string, item: string, sellerName: string, price: Money, fee: Money, total: Money, trust?: string): Outbound => ({
    kind: 'buttons',
    text:
      `Order ${code}\n${item}\n` + (trust ? `${trust}\n` : `Seller: ${sellerName}\n`) + '\n' +
      (fee.minor > 0 ? `Price: ${m(price)}\nHoolam fee: ${m(fee)}\n*You pay: ${m(total)}*\n\n` : `*You pay: ${m(total)}*\nNo fee for you: the seller pays it.\n\n`) +
      'Your money stays with Hoolam, not the seller. They only get paid after you receive your item and say you\'re happy. If it never comes, you get your money back.',
    buttons: [{ id: `pay:${code}`, title: '💳 Pay now' }, { id: `record:${code}`, title: '🛡️ Seller\'s record' }, { id: `cancel:${code}`, title: 'Not now' }],
  }),
  payInstructions: (total: Money, accountNumber: string, bankName: string, accountName: string, minutes: number | null, code: string, hint: 'fake' | 'sandbox' | null = null): Outbound => ({
    kind: 'buttons',
    text:
      `Transfer exactly ${m(total)} to:\n\n${accountNumber}\n${bankName}\n${accountName}\n\n` +
      (minutes ? `This account number works for ${minutes} minutes. ` : '') +
      'You can pay from any bank app, Opay, Moniepoint or PalmPay. We\'ll confirm the moment it lands.' +
      (hint === 'fake' ? '\n\nTEST MODE: no real money. Reply "paid" to pretend you made the transfer.' : '') +
      (hint === 'sandbox' ? '\n\nTEST MODE: no real money. Pay this account with Monnify\'s test bank: websim.sdk.monnify.com' : ''),
    buttons: [{ id: `newacct:${code}`, title: 'New account number' }],
  }),
  paymentPartial: (paid: Money, due: Money): Outbound => ({
    kind: 'text',
    text: `We received ${m(paid)}, but the total is ${m(due)}. Your money is safe with us. A person from Hoolam will contact you to sort it out.`,
  }),
  buyerFunded: (total: Money, code: string): Outbound => ({
    kind: 'text',
    text: `Received ${m(total)}. Your money is safe with Hoolam.\n\nWe've told the seller to send your item. Nothing moves until you say you're happy. (Order ${code})`,
  }),

  // ----- seller ships -----
  sellerFunded: (code: string, yours: Money): Outbound => ({
    kind: 'buttons',
    text: `Good news: the buyer has paid for order ${code}. Your ${m(yours)} is held safely by Hoolam.\n\nShip the item now, then tap below.`,
    buttons: [{ id: `shipped:${code}`, title: 'I\'ve sent it' }],
  }),
  sellerShippedOk: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📦 Thanks. We've told the buyer that order ${code} is on the way.\n\nWant to add proof? Send a photo of the package or receipt, or type a tracking number. It protects you if there's a problem.`,
    buttons: [{ id: `noproof:${code}`, title: 'No thanks' }],
  }),
  shippingProofSaved: (code: string): Outbound => withMenu(`✅ Proof saved for order ${code} and shown to the buyer.`),
  buyerShippingNote: (code: string, note: string): Outbound => ({ kind: 'text', text: `📦 From the seller, about order ${code}:\n\n${note}` }),
  buyerShipped: (code: string): Outbound => ({
    kind: 'buttons',
    text: `Your item for order ${code} is on the way.\n\nWhen it arrives, open it and check it. Then tell us:`,
    buttons: [{ id: `happy:${code}`, title: 'I\'m happy' }, { id: `problem:${code}`, title: 'Problem' }],
  }),
  buyerNudge: (code: string): Outbound => ({
    kind: 'buttons',
    text: `Has your item for order ${code} arrived? Your money is still safe with us.`,
    buttons: [{ id: `happy:${code}`, title: 'I\'m happy' }, { id: `problem:${code}`, title: 'Problem' }],
  }),

  // ----- release -----
  buyerReleased: (code: string, sellerName = 'the seller'): Outbound => ({
    kind: 'buttons',
    text: `✅ Done. We're paying ${sellerName} now. Thanks for trading safely. (Order ${code})\n\nHow was ${sellerName}? One tap helps the next buyer.`,
    buttons: [{ id: `rateup:${code}`, title: '👍 Great' }, { id: `ratedown:${code}`, title: '👎 Not great' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellerPaid: (code: string, amount: Money, bankName: string): Outbound => withMenu(`You've been paid. ${m(amount)} has been sent to your ${bankName} account for order ${code}.`),
  sellerPayoutDelayed: (code: string): Outbound => ({
    kind: 'text', text: `The buyer is happy with order ${code}. Your payout is being processed and should arrive shortly.`,
  }),

  // ----- problems -----
  askProblem: (code: string): Outbound => ({
    kind: 'text',
    text: `Sorry about that. Your money is frozen and safe.\n\nTell us what's wrong with order ${code}. You can type it or send a photo.`,
  }),
  askRefundBank: (): Outbound => ({
    kind: 'text',
    text: 'If we need to refund you, where should the money go? Send your account number and bank, like: 0123456789 Opay',
  }),
  problemLogged: (code: string, ref: string): Outbound => withMenu(`Got it. Case ${ref} is open for order ${code}. A real person will reply within 24 hours. The money stays frozen until it's sorted.`),
  sellerProblem: (code: string): Outbound => ({
    kind: 'text',
    text: `The buyer reported a problem with order ${code}. The money is frozen while a person from Hoolam looks into it. We may contact you.`,
  }),
  buyerRefunded: (code: string, amount: Money, bankName: string): Outbound => withMenu(`Your refund of ${m(amount)} for order ${code} has been sent to your ${bankName} account.`),
  sellerRefunded: (code: string): Outbound => ({ kind: 'text', text: `Order ${code} was refunded to the buyer after review.` }),

  // ----- misc -----
  cancelled: (code: string): Outbound => withMenu(`Order ${code} is cancelled. No money moved.`),
  sellerBuyerCancelled: (code: string): Outbound => ({ kind: 'text', text: `The buyer cancelled order ${code}. No money moved.` }),
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
  AWAITING_BUYER: 'waiting for the buyer',
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
