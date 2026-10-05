import { formatMoney, type Currency } from '../money.js';
import type { ListSection, Outbound } from './client.js';

// Every message Hoolam sends, in one place. Plain words, short lines, and always answer
// the quiet question underneath: "where is my money right now?"

type Money = { minor: number; currency: Currency };
const m = (x: Money) => formatMoney(x.minor, x.currency);

/**
 * THE MAIN MENU. To add an option: add a row here (title up to 24 characters, description up to 72),
 * then handle its id in flow.ts (look for openMenuItem). WhatsApp allows 10 rows in total.
 */
export const MENU: ListSection[] = [
  {
    title: 'Selling',
    rows: [
      { id: 'menu:sell', title: '🏷️ Sell something', description: 'Get a safe-pay link for your buyer' },
      { id: 'menu:deals', title: '📋 My deals', description: 'Where every deal and every naira is' },
      { id: 'menu:account', title: '🏦 My payout account', description: 'Where we send your money' },
    ],
  },
  {
    title: 'Buying',
    rows: [
      { id: 'menu:buy', title: '🛒 Buy something', description: 'Start a safe deal. You pay after the seller accepts' },
      { id: 'menu:pay', title: '🔑 I have a deal code', description: 'A seller sent you a code? Start here' },
      { id: 'menu:problem', title: '🚩 Report a problem', description: 'We freeze the money until it’s fixed' },
    ],
  },
  {
    title: 'Help',
    rows: [
      { id: 'menu:how', title: '🛡️ How it works', description: 'One payment, start to finish' },
      { id: 'menu:fees', title: '🧾 Fees', description: 'What it costs and who pays' },
      { id: 'menu:human', title: '🙋 Talk to a person', description: 'A real human, within 24 hours' },
    ],
  },
];

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
  /** First time we meet someone: the story in four lines, then the menu. */
  welcome: (name: string | null): Outbound => ({
    kind: 'list',
    header: 'Welcome to Hoolam',
    text: `Hi${first(name)} 👋\n\nBuy and sell on WhatsApp without fear.\n\n${STORY}`,
    footer: 'Nobody gets burned.',
    button: 'Open menu',
    sections: MENU,
  }),

  /** Everyone after that: short, straight to the options. */
  menu: (name: string | null): Outbound => ({
    kind: 'list',
    text: `Hi${first(name)} 👋 What would you like to do?`,
    footer: 'Your money stays safe with Hoolam',
    button: 'Open menu',
    sections: MENU,
  }),

  help: (): Outbound => ({
    kind: 'buttons',
    text:
      'One payment, start to finish 👇\n\n' +
      '🏷️  Seller creates a deal here\n' +
      '💳  Buyer pays. Hoolam holds it\n' +
      '📦  Seller ships. Money already safe\n' +
      '✅  Buyer checks it, taps "I\'m happy"\n' +
      '💸  Seller gets paid\n\n' +
      '🚩 Problem? The money stays frozen until it\'s sorted.',
    buttons: [{ id: 'menu:buy', title: '🛒 Buy something' }, { id: 'menu:sell', title: '🏷️ Sell something' }, { id: 'menu:open', title: 'Main menu' }],
  }),

  fees: (rules: string, examples: string[], maxDeal: Money): Outbound => withMenu(
    `🧾 Fees\n\n${rules}\n\n${examples.join('\n')}\n\nDeals up to ${m(maxDeal)} for now. Cancelled before payment? No fee.`,
  ),

  // ----- buyer starts from the menu -----
  askDealCode: (): Outbound => ({ kind: 'text', text: '💳 Send the deal code from your seller.\n\nIt looks like this: *HL-7K2QF*' }),
  badDealCode: (): Outbound => withMenu('🤔 That doesn\'t look like a deal code.\n\nIt starts with *HL-*, like HL-7K2QF. Check with your seller and send it again.'),

  // ----- problems from the menu -----
  noDealsToReport: (): Outbound => ({
    kind: 'buttons',
    text: '🛡️ No paid deals open right now, so there\'s no money to freeze.\n\nSomething else on your mind? Talk to us.',
    buttons: [{ id: 'menu:human', title: '🙋 Talk to a person' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  pickDealForProblem: (rows: { code: string; item: string }[]): Outbound => ({
    kind: 'list',
    text: '🚩 Which deal has a problem?\n\nWe\'ll freeze its money while we sort it out.',
    button: 'Choose deal',
    sections: [{ title: 'Your paid deals', rows: rows.slice(0, 10).map((r) => ({ id: `problem:${r.code}`, title: r.code, description: r.item.slice(0, 72) })) }],
  }),

  // ----- payout account -----
  accountInfo: (accountName: string, bankName: string, last4: string): Outbound => ({
    kind: 'buttons',
    text: `🏦 We send your money here:\n\n*${accountName}*\n${bankName} ••••${last4}`,
    buttons: [{ id: 'account:change', title: '✏️ Change account' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askNewAccount: (): Outbound => ({ kind: 'text', text: '🏦 Send the new account number and bank.\n\nFor example: _0123456789 GTBank_' }),
  accountSaved: (bankName: string, last4: string): Outbound => withMenu(`✅ Saved. New deals pay into ${bankName} ••••${last4}.\n\nDeals already running keep their account.`),

  // ----- talk to a person -----
  askHumanMessage: (): Outbound => ({ kind: 'text', text: '🙋 Type your message for the team. A photo works too.\n\nA real person replies right here, within 24 hours.' }),
  humanLogged: (ref: string): Outbound => withMenu(`✅ Got it. Your message is with the team.\n\nWe'll reply here within 24 hours. (Ref ${ref})`),

  testNothingToPay: (): Outbound => ({ kind: 'text', text: 'TEST MODE: there is no payment waiting. Open a deal link and tap "Pay now" first.' }),
  voiceSoon: (): Outbound => ({ kind: 'text', text: 'Voice notes are coming soon. For now, please type your answer.' }),


  // ===== BUYER STARTS A DEAL =====
  /** The button that opens the WhatsApp form. */
  buyForm: (flowId: string, mode: 'draft' | 'published'): Outbound => ({
    kind: 'form',
    header: '🛒 Buy safely',
    text: 'Tell us what you\'re buying. It takes a minute.\n\n💡 You only pay after the seller accepts, and your money stays with Hoolam until you\'re happy.',
    footer: 'Prefer typing? Just send the item name.',
    cta: 'Start my deal',
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

  /** Check before sending. */
  buySummary: (d: { item: string; photos: number; arriveBy: string | null; sellerPhone: string | null; price: Money; fee: Money; total: Money }): Outbound => ({
    kind: 'buttons',
    text:
      `🛒 *Check your deal*\n\n*${d.item}*\n` +
      (d.photos ? `📷 ${d.photos} photo${d.photos > 1 ? 's' : ''}\n` : '') +
      (d.arriveBy ? `📅 Arrives by ${d.arriveBy}\n` : '') +
      `📨 ${d.sellerPhone ? `We'll alert ${maskPhone(d.sellerPhone)}` : 'You\'ll get a link for the seller'}\n\n` +
      `Price         ${m(d.price)}\nHoolam fee    ${m(d.fee)}\n*You'll pay    ${m(d.total)}*\n\n` +
      '💡 Nothing to pay yet. You pay after the seller accepts.',
    buttons: [{ id: 'buy:send', title: '📨 Send to seller' }, { id: 'buy:restart', title: '✏️ Start again' }],
  }),

  buyDealReady: (code: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed', hours: number): Outbound => ({
    kind: 'buttons',
    text:
      `✅ Deal *${code}* is ready.\n\n` +
      (alert === 'sent' ? '📨 We\'ve alerted the seller.\n\nSend them this link too, just in case:\n'
        : alert === 'own-number' ? '📨 That\'s your own number, so we didn\'t alert it. Send this link to the seller:\n'
        : alert === 'opted-out' ? '📨 That number asked us not to message it. Send this link to the seller yourself:\n'
        : 'Send this link to the seller:\n') +
      `${link}\n\n⏳ They have ${hours} hours to accept. We'll tell you the moment they do.`,
    buttons: [{ id: `cancel:${code}`, title: 'Cancel deal' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerAlertFailed: (): Outbound => ({ kind: 'text', text: '📵 We couldn\'t reach that WhatsApp number. Please send the seller the link above.' }),
  ownBuyDeal: (code: string, link: string): Outbound => withMenu(`🛒 This is your deal ${code}. It's waiting for the seller.\n\nSend them this link:\n${link}`),

  buyerSellerAccepted: (code: string, sellerName: string, item: string, total: Money): Outbound => ({
    kind: 'buttons',
    text: `🎉 ${sellerName} accepted your deal!\n\n*${item}*\nYou pay *${m(total)}*\n\n🛡️ Your money stays with Hoolam until you have your item and you're happy. (Deal ${code})`,
    buttons: [{ id: `pay:${code}`, title: '💳 Pay now' }, { id: `cancel:${code}`, title: 'Not now' }],
  }),
  buyerSellerDeclined: (code: string): Outbound => ({
    kind: 'buttons',
    text: `😕 The seller declined deal ${code}. No money moved.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start another' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerNotMe: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📵 The number you gave says it isn't the seller, so deal ${code} is closed. No money moved.\n\nCheck the number and start again, or send the seller the link yourself.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start again' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  buyerSellerExpired: (code: string): Outbound => ({
    kind: 'buttons',
    text: `⏳ The seller didn't accept deal ${code} in time, so it's closed. No money moved.`,
    buttons: [{ id: 'menu:buy', title: '🛒 Start another' }, { id: 'menu:open', title: 'Main menu' }],
  }),

  // ===== WHAT THE SELLER SEES (seller flow comes later; this is the small part buyers need) =====
  sellerDealCard: (d: { code: string; buyerName: string; item: string; price: Money; sellerGets: Money; arriveBy: string | null; hoursLeft: number; invited: boolean }): Outbound => ({
    kind: 'buttons',
    text:
      `🛒 *${d.buyerName} wants to buy from you*\n\n*${d.item}*\n💰 ${m(d.price)} → you receive ${m(d.sellerGets)}\n` +
      (d.arriveBy ? `📅 Wanted by ${d.arriveBy}\n` : '') +
      `\n💳 ${d.buyerName} pays Hoolam first\n📦 You ship once the money is held\n💸 You get paid when they're happy\n\n` +
      `⏳ Accept within ${d.hoursLeft} hour${d.hoursLeft === 1 ? '' : 's'}. (Deal ${d.code})`,
    buttons: [
      { id: `saccept:${d.code}`, title: '✅ Accept' },
      { id: `scounter:${d.code}`, title: '✏️ Change price' },
      { id: `sdecline:${d.code}`, title: '✕ Decline' },
    ],
  }),
  askSellerBank: (): Outbound => ({ kind: 'text', text: '🏦 Last step: where should we pay you when the buyer is happy?\n\nSend your account number and bank.\nFor example: _0123456789 GTBank_' }),
  sellerAcceptedOk: (code: string, buyerName: string, bankName: string, last4: string): Outbound => withMenu(
    `✅ Deal ${code} accepted.\n\n⏳ We've asked ${buyerName} to pay. We'll tell you the moment the money is held. Don't ship before then.\n\n🏦 You'll be paid into ${bankName} ••••${last4}.`,
  ),

  // ----- Change price -----
  askCounterPrice: (current: Money): Outbound => ({ kind: 'text', text: `✏️ What price works for you? (in naira)\n\nThe buyer offered ${m(current)}.` }),
  counterSent: (code: string, buyerName: string, price: Money): Outbound => withMenu(`✏️ Sent. We've asked ${buyerName} if ${m(price)} works.\n\nWe'll tell you when they answer. (Deal ${code})`),
  counterWaiting: (code: string): Outbound => withMenu(`⏳ Deal ${code}: we're waiting for the buyer to answer your price.`),
  buyerCounterOffer: (code: string, sellerName: string, item: string, oldPrice: Money, newPrice: Money, newTotal: Money): Outbound => ({
    kind: 'buttons',
    text: `✏️ ${sellerName} suggests a different price\n\n*${item}*\n~${m(oldPrice)}~ → *${m(newPrice)}*\nYou'd pay *${m(newTotal)}*\n\n💡 You only pay if you accept. (Deal ${code})`,
    buttons: [{ id: `cyes:${code}`, title: '✅ Accept new price' }, { id: `cancel:${code}`, title: '✕ Cancel deal' }],
  }),
  sellerCounterAccepted: (code: string, buyerName: string, youGet: Money): Outbound => withMenu(
    `🎉 ${buyerName} accepted your price for deal ${code}. You'll receive ${m(youGet)}.\n\n⏳ We've asked them to pay. Don't ship before we confirm the money is held.`,
  ),
  askDeclineReason: (code: string): Outbound => ({
    kind: 'buttons',
    text: 'No problem. Which is it?',
    buttons: [{ id: `sno:${code}`, title: 'Not interested' }, { id: `snotme:${code}`, title: '🚫 Wrong number' }],
  }),
  sellerDeclinedOk: (code: string): Outbound => withMenu(`Done. Deal ${code} is declined. No money moved.`),
  sellerNotMeOk: (): Outbound => ({ kind: 'text', text: '🙏 Sorry about that. We won\'t send you deal alerts again.' }),
  dealHasSeller: (code: string): Outbound => withMenu(`🔒 Deal ${code} already has a seller. If you're selling to this buyer, ask them for a new deal.`),
  dealStatusNow: (code: string, status: string): Outbound => withMenu(`Deal ${code}: ${STATUS_WORDS[status] ?? status}.`),

  // ----- seller creates a deal -----
  askItem: (): Outbound => ({ kind: 'text', text: '🏷️ What are you selling?\n\nFor example: _2 pairs of sneakers, size 42_' }),
  askPrice: (): Outbound => ({ kind: 'text', text: 'What\'s the price in naira? (For example: 15000)' }),
  badPrice: (): Outbound => ({ kind: 'text', text: 'I didn\'t get that price. Please type just the amount, like 15000.' }),
  priceTooHigh: (max: Money): Outbound => ({ kind: 'text', text: `For now, deals can be up to ${m(max)}. Please type a smaller price, or contact us for bigger deals.` }),
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
      `🏷️ *Check your deal*\n\n*${d.item}*\n` +
      (d.photos ? `📷 ${d.photos} photo${d.photos > 1 ? 's' : ''}\n` : '') +
      `📨 ${d.buyerPhone ? `We'll send it to ${maskPhone(d.buyerPhone)}` : 'You\'ll get a link for the buyer'}\n\n` +
      `Price         ${m(d.price)}\nHoolam fee   −${m(d.fee)}\n*You receive  ${m(d.sellerGets)}*\n\n` +
      `💳 The buyer pays ${m(d.buyerPays)}. You started the deal, so you pay the fee.`,
    buttons: [{ id: 'sell:confirm', title: '✅ Create deal' }, { id: 'sell:restart', title: '✏️ Start again' }],
  }),
  askSellPhotos: (): Outbound => ({
    kind: 'buttons',
    text: '📷 Add photos of the item? Send up to 3.\n\nBuyers trust real photos, and they\'re your proof of what you sold.',
    buttons: [{ id: 'sell:nophotos', title: 'No photos' }],
  }),
  askBuyerPhone: (): Outbound => ({
    kind: 'buttons',
    text: '📨 What\'s the buyer\'s WhatsApp number?\n\nWe\'ll send them the deal. Or skip, and we\'ll give you a link to send them.',
    buttons: [{ id: 'sell:nophone', title: 'Skip' }],
  }),
  badBuyerPhone: (): Outbound => ({
    kind: 'buttons',
    text: '🤔 I couldn\'t read that number. Try it like _08012345678_ or _+229 90 00 00 00_.',
    buttons: [{ id: 'sell:nophone', title: 'Skip' }],
  }),
  sellerBuyerNotMe: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📵 The number you gave says it isn't your buyer, so deal ${code} is closed. No money moved.\n\nCheck the number and start again, or send the buyer the link yourself.`,
    buttons: [{ id: 'menu:sell', title: '🏷️ Start again' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  sellForm: (flowId: string, mode: 'draft' | 'published'): Outbound => ({
    kind: 'form',
    header: '🏷️ Sell safely',
    text: 'Tell us what you\'re selling. It takes a minute.\n\n💡 The buyer pays Hoolam, and we pay you when they\'re happy.',
    footer: 'Prefer typing? Just send the item name.',
    cta: 'Start my deal',
    flowId, flowToken: 'sell:v1', screen: 'ITEM', mode,
  }),
  dealCreated: (code: string, link: string, alert: 'sent' | 'none' | 'own-number' | 'opted-out' | 'failed' = 'none'): Outbound => withMenu(
    `✅ Deal *${code}* is ready.\n\n` +
    (alert === 'sent' ? '📨 We\'ve sent the buyer the deal.\n\nSend them this link too, just in case:\n'
      : alert === 'own-number' ? '📨 That\'s your own number, so we didn\'t alert it. Send this link to your buyer:\n'
      : alert === 'opted-out' ? '📨 That number asked us not to message it. Send this link to your buyer yourself:\n'
      : alert === 'failed' ? '📵 We couldn\'t reach that WhatsApp number. Send this link to your buyer:\n'
      : 'Send this link to your buyer:\n') +
    `${link}\n\n⏳ We'll tell you the moment they pay. Don't ship before then.`,
  ),

  // ----- buyer -----
  dealNotFound: (): Outbound => ({ kind: 'text', text: 'I couldn\'t find that deal. Please check the code with the seller.' }),
  ownDeal: (): Outbound => ({ kind: 'text', text: 'This is your own deal. Send the link to your buyer.' }),
  dealTaken: (): Outbound => ({ kind: 'text', text: 'Someone else is already paying for this deal. Ask the seller for a new link.' }),
  dealClosed: (code: string): Outbound => ({ kind: 'text', text: `Deal ${code} is already closed.` }),
  dealForBuyer: (code: string, item: string, sellerName: string, price: Money, fee: Money, total: Money): Outbound => ({
    kind: 'buttons',
    text:
      `Deal ${code}\n${item}\nSeller: ${sellerName}\n\n` +
      (fee.minor > 0 ? `Price: ${m(price)}\nHoolam fee: ${m(fee)}\n*You pay: ${m(total)}*\n\n` : `*You pay: ${m(total)}*\nNo fee for you: the seller pays it.\n\n`) +
      'Your money stays with Hoolam, not the seller. They only get paid after you receive your item and say you\'re happy. If it never comes, you get your money back.',
    buttons: [{ id: `pay:${code}`, title: 'Pay now' }, { id: `cancel:${code}`, title: 'Not now' }],
  }),
  payInstructions: (total: Money, accountNumber: string, bankName: string, accountName: string, minutes: number | null, code: string, testMode = false): Outbound => ({
    kind: 'buttons',
    text:
      `Transfer exactly ${m(total)} to:\n\n${accountNumber}\n${bankName}\n${accountName}\n\n` +
      (minutes ? `This account number works for ${minutes} minutes. ` : '') +
      'You can pay from any bank app, Opay, Moniepoint or PalmPay. We\'ll confirm the moment it lands.' +
      (testMode ? '\n\nTEST MODE: no real money. Reply "paid" to pretend you made the transfer.' : ''),
    buttons: [{ id: `newacct:${code}`, title: 'New account number' }],
  }),
  paymentPartial: (paid: Money, due: Money): Outbound => ({
    kind: 'text',
    text: `We received ${m(paid)}, but the total is ${m(due)}. Your money is safe with us. A person from Hoolam will contact you to sort it out.`,
  }),
  buyerFunded: (total: Money, code: string): Outbound => ({
    kind: 'text',
    text: `Received ${m(total)}. Your money is safe with Hoolam.\n\nWe've told the seller to send your item. Nothing moves until you say you're happy. (Deal ${code})`,
  }),

  // ----- seller ships -----
  sellerFunded: (code: string, yours: Money): Outbound => ({
    kind: 'buttons',
    text: `Good news: the buyer has paid for deal ${code}. Your ${m(yours)} is held safely by Hoolam.\n\nShip the item now, then tap below.`,
    buttons: [{ id: `shipped:${code}`, title: 'I\'ve sent it' }],
  }),
  sellerShippedOk: (code: string): Outbound => ({
    kind: 'buttons',
    text: `📦 Thanks. We've told the buyer that deal ${code} is on the way.\n\nWant to add proof? Send a photo of the package or receipt, or type a tracking number. It protects you if there's a problem.`,
    buttons: [{ id: `noproof:${code}`, title: 'No thanks' }],
  }),
  shippingProofSaved: (code: string): Outbound => withMenu(`✅ Proof saved for deal ${code} and shown to the buyer.`),
  buyerShippingNote: (code: string, note: string): Outbound => ({ kind: 'text', text: `📦 From the seller, about deal ${code}:\n\n${note}` }),
  buyerShipped: (code: string): Outbound => ({
    kind: 'buttons',
    text: `Your item for deal ${code} is on the way.\n\nWhen it arrives, open it and check it. Then tell us:`,
    buttons: [{ id: `happy:${code}`, title: 'I\'m happy' }, { id: `problem:${code}`, title: 'Problem' }],
  }),
  buyerNudge: (code: string): Outbound => ({
    kind: 'buttons',
    text: `Has your item for deal ${code} arrived? Your money is still safe with us.`,
    buttons: [{ id: `happy:${code}`, title: 'I\'m happy' }, { id: `problem:${code}`, title: 'Problem' }],
  }),

  // ----- release -----
  buyerReleased: (code: string): Outbound => withMenu(`Done. We're paying the seller now. Thanks for trading safely. (Deal ${code})`),
  sellerPaid: (code: string, amount: Money, bankName: string): Outbound => withMenu(`You've been paid. ${m(amount)} has been sent to your ${bankName} account for deal ${code}.`),
  sellerPayoutDelayed: (code: string): Outbound => ({
    kind: 'text', text: `The buyer is happy with deal ${code}. Your payout is being processed and should arrive shortly.`,
  }),

  // ----- problems -----
  askProblem: (code: string): Outbound => ({
    kind: 'text',
    text: `Sorry about that. Your money is frozen and safe.\n\nTell us what's wrong with deal ${code}. You can type it or send a photo.`,
  }),
  askRefundBank: (): Outbound => ({
    kind: 'text',
    text: 'If we need to refund you, where should the money go? Send your account number and bank, like: 0123456789 Opay',
  }),
  problemLogged: (code: string, ref: string): Outbound => withMenu(`Got it. Case ${ref} is open for deal ${code}. A real person will reply within 24 hours. The money stays frozen until it's sorted.`),
  sellerProblem: (code: string): Outbound => ({
    kind: 'text',
    text: `The buyer reported a problem with deal ${code}. The money is frozen while a person from Hoolam looks into it. We may contact you.`,
  }),
  buyerRefunded: (code: string, amount: Money, bankName: string): Outbound => withMenu(`Your refund of ${m(amount)} for deal ${code} has been sent to your ${bankName} account.`),
  sellerRefunded: (code: string): Outbound => ({ kind: 'text', text: `Deal ${code} was refunded to the buyer after review.` }),

  // ----- misc -----
  cancelled: (code: string): Outbound => withMenu(`Deal ${code} is cancelled. No money moved.`),
  sellerBuyerCancelled: (code: string): Outbound => ({ kind: 'text', text: `The buyer cancelled deal ${code}. No money moved.` }),
  sellerBuyerJoined: (code: string): Outbound => ({ kind: 'text', text: `Your buyer opened deal ${code}. We'll tell you as soon as they pay.` }),
  notAllowed: (): Outbound => ({ kind: 'text', text: 'That step isn\'t available for this deal right now.' }),
  dealsList: (lines: string[]): Outbound => lines.length
    ? withMenu(`Your recent deals:\n\n${lines.join('\n')}`)
    : { kind: 'buttons', text: 'You have no deals yet.', buttons: [{ id: 'menu:sell', title: 'Sell something' }, { id: 'menu:open', title: 'Main menu' }] },
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
