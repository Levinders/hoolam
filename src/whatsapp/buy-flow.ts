import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE BUYER'S FORM (a WhatsApp Flow). Two screens:
 *   1. ITEM:   banner, what you're buying, agreed price, seller's WhatsApp (optional), arrival date (optional)
 *   2. PHOTOS: up to 3 photos (optional), then "Review my deal"
 * WhatsApp shows it in its own style; our branding is the banner image and the words.
 * Static form: no server endpoint. The answers arrive in the webhook when the buyer taps "Review my deal".
 *
 * Changing anything here creates a new form on Meta automatically (the name includes a hash of this JSON).
 * WhatsApp limits: labels 20 characters, helper text 30, footer button 35.
 */
const BANNER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'buy-banner.png');

export function buyFlowJson(bannerBase64 = readFileSync(BANNER).toString('base64')) {
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
              type: 'Form',
              name: 'form',
              children: [
                { type: 'TextSubheading', text: 'What are you buying?' },
                { type: 'TextInput', name: 'item', label: 'Item', 'input-type': 'text', required: true, 'max-chars': 150, 'helper-text': 'e.g. Black sneakers, size 42' },
                { type: 'TextInput', name: 'price', label: 'Agreed price (₦)', 'input-type': 'number', required: true, 'helper-text': 'What you and the seller agreed' },
                { type: 'TextInput', name: 'seller_phone', label: 'Seller\'s WhatsApp', 'input-type': 'phone', required: false, 'helper-text': 'Optional. We\'ll alert them' },
                { type: 'DatePicker', name: 'arrive_by', label: 'When should it arrive? (optional)', required: false },
                {
                  type: 'Footer',
                  label: 'Continue',
                  'on-click-action': {
                    name: 'navigate',
                    next: { type: 'screen', name: 'PHOTOS' },
                    payload: { item: '${form.item}', price: '${form.price}', seller_phone: '${form.seller_phone}', arrive_by: '${form.arrive_by}' },
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
        data: {
          item: { type: 'string', __example__: 'Black sneakers, size 42' },
          price: { type: 'string', __example__: '15000' },
          seller_phone: { type: 'string', __example__: '08012345678' },
          arrive_by: { type: 'string', __example__: '2026-10-09' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextSubheading', text: '📷 Photos of the item' },
            { type: 'TextBody', text: 'Optional. A screenshot of the seller\'s post works. It\'s your proof of what was promised.' },
            {
              type: 'Form',
              name: 'form',
              children: [
                {
                  type: 'PhotoPicker', name: 'photos', label: 'Add up to 3 photos',
                  description: 'We only show them to the seller and to our team if there\'s a problem.',
                  'photo-source': 'camera_gallery', 'max-file-size-kb': 5120, 'min-uploaded-photos': 0, 'max-uploaded-photos': 3,
                },
                { type: 'TextCaption', text: '💡 Nothing to pay yet. You pay after the seller accepts.' },
                {
                  type: 'Footer',
                  label: 'Review my deal',
                  'on-click-action': {
                    name: 'complete',
                    payload: { item: '${data.item}', price: '${data.price}', seller_phone: '${data.seller_phone}', arrive_by: '${data.arrive_by}', photos: '${form.photos}' },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** The form's name on Meta. Changes whenever the form changes, because published forms can't be edited. */
export function buyFlowName(json = buyFlowJson()): string {
  return 'hoolam_buy_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
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
    item: str(form.item) || null,
    price: str(form.price) || null,
    sellerPhone: str(form.seller_phone) || null,
    arriveBy: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : /^\d{12,13}$/.test(date) ? new Date(Number(date)).toISOString().slice(0, 10) : null,
    photos,
  };
}
