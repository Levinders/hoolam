import { formatMoney, type Currency } from '../money.js';
import type { ListSection, Outbound } from './client.js';

// Every message Hoolam sends, in one place. Plain words, short lines, and always answer
// the quiet question underneath: "where is my money right now?"

type Money = { minor: number; currency: Currency };
const m = (x: Money) => formatMoney(x.minor, x.currency);

/**
 * THE MAIN MENU. To add an option: add a row here (title up to 24 characters, description up to 72),
 * then handle its id in flow.ts (look for "case 'menu'"). WhatsApp allows 10 rows in total.
 */
export const MENU: ListSection[] = [
  {
    title: 'Selling',
    rows: [
      { id: 'menu:sell', title: 'Sell something', description: 'Create a protected deal and get a link for your buyer' },
      { id: 'menu:deals', title: 'My deals', description: 'See your deals and where the money is' },
      { id: 'menu:account', title: 'My payout account', description: 'See or change where we pay you' },
    ],
  },
  {
    title: 'Buying',
    rows: [
      { id: 'menu:pay', title: 'Pay for a deal', description: 'Have a deal code from a seller? Start here' },
      { id: 'menu:problem', title: 'Report a problem', description: 'Something wrong with your item? We freeze the money' },
    ],
  },
  {
    title: 'Help',
    rows: [
      { id: 'menu:how', title: 'How Hoolam works', description: 'The 5 steps, in plain words' },
      { id: 'menu:fees', title: 'Fees', description: 'What it costs and who pays' },
      { id: 'menu:human', title: 'Talk to a person', description: 'A real person replies within 24 hours' },
    ],
  },
];

/** A message with a "Main menu" button under it, so nobody is left at a dead end. */
const withMenu = (text: string): Outbound => ({ kind: 'buttons', text, buttons: [{ id: 'menu:open', title: 'Main menu' }] });

export const msg = {
  /** The main menu. Edit MENU below to add, remove or reword options. */
  menu: (name: string | null): Outbound => ({
    kind: 'list',
    text: `Hi${name ? ' ' + name.split(' ')[0] : ''}, welcome to Hoolam.\n\nWe hold the money in the middle until the buyer is happy. Nobody gets burned.\n\nTap "Open menu" to see what you can do.`,
    button: 'Open menu',
    sections: MENU,
  }),

  help: (): Outbound => withMenu(
    'How Hoolam works:\n\n' +
    '1. The seller creates a deal here and sends the buyer a link.\n' +
    '2. The buyer pays. We hold the money.\n' +
    '3. The seller ships. The money is already safe.\n' +
    '4. The buyer checks the item and taps "I\'m happy".\n' +
    '5. We pay the seller.\n\n' +
    'Something wrong? Tap "Problem" and the money stays frozen until we sort it out.\n\n' +
    'Buying? Ask the seller for their Hoolam link or deal code.',
  ),

  fees: (rules: string, examples: string[], maxDeal: Money): Outbound => withMenu(
    `Hoolam fees:\n\n${rules}\n\nExamples:\n${examples.join('\n')}\n\nFor now, one deal can be up to ${m(maxDeal)}. No fee if a deal is cancelled before payment.`,
  ),

  // ----- buyer starts from the menu -----
  askDealCode: (): Outbound => ({ kind: 'text', text: 'Send the deal code the seller gave you. It looks like this: HL-7K2QF' }),
  badDealCode: (): Outbound => withMenu('That doesn\'t look like a deal code. It starts with HL-, like HL-7K2QF. Please check with the seller and send it again.'),

  // ----- problems from the menu -----
  noDealsToReport: (): Outbound => ({
    kind: 'buttons',
    text: 'You don\'t have a paid deal that\'s still open, so there\'s nothing to freeze right now.\n\nFor anything else, you can talk to a person.',
    buttons: [{ id: 'menu:human', title: 'Talk to a person' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  pickDealForProblem: (rows: { code: string; item: string }[]): Outbound => ({
    kind: 'list',
    text: 'Which deal has a problem? The money for it will stay frozen while we look into it.',
    button: 'Choose deal',
    sections: [{ title: 'Your paid deals', rows: rows.slice(0, 10).map((r) => ({ id: `problem:${r.code}`, title: r.code, description: r.item.slice(0, 72) })) }],
  }),

  // ----- payout account -----
  accountInfo: (accountName: string, bankName: string, last4: string): Outbound => ({
    kind: 'buttons',
    text: `We pay you here:\n\n${accountName}\n${bankName} ••••${last4}`,
    buttons: [{ id: 'account:change', title: 'Change account' }, { id: 'menu:open', title: 'Main menu' }],
  }),
  askNewAccount: (): Outbound => ({ kind: 'text', text: 'Send the new account number and bank.\n\nFor example: 0123456789 GTBank' }),
  accountSaved: (bankName: string, last4: string): Outbound => withMenu(`Saved. New deals will be paid to ${bankName} ••••${last4}.\n\nDeals already running keep the account they started with.`),

  // ----- talk to a person -----
  askHumanMessage: (): Outbound => ({ kind: 'text', text: 'Type your message for the Hoolam team. You can also send a photo. A real person will reply here within 24 hours.' }),
  humanLogged: (ref: string): Outbound => withMenu(`Thanks. Your message is with the team (ref ${ref}). A real person will reply here within 24 hours.`),

  testNothingToPay: (): Outbound => ({ kind: 'text', text: 'TEST MODE: there is no payment waiting. Open a deal link and tap "Pay now" first.' }),
  voiceSoon: (): Outbound => ({ kind: 'text', text: 'Voice notes are coming soon. For now, please type your answer.' }),

  // ----- seller creates a deal -----
  askItem: (): Outbound => ({ kind: 'text', text: 'What are you selling? (For example: 2 pairs of sneakers, size 42)' }),
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
  confirmDeal: (item: string, price: Money, fee: Money, buyerPays: Money, sellerGets: Money): Outbound => ({
    kind: 'buttons',
    text:
      `Check your deal:\n\n${item}\nPrice: ${m(price)}\n` +
      `Hoolam fee: ${m(fee)}\n\n` +
      `The buyer pays ${m(buyerPays)}.\nYou receive ${m(sellerGets)}.`,
    buttons: [{ id: 'sell:confirm', title: 'Create deal' }, { id: 'sell:restart', title: 'Start again' }],
  }),
  dealCreated: (code: string, link: string): Outbound => withMenu(
    `Your deal ${code} is ready.\n\nSend this link to your buyer:\n${link}\n\n` +
    'When they pay, we\'ll tell you right away. Don\'t ship before then.',
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
      `Price: ${m(price)}\nHoolam fee: ${m(fee)}\nYou pay: ${m(total)}\n\n` +
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
  sellerShippedOk: (code: string): Outbound => ({ kind: 'text', text: `Thanks. We've told the buyer that deal ${code} is on the way.` }),
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
