/**
 * Every picture, voice note, video and sticker the chat can send, in one list. Console → Settings → WhatsApp →
 * "Chat pictures and voice" shows them, folded, with a preview, Replace and Back to default.
 *  - picture: drawn once by Hoolam; the owner can replace it with their own design.
 *  - card: drawn fresh for each order (amounts, names, photos); the owner can upload a background, the words go on top.
 *  - voice / video: nothing is sent until the owner uploads one. Each comes with a short script or shot list.
 *  - sticker: drawn by Hoolam; replaceable (512 × 512 WebP or PNG).
 * `once`: voice notes and videos go only the first time a person reaches that moment.
 */
export type SlotKind = 'picture' | 'card' | 'voice' | 'video' | 'sticker';
export interface Slot {
  id: string; kind: SlotKind; title: string; when: string;
  size?: string;            // what to design to, for pictures and cards
  script?: string[];        // voice: the words to say; video: the shots, one per line
  length?: string;          // voice/video: how long
}

export const SLOTS: Slot[] = [
  // ----- pictures (fixed) -----
  { id: 'how-it-works', kind: 'picture', title: 'How it works', when: 'The welcome, How it works, and the Buy / Sell forms', size: '1600 × 900' },
  { id: 'status-1', kind: 'picture', title: 'Order step 1: Sent', when: 'An order is sent to the other side', size: '1600 × 900' },
  { id: 'status-2', kind: 'picture', title: 'Order step 2: Waiting for payment', when: 'The order is accepted; the buyer is asked to pay', size: '1600 × 900' },
  { id: 'status-3', kind: 'picture', title: 'Order step 3: Money held', when: 'Order status, when the money is held', size: '1600 × 900' },
  { id: 'status-4', kind: 'picture', title: 'Order step 4: On the way', when: 'The item is dispatched', size: '1600 × 900' },
  { id: 'status-5', kind: 'picture', title: 'Order step 5: Check it', when: 'The item is handed over', size: '1600 × 900' },
  { id: 'status-6', kind: 'picture', title: 'Order step 6: Paid out', when: 'Order status, when it is done', size: '1600 × 900' },
  { id: 'id-check', kind: 'picture', title: 'ID check', when: 'Before someone checks their BVN or NIN', size: '1600 × 900' },
  { id: 'code-where', kind: 'picture', title: 'Where the order code is', when: '"I have an order code"', size: '1600 × 900' },
  { id: 'sample-trust', kind: 'picture', title: 'Sample trust card', when: 'Setting up as a seller', size: '1600 × 900' },
  { id: 'photo-tips', kind: 'picture', title: 'Good vs poor photo', when: 'Asking a seller or ambassador for their photo', size: '1600 × 900' },
  { id: 'real-hoolam', kind: 'picture', title: 'This is really Hoolam', when: 'Someone\'s first message, with "Save Hoolam"', size: '1080 × 1080' },
  { id: 'rider', kind: 'picture', title: 'Rider delivery', when: 'The delivery message to a rider or driver', size: '1600 × 900' },
  { id: 'amb-intro', kind: 'picture', title: 'Become an ambassador', when: 'The ambassador intro (shows the live shares)', size: '1600 × 900' },

  // ----- live cards -----
  { id: 'card-money-held', kind: 'card', title: 'Money held', when: 'The buyer has paid (to both sides)', size: '1080 × 1080' },
  { id: 'card-payment', kind: 'card', title: 'How to pay', when: 'The account number to pay into', size: '1080 × 1080' },
  { id: 'card-handover', kind: 'card', title: 'Handover code', when: 'The buyer\'s 4-digit code, at dispatch', size: '1080 × 1080' },
  { id: 'card-paid', kind: 'card', title: 'You\'ve been paid', when: 'A seller\'s payout, a payout waiting for an ID check, an ambassador\'s payout', size: '1080 × 1080' },
  { id: 'card-refund', kind: 'card', title: 'Refund sent', when: 'Money back to the buyer', size: '1080 × 1080' },
  { id: 'card-frozen', kind: 'card', title: 'Money frozen', when: 'A problem is reported (to both sides)', size: '1080 × 1080' },
  { id: 'card-summary', kind: 'card', title: 'Order summary', when: 'Checking an order, a new order request, a new order for a buyer', size: '1600 × 900' },
  { id: 'card-trust', kind: 'card', title: 'Trust card', when: 'Before paying, Check a seller, My trust card', size: '1600 × 900' },
  { id: 'card-trust-status', kind: 'card', title: 'Trust card for status', when: 'A seller shares their page (9:16 for WhatsApp status)', size: '1080 × 1920' },
  { id: 'card-complete', kind: 'card', title: 'Order complete', when: 'The buyer taps I\'m happy', size: '1080 × 1080' },
  { id: 'card-fees', kind: 'card', title: 'Fees', when: 'Fees (from the menu)', size: '1080 × 1080' },
  { id: 'card-amb-month', kind: 'card', title: 'Ambassador month', when: 'An ambassador\'s month summary', size: '1080 × 1350' },
  { id: 'card-amb-welcome', kind: 'card', title: 'Ambassador welcome', when: 'An ambassador goes live', size: '1080 × 1080' },

  // ----- voice notes -----
  { id: 'voice-how', kind: 'voice', title: 'How Hoolam works', when: 'Under How it works', length: '25 s', script: [
    'Hi, welcome to Hoolam.',
    'When you buy, you don\'t pay the seller directly. You pay Hoolam, and we hold the money.',
    'The seller sends your item. You check it. When you\'re happy, we pay the seller.',
    'If it never comes, you get your money back. No more "pay first and pray".',
  ] },
  { id: 'voice-first-pay', kind: 'voice', title: 'Before your first payment', when: 'A buyer\'s first payment, with the account number (first time only)', length: '20 s', script: [
    'Quick one before you pay.',
    'The account number is for this order only, and the money goes to Hoolam, not the seller.',
    'We hold it safely until you have your item and you\'re happy.',
    'If anything goes wrong, just tap Problem, and the money stays frozen.',
  ] },
  { id: 'voice-seller-held', kind: 'voice', title: 'Your buyer has paid', when: 'A seller\'s first paid order (first time only)', length: '20 s', script: [
    'Good news. Your buyer has paid, and the money is with Hoolam.',
    'This is not a bank alert that can be faked. It\'s Hoolam confirming the money is here.',
    'Send the item now. Once your buyer is happy, the money comes straight to your account.',
  ] },
  { id: 'voice-handover', kind: 'voice', title: 'The handover code', when: 'A buyer\'s first dispatched order (first time only)', length: '20 s', script: [
    'Your item is on the way, and you have a 4-digit code.',
    'Give it to the rider only when the item is in your hands. Not before.',
    'The code tells Hoolam you\'ve received it. If something is wrong, tap Problem and keep your code.',
  ] },
  { id: 'voice-first-payout', kind: 'voice', title: 'Your first payout', when: 'A seller\'s first payout (first time only)', length: '15 s', script: [
    'Congratulations on your first safe sale with Hoolam!',
    'Your money is on its way to your account.',
    'Every order you complete makes your trust card stronger, so share it with your buyers. Well done.',
  ] },
  { id: 'voice-id-check', kind: 'voice', title: 'Why we check your ID', when: 'Before someone\'s first ID check (first time only)', length: '20 s', script: [
    'We check your ID once, through Prembly, a licensed ID checker.',
    'We keep only the result, never your BVN or NIN.',
    'Hoolam will never call or message you to ask for your PIN, OTP or password. If anyone does, it\'s not us.',
  ] },

  // ----- videos (for later) -----
  { id: 'video-how', kind: 'video', title: 'How Hoolam works', when: 'Under How it works', length: '20 s', script: [
    'A buyer taps Pay in WhatsApp.',
    'The "Money held" card appears. Caption: You pay Hoolam.',
    'A rider hands over a parcel. Caption: We hold it.',
    'The buyer opens it, smiles, taps I\'m happy. Caption: You check it.',
    'The seller\'s phone shows "You\'ve been paid". Caption: Seller gets paid.',
  ] },
  { id: 'video-pay', kind: 'video', title: 'How to pay', when: 'A buyer\'s first payment (first time only)', length: '15 s', script: [
    'Long-press the account number to copy it.',
    'Open any bank app (blur the logo) and paste it.',
    'The account name shows. Send.',
    'Back in WhatsApp, the "Money held" card arrives.',
  ] },
  { id: 'video-handover', kind: 'video', title: 'The handover code', when: 'A buyer\'s and a seller\'s first dispatch (first time only)', length: '20 s', script: [
    'Caption at the start: Item first. Code after.',
    'A rider arrives with a parcel.',
    'The buyer takes it and checks it.',
    'Only then the buyer reads the 4 digits from their phone.',
    'The rider types it; "Delivery confirmed" shows on the rider\'s phone.',
  ] },
  { id: 'video-seller', kind: 'video', title: 'How it works for sellers', when: 'A seller\'s first order request (first time only)', length: '30 s', script: [
    'A seller taps Sell something and types the item and price.',
    'The buyer pays; "Paid and held" arrives.',
    'The seller sends the parcel.',
    '"You\'ve been paid" arrives with the amount.',
    'Caption at the end: No fake alerts. No refused deliveries.',
  ] },
  { id: 'video-amb-status', kind: 'video', title: 'Ambassador status video', when: 'Share my link (ambassadors)', length: '15 s', script: [
    'Caption: Tired of "pay first and pray"?',
    'Show the Money held card on a phone.',
    'Caption: Use Hoolam. Your money is held until you get your item.',
    'End on the ambassador\'s link on screen.',
  ] },

  // ----- stickers -----
  { id: 'sticker-held', kind: 'sticker', title: 'Held', when: 'Not used yet (spare)', size: '512 × 512' },
  { id: 'sticker-paid', kind: 'sticker', title: 'Paid!', when: 'A rider\'s fee is sent; an ambassador is paid', size: '512 × 512' },
  { id: 'sticker-welldone', kind: 'sticker', title: 'Well done', when: 'Someone joins with an ambassador\'s link; a seller bonus', size: '512 × 512' },
  { id: 'sticker-thanks', kind: 'sticker', title: 'Thank you', when: 'A buyer rates a seller', size: '512 × 512' },
  { id: 'sticker-verified', kind: 'sticker', title: 'Verified', when: 'Someone\'s ID check passes', size: '512 × 512' },
];

export const slot = (id: string) => SLOTS.find((s) => s.id === id);
export const ACCEPT: Record<SlotKind, RegExp> = {
  picture: /^image\/(jpeg|png|webp)$/, card: /^image\/(jpeg|png|webp)$/, sticker: /^image\/(webp|png)$/,
  voice: /^audio\/(ogg|mpeg|mp4|aac|amr)$/, video: /^video\/(mp4|3gpp|quicktime)$/,
};
export const MAX_BYTES: Record<SlotKind, number> = { picture: 5_000_000, card: 5_000_000, sticker: 500_000, voice: 16_000_000, video: 16_000_000 };
