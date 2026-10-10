import { createHash } from 'node:crypto';
import { CATEGORIES } from '../deals/categories.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE BUYER'S AND SELLER'S FORMS (WhatsApp Flows).
 * Buyer (three screens, every field required):
 *   1. ITEM:     banner, item name, description, category, agreed price, seller's WhatsApp
 *   2. DELIVERY: delivery with a fee / free delivery / pickup, the fee (only if there is one), the date they need it
 *   3. PHOTOS:   1 to 3 photos (gallery or camera), then "Review my order"
 * Seller (two screens): the item, price and buyer's WhatsApp (optional), then up to 3 photos (optional).
 * WhatsApp shows it in its own style; our branding is the banner image and the words.
 * Static form: no server endpoint. The answers arrive in the webhook when the buyer taps "Review my order".
 *
 * Changing anything here creates a new form on Meta automatically (the name includes a hash of this JSON).
 * WhatsApp limits: labels 20 characters, helper text 30, footer button 35.
 */
const BANNER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'buy-banner.png');

type Kind = 'buy' | 'sell';

/** Both forms share one shape: details screen, then photos. */
function dealFlowJson(kind: Kind, bannerBase64: string) {
  const buy = kind === 'buy';
  const fields = buy
    ? [
        { type: 'TextSubheading', text: 'What are you buying?' },
        { type: 'TextInput', name: 'item', label: 'Item', 'input-type': 'text', required: true, 'max-chars': 150, 'helper-text': 'e.g. Black sneakers, size 42' },
        { type: 'TextInput', name: 'price', label: 'Agreed price (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'helper-text': 'e.g. 15000 or 15k' },
        { type: 'TextInput', name: 'other_phone', label: 'Seller\'s WhatsApp', 'input-type': 'phone', required: false, 'helper-text': 'Optional. We\'ll alert them' },
        { type: 'DatePicker', name: 'arrive_by', label: 'When should it arrive? (optional)', required: false },
      ]
    : [
        { type: 'TextSubheading', text: 'What are you selling?' },
        { type: 'TextInput', name: 'item', label: 'Item', 'input-type': 'text', required: true, 'max-chars': 150, 'helper-text': 'e.g. Black sneakers, size 42' },
        { type: 'TextInput', name: 'price', label: 'Price (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'helper-text': 'e.g. 15000 or 15k' },
        { type: 'TextInput', name: 'other_phone', label: 'Buyer\'s WhatsApp', 'input-type': 'phone', required: false, 'helper-text': 'Optional. We\'ll alert them' },
      ];
  const carried: Record<string, string> = { item: '${form.item}', price: '${form.price}', other_phone: '${form.other_phone}', ...(buy ? { arrive_by: '${form.arrive_by}' } : {}) };
  const data: Record<string, unknown> = {
    item: { type: 'string', __example__: 'Black sneakers, size 42' },
    // text, not a number field: WhatsApp hands a number field to the next screen as text on some phones and the form
    // then stops with "should be of type number". Text also lets people type 15k or 15,000; the server reads all of them.
    price: { type: 'string', __example__: '15000' },
    other_phone: { type: 'string', __example__: '08012345678' },
    ...(buy ? { arrive_by: { type: 'string', __example__: '2026-10-09' } } : {}),
  };
  const done: Record<string, string> = { ...Object.fromEntries(Object.keys(carried).map((k) => [k, `\${data.${k}}`])), photos: '${form.photos}' };
  return {
    version: '7.3',
    screens: [
      {
        id: 'ITEM',
        title: buy ? 'Buy safely' : 'Sell safely',
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'Image', src: bannerBase64, height: 120, 'scale-type': 'cover', 'alt-text': 'Hoolam: paid safely, or not at all' },
            {
              type: 'Form', name: 'form',
              children: [
                ...fields,
                { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'PHOTOS' }, payload: carried } },
              ],
            },
          ],
        },
      },
      {
        id: 'PHOTOS',
        title: 'Add photos',
        terminal: true,
        data,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '📷 Photos of the item' },
            {
              type: 'TextBody',
              text: buy
                ? 'Optional. A screenshot of the seller\'s post works. It\'s your proof of what was promised.'
                : 'Optional, but buyers trust real photos. They\'re also your proof of what you sold.',
            },
            {
              type: 'Form', name: 'form',
              children: [
                {
                  type: 'PhotoPicker', name: 'photos', label: 'Add up to 3 photos',
                  description: buy ? 'We only show them to the seller and to our team if there\'s a problem.' : 'We show them to the buyer before they pay.',
                  'photo-source': 'camera_gallery', 'max-file-size-kb': 25600, /* gallery photos are often over 5 MB; the server shrinks them */ 'min-uploaded-photos': 0, 'max-uploaded-photos': 3,
                },
                { type: 'TextCaption', text: buy ? '💡 Nothing to pay yet. You pay after the seller accepts.' : '💡 The buyer pays Hoolam. You get paid when they\'re happy.' },
                { type: 'Footer', label: 'Review my order', 'on-click-action': { name: 'complete', payload: done } },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** The buyer's form: three short screens, every answer required. */
function buyerFlowJson(bannerBase64: string) {
  const ex = (v: string) => ({ type: 'string', __example__: v });
  const itemData = { item: ex('Nike Air Force 1'), description: ex('White, size 43, new in box'), category: ex('shoes'), price: ex('45000'), other_phone: ex('08012345678') };
  const fromItem = Object.fromEntries(Object.keys(itemData).map((k) => [k, `\${data.${k}}`]));
  const deliveryData = { ...itemData, delivery: ex('paid'), delivery_fee: ex('2500'), arrive_by: ex('2026-10-20') };
  return {
    version: '7.3',
    screens: [
      {
        id: 'ITEM',
        title: 'Buy safely',
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'Image', src: bannerBase64, height: 120, 'scale-type': 'cover', 'alt-text': 'Hoolam: paid safely, or not at all' },
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextSubheading', text: 'What are you buying?' },
                { type: 'TextInput', name: 'item', label: 'Item name', 'input-type': 'text', required: true, 'max-chars': 80, 'helper-text': 'e.g. Nike Air Force 1' },
                { type: 'TextArea', name: 'description', label: 'Describe it', required: true, 'max-length': 600, 'helper-text': 'Size, colour, model, condition' },
                { type: 'Dropdown', name: 'category', label: 'Category', required: true, 'data-source': CATEGORIES.map((c) => ({ id: c.id, title: c.title })) },
                { type: 'TextInput', name: 'price', label: 'Agreed price (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'helper-text': 'e.g. 15000 or 15k' },
                { type: 'TextInput', name: 'other_phone', label: 'Seller\'s WhatsApp', 'input-type': 'phone', required: true, 'helper-text': 'We\'ll send them your order' },
                {
                  type: 'Footer', label: 'Continue',
                  'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'DELIVERY' }, payload: Object.fromEntries(Object.keys(itemData).map((k) => [k, `\${form.${k}}`])) },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'DELIVERY',
        title: 'Delivery',
        data: itemData,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextSubheading', text: 'How will you get it?' },
                {
                  type: 'RadioButtonsGroup', name: 'delivery', label: 'Delivery or pickup', required: true,
                  'data-source': [
                    { id: 'paid', title: 'Delivery, with a fee' },
                    { id: 'free', title: 'Free delivery' },
                    { id: 'pickup', title: 'I\'ll pick it up' },
                  ],
                },
                {
                  type: 'If', condition: "${form.delivery} == 'paid'",
                  then: [{ type: 'TextInput', name: 'delivery_fee', label: 'Delivery fee (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'helper-text': 'Paid to the seller with it' }],
                },
                { type: 'DatePicker', name: 'arrive_by', label: 'When do you need it?', required: true, 'helper-text': 'Delivery or pickup date' },
                {
                  type: 'Footer', label: 'Continue',
                  'on-click-action': {
                    name: 'navigate', next: { type: 'screen', name: 'PHOTOS' },
                    payload: { ...fromItem, delivery: '${form.delivery}', delivery_fee: '${form.delivery_fee}', arrive_by: '${form.arrive_by}' },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'PHOTOS',
        title: 'Add photos',
        terminal: true,
        data: deliveryData,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '📷 Photos of the item' },
            { type: 'TextBody', text: 'A screenshot of the seller\'s post works. It\'s your proof of what was promised.' },
            {
              type: 'Form', name: 'form',
              children: [
                {
                  type: 'PhotoPicker', name: 'photos', label: 'Add 1 to 3 photos',
                  description: 'From your gallery or camera. Only the seller and our team see them.',
                  'photo-source': 'camera_gallery', 'max-file-size-kb': 25600, 'min-uploaded-photos': 1, 'max-uploaded-photos': 3,
                },
                { type: 'TextCaption', text: '💡 Nothing to pay yet. You pay after the seller accepts.' },
                {
                  type: 'Footer', label: 'Review my order',
                  'on-click-action': { name: 'complete', payload: { ...Object.fromEntries(Object.keys(deliveryData).map((k) => [k, `\${data.${k}}`])), photos: '${form.photos}' } },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

const banner = () => readFileSync(BANNER).toString('base64');
export function buyFlowJson(bannerBase64 = banner()) { return buyerFlowJson(bannerBase64); }
export function sellFlowJson(bannerBase64 = banner()) { return dealFlowJson('sell', bannerBase64); }

/** The form's name on Meta. Changes whenever the form changes, because published forms can't be edited. */
export function buyFlowName(json: object = buyFlowJson()): string {
  return 'hoolam_buy_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
}
export function sellFlowName(json: object = sellFlowJson()): string {
  return 'hoolam_sell_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
}

/** Reads a submitted form. Anything missing or odd comes back null and the chat asks for it. */
export function readBuyForm(form: Record<string, unknown>) {
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const photos = Array.isArray(form.photos)
    ? (form.photos as { id?: string; media_id?: string; mime_type?: string }[])
        .map((p) => ({ mediaId: String(p.id ?? p.media_id ?? ''), mimeType: p.mime_type ?? null }))
        .filter((p) => p.mediaId)
    : [];
  const date = str(form.arrive_by);
  const delivery = str(form.delivery);
  return {
    description: str(form.description) || null,
    category: str(form.category) || null,
    delivery: delivery === 'pickup' ? 'PICKUP' as const : delivery === 'paid' || delivery === 'free' ? 'DELIVERY' as const : null,
    deliveryFee: delivery === 'paid' ? str(form.delivery_fee) || null : null,
    deliveryPaid: delivery === 'paid',
    item: str(form.item) || null,
    price: str(form.price) || null,
    otherPhone: str(form.other_phone ?? form.seller_phone ?? form.buyer_phone) || null,
    arriveBy: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : /^\d{12,13}$/.test(date) ? new Date(Number(date)).toISOString().slice(0, 10) : null,
    photos,
  };
}
