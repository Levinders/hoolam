import { formatMoney, type Currency } from '../money.js';
import type { Outbound } from './client.js';

// Every message Hoolam sends, in one place. Plain words, short lines, and always answer
// the quiet question underneath: "where is my money right now?"

type Money = { minor: number; currency: Currency };
const m = (x: Money) => formatMoney(x.minor, x.currency);

export const msg = {
  menu: (name: string | null): Outbound => ({
    kind: 'buttons',
    text: `Hi${name ? ' ' + name.split(' ')[0] : ''}, welcome to Hoolam.\n\nWe hold the money in the middle until the buyer is happy. Nobody gets burned.\n\nWhat would you like to do?`,
    buttons: [
      { id: 'menu:sell', title: 'Sell something' },
      { id: 'menu:deals', title: 'My deals' },
      { id: 'menu:help', title: 'How it works' },
    ],
  }),

  help: (): Outbound => ({
    kind: 'text',
    text:
      'How Hoolam works:\n\n' +
      '1. The seller creates a deal here and sends the buyer a link.\n' +
      '2. The buyer pays. We hold the money.\n' +
      '3. The seller ships. The money is already safe.\n' +
      '4. The buyer checks the item and taps "I\'m happy".\n' +
      '5. We pay the seller.\n\n' +
      'Something wrong? Tap "Problem" and the money stays frozen until we sort it out.\n\n' +
      'Buying? Ask the seller for their Hoolam link.',
  }),

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
  dealCreated: (code: string, link: string): Outbound => ({
    kind: 'text',
    text:
      `Your deal ${code} is ready.\n\nSend this link to your buyer:\n${link}\n\n` +
      'When they pay, we\'ll tell you right away. Don\'t ship before then.',
  }),

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
  payInstructions: (total: Money, accountNumber: string, bankName: string, accountName: string, minutes: number | null, code: string): Outbound => ({
    kind: 'buttons',
    text:
      `Transfer exactly ${m(total)} to:\n\n${accountNumber}\n${bankName}\n${accountName}\n\n` +
      (minutes ? `This account number works for ${minutes} minutes. ` : '') +
      'You can pay from any bank app, Opay, Moniepoint or PalmPay. We\'ll confirm the moment it lands.',
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
  buyerReleased: (code: string): Outbound => ({ kind: 'text', text: `Done. We're paying the seller now. Thanks for trading safely. (Deal ${code})` }),
  sellerPaid: (code: string, amount: Money, bankName: string): Outbound => ({
    kind: 'text', text: `You've been paid. ${m(amount)} has been sent to your ${bankName} account for deal ${code}.`,
  }),
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
  problemLogged: (code: string, ref: string): Outbound => ({
    kind: 'text',
    text: `Got it. Case ${ref} is open for deal ${code}. A real person will reply within 24 hours. The money stays frozen until it's sorted.`,
  }),
  sellerProblem: (code: string): Outbound => ({
    kind: 'text',
    text: `The buyer reported a problem with deal ${code}. The money is frozen while a person from Hoolam looks into it. We may contact you.`,
  }),
  buyerRefunded: (code: string, amount: Money, bankName: string): Outbound => ({
    kind: 'text', text: `Your refund of ${m(amount)} for deal ${code} has been sent to your ${bankName} account.`,
  }),
  sellerRefunded: (code: string): Outbound => ({ kind: 'text', text: `Deal ${code} was refunded to the buyer after review.` }),

  // ----- misc -----
  cancelled: (code: string): Outbound => ({ kind: 'text', text: `Deal ${code} is cancelled. No money moved.` }),
  sellerBuyerCancelled: (code: string): Outbound => ({ kind: 'text', text: `The buyer cancelled deal ${code}. No money moved.` }),
  sellerBuyerJoined: (code: string): Outbound => ({ kind: 'text', text: `Your buyer opened deal ${code}. We'll tell you as soon as they pay.` }),
  notAllowed: (): Outbound => ({ kind: 'text', text: 'That step isn\'t available for this deal right now.' }),
  dealsList: (lines: string[]): Outbound => ({ kind: 'text', text: lines.length ? `Your recent deals:\n\n${lines.join('\n')}` : 'You have no deals yet. Tap "Sell something" to start one.' }),
  didntUnderstand: (): Outbound => ({ kind: 'text', text: 'Sorry, I didn\'t get that. Type "menu" to see what you can do.' }),
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
