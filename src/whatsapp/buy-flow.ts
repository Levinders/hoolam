import { createHash } from 'node:crypto';
import { CATEGORIES } from '../deals/categories.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE BUYER'S AND SELLER'S FORMS (WhatsApp Flows). The same three screens for both sides, mirrored:
 *   1. ITEM:     banner, item name, description, category, total price (delivery included)
 *   2. DELIVERY: buyer: delivery address, when they expect it, the seller's WhatsApp
 *                seller: the buyer's address (optional: the buyer adds or changes it when accepting), ready by, the buyer's WhatsApp
 *   3. PHOTOS:   1 to 3 photos (gallery or camera), then "Review my order"
 * WhatsApp shows it in its own style; our branding is the banner image and the words.
 * Static form: no server endpoint. The answers arrive in the webhook when they tap "Review my order".
 *
 * Changing anything here creates a new form on Meta automatically (the name includes a hash of this JSON).
 */
const BANNER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'buy-banner.png');

export type Side = 'buy' | 'sell';

/**
 * The form: three short screens. Buyer: every answer required. Seller: the same, except the buyer's address.
 * `edit`: the same form filled in with their answers (opened from "Edit order"); photos are optional there,
 * because the ones they already added are kept unless they add new ones.
 */
function orderFormJson(bannerBase64: string, edit = false, side: Side = 'buy') {
  const sell = side === 'sell';
  const ex = (v: string) => ({ type: 'string', __example__: v });
  const itemData = { item: ex('Nike Air Force 1'), description: ex('White, size 43, new in box'), category: ex('shoes'), price: ex('45000') };
  const later = { address: ex('12 Woji Road, Port Harcourt'), arrive_by: ex('2026-10-20'), other_phone: ex('08012345678') };
  const note = edit ? { photo_note: ex('You added 2 photos. They stay unless you add new ones here.') } : {};
  const deliveryData = { ...itemData, ...(edit ? later : {}), ...note };
  const photosData = { ...itemData, ...later, ...note };
  const carry = (keys: string[], from: 'form' | 'data') => Object.fromEntries(keys.map((k) => [k, `\${${from}.${k}}`]));
  const init = (k: string) => (edit ? { 'init-value': `\${data.${k}}` } : {});
  return {
    version: '7.3',
    screens: [
      {
        id: 'ITEM',
        title: edit ? 'Edit your order' : sell ? 'Sell safely' : 'Buy safely',
        data: edit ? photosData : {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'Image', src: bannerBase64, height: 120, 'scale-type': 'cover', 'alt-text': 'Hoolam: paid safely, or not at all' },
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextSubheading', text: edit ? 'Change what you need' : sell ? 'What are you selling?' : 'What are you buying?' },
                { type: 'TextInput', name: 'item', label: 'Item name', 'input-type': 'text', required: true, 'max-chars': 80, 'helper-text': 'e.g. Nike Air Force 1', ...init('item') },
                { type: 'TextArea', name: 'description', label: 'Description', required: true, 'max-length': 600, 'helper-text': 'Size, colour, model, condition', ...init('description') },
                { type: 'Dropdown', name: 'category', label: 'Category', required: true, 'data-source': CATEGORIES.map((c) => ({ id: c.id, title: c.title })), ...init('category') },
                { type: 'TextInput', name: 'price', label: 'Total price (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'helper-text': sell ? 'Delivery included, if any. e.g. 15000 or 15k' : 'The agreed price, delivery included if any. e.g. 15000 or 15k', ...init('price') },
                {
                  type: 'Footer', label: 'Continue',
                  'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'DELIVERY' }, payload: { ...carry(Object.keys(itemData), 'form'), ...(edit ? carry([...Object.keys(later), 'photo_note'], 'data') : {}) } },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'DELIVERY',
        title: 'Delivery',
        data: deliveryData,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextSubheading', text: 'Where and when?' },
                sell
                  ? { type: 'TextArea', name: 'address', label: 'Buyer\'s delivery address', required: false, 'max-length': 300, 'helper-text': 'If you know it. The buyer can add or change it', ...init('address') }
                  : { type: 'TextArea', name: 'address', label: 'Delivery address', required: true, 'max-length': 300, 'helper-text': 'Street, area and city', ...init('address') },
                { type: 'DatePicker', name: 'arrive_by', label: sell ? 'Ready by' : 'When are you expecting it?', required: true, ...(sell ? { 'helper-text': 'When it can be sent or picked up' } : {}), ...init('arrive_by') },
                { type: 'TextInput', name: 'other_phone', label: sell ? 'Buyer\'s WhatsApp' : 'Seller\'s WhatsApp', 'input-type': 'phone', required: true, 'helper-text': 'We\'ll send them your order', ...init('other_phone') },
                {
                  type: 'Footer', label: 'Continue',
                  'on-click-action': {
                    name: 'navigate', next: { type: 'screen', name: 'PHOTOS' },
                    payload: { ...carry(Object.keys(itemData), 'data'), ...carry(Object.keys(later), 'form'), ...(edit ? carry(['photo_note'], 'data') : {}) },
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
        data: photosData,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '📷 Photos of the item' },
            { type: 'TextBody', text: edit ? '${data.photo_note}' : sell ? 'Buyers trust real photos. They\'re also your proof of what you sold.' : 'A screenshot of the seller\'s post works. It\'s your proof of what was promised.' },
            {
              type: 'Form', name: 'form',
              children: [
                {
                  type: 'PhotoPicker', name: 'photos', label: 'Add pictures',
                  description: 'From your gallery or camera (max 25 MB)',
                  'photo-source': 'camera_gallery', 'max-file-size-kb': 25600, 'min-uploaded-photos': edit ? 0 : 1, 'max-uploaded-photos': 3,
                },
                { type: 'TextCaption', text: sell ? '💡 The buyer pays Hoolam first. You get paid when they\'re happy.' : '💡 Nothing to pay yet. You pay after the seller accepts.' },
                { type: 'Footer', label: 'Review my order', 'on-click-action': { name: 'complete', payload: { ...carry([...Object.keys(itemData), ...Object.keys(later)], 'data'), photos: '${form.photos}' } } },
              ],
            },
          ],
        },
      },
    ],
  };
}

const banner = () => readFileSync(BANNER).toString('base64');
export function buyFlowJson(bannerBase64 = banner()) { return orderFormJson(bannerBase64); }
export function buyEditFlowJson(bannerBase64 = banner()) { return orderFormJson(bannerBase64, true); }
export function sellFlowJson(bannerBase64 = banner()) { return orderFormJson(bannerBase64, false, 'sell'); }
export function sellEditFlowJson(bannerBase64 = banner()) { return orderFormJson(bannerBase64, true, 'sell'); }

/** The form's name on Meta. Changes whenever the form changes, because published forms can't be edited. */
export function buyFlowName(json: object = buyFlowJson()): string {
  return 'hoolam_buy_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
}
export function buyEditFlowName(json: object = buyEditFlowJson()): string {
  return 'hoolam_buyedit_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
}
export function sellFlowName(json: object = sellFlowJson()): string {
  return 'hoolam_sell_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
}
export function sellEditFlowName(json: object = sellEditFlowJson()): string {
  return 'hoolam_selledit_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
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
  return {
    description: str(form.description) || null,
    category: str(form.category) || null,
    address: str(form.address) || null,
    item: str(form.item) || null,
    price: str(form.price) || null,
    otherPhone: str(form.other_phone ?? form.seller_phone ?? form.buyer_phone) || null,
    arriveBy: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : /^\d{12,13}$/.test(date) ? new Date(Number(date)).toISOString().slice(0, 10) : null,
    photos,
  };
}
