import { withoutFormWrapper } from '../whatsapp/forms.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE MARKET'S WHATSAPP FORMS (static: no endpoint; the answers arrive in the webhook when the last button is tapped).
 *   LIST AN ITEM (2 screens): name, category, price, how many, details → photos, how buyers get it, where it is
 *     (WhatsApp only sends photos from the screen with the last button, so they're on the second screen).
 *     The check comes straight after, in the chat: the item's card with its real photo, then List it / Edit / Start again
 *     (a form can't show a photo picked a moment ago).
 *   EDIT ITEM (1 screen): price, promo price and how long, how many, delivery, details, filled in with what's there now.
 *   MARKET ORDER (1 screen): the delivery address and when they expect it, for an order from the market.
 * The chat asks the same questions whenever a form can't be used. A changed form gets a new name on Meta (hash).
 */
const BANNER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'buy-banner.png');
const banner = () => readFileSync(BANNER).toString('base64');
const ex = (v: string) => ({ type: 'string', __example__: v });
const carry = (keys: string[], from: 'form' | 'data') => Object.fromEntries(keys.map((k) => [k, `\${${from}.${k}}`]));
const OPTIONS = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } };

export const DELIVERY_CHOICES = [
  { id: 'pickup', title: 'Pickup', description: 'Buyers collect it from you' },
  { id: 'rider', title: 'Dispatch rider', description: 'Delivered in your city' },
  { id: 'waybill', title: 'Waybill', description: 'Sent to other states' },
];
export const PROMO_CHOICES = [
  { id: '0', title: 'No promo' },
  { id: '3', title: 'For 3 days' }, { id: '7', title: 'For a week' }, { id: '14', title: 'For 2 weeks' }, { id: '30', title: 'For a month' },
  { id: 'keep', title: 'Until I stop it' },
];

function listFormJsonRaw(bannerBase64 = banner()) {
  const itemKeys = ['title', 'category', 'price', 'stock', 'details'];
  return {
    version: '7.3',
    screens: [
      {
        id: 'ITEM', title: 'List an item',
        data: {
          categories: { ...OPTIONS, __example__: [{ id: 'shoes', title: 'Shoes' }] },
          title: ex(''), price: ex(''), stock: ex('1'), details: ex(''), area: ex('Woji, Port Harcourt'),
          note: ex('Your own photos, 1 to 4. The first one is the cover.'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'Image', src: bannerBase64, height: 110, 'scale-type': 'cover', 'alt-text': 'Hoolam market' },
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextInput', name: 'title', label: 'Item name', 'input-type': 'text', required: true, 'max-chars': 80, 'helper-text': 'The way buyers search, e.g. Nike Air Force 1, size 43', 'init-value': '${data.title}' },
                { type: 'Dropdown', name: 'category', label: 'Category', required: true, 'data-source': '${data.categories}' },
                { type: 'TextInput', name: 'price', label: 'Price (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'helper-text': 'e.g. 45000 or 45k', 'init-value': '${data.price}' },
                { type: 'TextInput', name: 'stock', label: 'How many you have', 'input-type': 'number', required: true, 'init-value': '${data.stock}' },
                { type: 'TextArea', name: 'details', label: 'Details (optional)', required: false, 'max-length': 600, 'helper-text': 'Size, colour, condition', 'init-value': '${data.details}' },
                { type: 'TextCaption', text: '🔒 Buyers pay Hoolam, not you directly. You\'re paid once they\'re happy.' },
                { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'DELIVERY' }, payload: { ...carry(itemKeys, 'form'), area: '${data.area}', note: '${data.note}' } } },
              ],
            },
          ],
        },
      },
      {
        id: 'DELIVERY', title: 'Photos and delivery', terminal: true,
        data: { title: ex('Nike Air Force 1'), category: ex('shoes'), price: ex('45000'), stock: ex('1'), details: ex(''), area: ex('Woji, Port Harcourt'), note: ex('Your own photos, 1 to 4. The first one is the cover.') },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'PhotoPicker', name: 'photos', label: 'Photos of the item', description: '${data.note}', 'photo-source': 'camera_gallery', 'max-file-size-kb': 25600, 'min-uploaded-photos': 0, 'max-uploaded-photos': 4 },
                { type: 'TextSubheading', text: 'How can buyers get it?' },
                { type: 'CheckboxGroup', name: 'delivery', label: 'Tick every way you offer', required: true, 'min-selected-items': 1, 'data-source': DELIVERY_CHOICES },
                { type: 'TextInput', name: 'area', label: 'Where is it?', 'input-type': 'text', required: true, 'max-chars': 80, 'helper-text': 'Area and city, e.g. Woji, Port Harcourt', 'init-value': '${data.area}' },
                { type: 'TextCaption', text: '📍 Buyers near you see it first, then the rest of Nigeria.' },
                { type: 'Footer', label: 'Review my item', 'on-click-action': { name: 'complete', payload: { ...carry(itemKeys, 'data'), photos: '${form.photos}', delivery: '${form.delivery}', area: '${form.area}' } } },
              ],
            },
          ],
        },
      },
    ],
  };
}

function editItemFormJsonRaw() {
  return {
    version: '7.3',
    screens: [
      {
        id: 'EDIT', title: 'Edit item', terminal: true,
        data: {
          title: ex('Nike Air Force 1, size 43'), price: ex('45000'), promo: ex(''), promo_for: ex('0'), stock: ex('2'), details: ex(''),
          promo_choices: { ...OPTIONS, __example__: [{ id: '0', title: 'No promo' }] },
          delivery: { type: 'array', items: { type: 'string' }, __example__: ['pickup', 'rider'] },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.title}' },
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextInput', name: 'price', label: 'Price (₦)', 'input-type': 'text', required: true, 'max-chars': 20, 'init-value': '${data.price}' },
                { type: 'TextInput', name: 'promo', label: 'Promo price (₦, optional)', 'input-type': 'text', required: false, 'max-chars': 20, 'helper-text': 'Lower than the price. Buyers see the old price crossed out', 'init-value': '${data.promo}' },
                { type: 'Dropdown', name: 'promo_for', label: 'Promo runs', required: false, 'data-source': '${data.promo_choices}', 'init-value': '${data.promo_for}' },
                { type: 'TextInput', name: 'stock', label: 'How many you have', 'input-type': 'number', required: true, 'helper-text': '0 = sold out', 'init-value': '${data.stock}' },
                { type: 'CheckboxGroup', name: 'delivery', label: 'How buyers get it', required: true, 'min-selected-items': 1, 'data-source': DELIVERY_CHOICES, 'init-value': '${data.delivery}' },
                { type: 'TextArea', name: 'details', label: 'Details (optional)', required: false, 'max-length': 600, 'init-value': '${data.details}' },
                { type: 'Footer', label: 'Save changes', 'on-click-action': { name: 'complete', payload: { price: '${form.price}', promo: '${form.promo}', promo_for: '${form.promo_for}', stock: '${form.stock}', delivery: '${form.delivery}', details: '${form.details}' } } },
              ],
            },
          ],
        },
      },
    ],
  };
}

function marketOrderFormJsonRaw() {
  return {
    version: '7.3',
    screens: [
      {
        id: 'ORDER', title: 'Delivery', terminal: true,
        data: { item: ex('Nike Air Force 1 ×1 from Bayo Kicks'), address: ex(''), pickup: { type: 'boolean', __example__: false } },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '${data.item}' },
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextArea', name: 'address', label: 'Delivery address', required: true, 'max-length': 300, 'helper-text': 'Street, area and city', 'init-value': '${data.address}' },
                { type: 'DatePicker', name: 'arrive_by', label: 'Expected by (optional)', required: false, 'helper-text': 'We remind the seller if it\'s late' },
                { type: 'TextCaption', text: '🔒 Nothing is paid yet. You pay Hoolam after the seller accepts, never the seller.' },
                { type: 'Footer', label: 'Review my order', 'on-click-action': { name: 'complete', payload: { address: '${form.address}', arrive_by: '${form.arrive_by}' } } },
              ],
            },
          ],
        },
      },
    ],
  };
}

const named = (prefix: string, json: object) => `${prefix}_${createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8)}`;
export const listFormName = (json: object = listFormJson()) => named('hoolam_mklist', json);
export const editItemFormName = (json: object = editItemFormJson()) => named('hoolam_mkedit', json);
export const marketOrderFormName = (json: object = marketOrderFormJson()) => named('hoolam_mkorder', json);

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const date = (v: unknown) => { const d = str(v); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : /^\d{12,13}$/.test(d) ? new Date(Number(d)).toISOString().slice(0, 10) : null; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.replace(/[[\]"]/g, '').split(',').map((x) => x.trim()).filter(Boolean) : []);

export function readListForm(f: Record<string, unknown>) {
  const photos = Array.isArray(f.photos) ? (f.photos as { id?: string; media_id?: string }[]).map((p) => String(p.id ?? p.media_id ?? '')).filter(Boolean) : [];
  return {
    photos, title: str(f.title), category: str(f.category), price: str(f.price), stock: str(f.stock), details: str(f.details) || null,
    delivery: list(f.delivery).filter((x) => ['pickup', 'rider', 'waybill'].includes(x)) as ('pickup' | 'rider' | 'waybill')[],
    area: str(f.area),
  };
}
export function readEditForm(f: Record<string, unknown>) {
  return {
    price: str(f.price), promo: str(f.promo), promoFor: str(f.promo_for) || '0', stock: str(f.stock), details: str(f.details) || null,
    delivery: list(f.delivery).filter((x) => ['pickup', 'rider', 'waybill'].includes(x)) as ('pickup' | 'rider' | 'waybill')[],
  };
}
export function readOrderForm(f: Record<string, unknown>) {
  return { address: str(f.address) || null, arriveBy: date(f.arrive_by) };
}

export function listFormJson(bannerBase64 = banner()) { return withoutFormWrapper(listFormJsonRaw(bannerBase64)); }

export function editItemFormJson() { return withoutFormWrapper(editItemFormJsonRaw()); }

export function marketOrderFormJson() { return withoutFormWrapper(marketOrderFormJsonRaw()); }
