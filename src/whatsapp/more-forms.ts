import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * FOUR MORE FORMS. Each has its chat questions as the backup (when the form can't be sent, or they type instead).
 *   PAYOUT ACCOUNT (live: our endpoint looks up the account name before they confirm)
 *     ACCOUNT: the 10-digit number (and whose name it must be in) → BANK: the likely banks first → CONFIRM: "This account
 *     belongs to ADA OBI", ✓ matches your ID, a tick, Save account. The server checks everything again when it arrives.
 *   REPORT A PROBLEM (static): what went wrong (a list), the details, photos as proof. The money is already frozen.
 *   MY PAGE (static, filled in): shop name, city, photo, Instagram, TikTok, Facebook, website. Also the one-time seller setup.
 *   RATING (static): after 👍, a few words and a tick to show them on the seller's page; after 👎, what went wrong (team only).
 * A changed form gets a new name on Meta (a hash of its contents).
 */
const ex = (v: string) => ({ type: 'string', __example__: v });
const bool = (v: boolean) => ({ type: 'boolean', __example__: v });
const OPTIONS = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } };

// ---------------------------------------------------------------------------------------------
// payout account (live)

export function payoutFormJson() {
  const err = { type: 'TextBody', text: '${data.error}', visible: '${data.has_error}', 'font-weight': 'bold' };
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: { ACCOUNT: ['BANK'], BANK: ['CONFIRM'] },
    screens: [
      {
        id: 'ACCOUNT', title: 'Payout account',
        data: { heading: ex('Where should we pay you?'), intro: ex('Use an account in your own name.'), error: ex(''), has_error: bool(false), account_number: ex('') },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'form', children: [
            { type: 'TextSubheading', text: '${data.heading}' },
            { type: 'TextBody', text: '${data.intro}' },
            { type: 'TextInput', name: 'account_number', label: 'Account number', 'input-type': 'number', required: true, 'max-chars': 10, 'min-chars': 10, 'helper-text': '10 digits', 'init-value': '${data.account_number}' },
            err,
            { type: 'TextCaption', text: '🔒 Hoolam only ever pays into this account. You can change it any time in My account.' },
            { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { op: 'number', account_number: '${form.account_number}' } } },
          ],
        }] },
      },
      {
        id: 'BANK', title: 'Your bank',
        data: { account_number: ex('0123456789'), banks: { ...OPTIONS, __example__: [{ id: '999992', title: 'OPay' }] }, error: ex(''), has_error: bool(false) },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'form', children: [
            { type: 'TextSubheading', text: 'Which bank is ${data.account_number} with?' },
            { type: 'Dropdown', name: 'bank', label: 'Bank', required: true, 'data-source': '${data.banks}' },
            { type: 'TextInput', name: 'bank_other', label: 'Not listed? Type it', 'input-type': 'text', required: false, 'max-chars': 40, 'helper-text': 'Only if you picked "My bank isn\'t listed"' },
            err,
            { type: 'TextCaption', text: '🔎 We look up the name on the account with the bank, so you can check it before saving.' },
            { type: 'Footer', label: 'Check account', 'on-click-action': { name: 'data_exchange', payload: { op: 'bank', account_number: '${data.account_number}', bank: '${form.bank}', bank_other: '${form.bank_other}' } } },
          ],
        }] },
      },
      {
        id: 'CONFIRM', title: 'Check the account', terminal: true,
        data: { account_number: ex('0123456789'), bank: ex('058'), confirm_text: ex('ADA OBI\nGTBank · 0123456789'), name_note: ex('✓ Matches the name on your ID'), has_note: bool(true) },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'form', children: [
            { type: 'TextSubheading', text: 'This account belongs to' },
            { type: 'TextBody', text: '${data.confirm_text}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.name_note}', visible: '${data.has_note}' },
            { type: 'TextCaption', text: '⚠️ We pay exactly this account. Check the name before you save.' },
            { type: 'OptIn', name: 'confirm', label: 'Yes, this is my account', required: true },
            { type: 'Footer', label: 'Save account', 'on-click-action': { name: 'complete', payload: { account_number: '${data.account_number}', bank: '${data.bank}' } } },
          ],
        }] },
      },
    ],
  };
}

/** The payout form's token: who it's for, for 24 hours, signed. */
export function payoutToken(secret: string, phone: string, ttlHours = 24): string {
  const body = `pb1.${phone.replace(/\D/g, '')}.${Math.floor(Date.now() / 1000) + ttlHours * 3600}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22)}`;
}
export function readPayoutToken(secret: string, token: string): string | null {
  const p = String(token ?? '').split('.');
  if (p.length !== 4 || p[0] !== 'pb1') return null;
  const body = p.slice(0, 3).join('.');
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22));
  const got = Buffer.from(p[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(p[2]) * 1000 < Date.now()) return null;
  return '+' + p[1];
}

// ---------------------------------------------------------------------------------------------
// report a problem

export const PROBLEM_REASONS = [
  { id: 'not_arrived', title: 'It hasn\'t arrived' },
  { id: 'wrong_item', title: 'Wrong item, size or colour' },
  { id: 'damaged', title: 'It came damaged' },
  { id: 'not_described', title: 'Not as described or shown' },
  { id: 'fake', title: 'Fake or a copy' },
  { id: 'missing', title: 'Something is missing' },
  { id: 'other', title: 'Something else' },
];
export const problemReasonTitle = (id: string) => PROBLEM_REASONS.find((r) => r.id === id)?.title ?? 'Something else';

export function problemFormJson() {
  return {
    version: '7.3',
    screens: [{
      id: 'PROBLEM', title: 'Report a problem', terminal: true,
      data: { heading: ex('HL-7K2QF · Leather bag from Bayo'), frozen: ex('₦15,400 is frozen with Hoolam until this is sorted.'), reply: ex('A rep replies within 24 hours.') },
      layout: { type: 'SingleColumnLayout', children: [
        { type: 'TextSubheading', text: '${data.heading}' },
        { type: 'TextBody', text: '🔒 ${data.frozen}' },
        { type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'reason', label: 'What went wrong?', required: true, 'data-source': PROBLEM_REASONS },
          { type: 'TextArea', name: 'details', label: 'Tell us what happened', required: true, 'max-length': 1000, 'helper-text': 'What you expected, and what you got' },
          { type: 'PhotoPicker', name: 'photos', label: 'Photos as proof (optional)', description: 'The item, the package, or a chat with the seller. Up to 5.', 'photo-source': 'camera_gallery', 'max-file-size-kb': 25600, 'min-uploaded-photos': 0, 'max-uploaded-photos': 5 },
          { type: 'TextCaption', text: '💬 ${data.reply} The seller isn\'t paid while we look into it.' },
          { type: 'Footer', label: 'Send to Hoolam', 'on-click-action': { name: 'complete', payload: { reason: '${form.reason}', details: '${form.details}', photos: '${form.photos}' } } },
        ] },
      ] },
    }],
  };
}

// ---------------------------------------------------------------------------------------------
// my page (and the one-time seller setup)

export function pageFormJson() {
  return {
    version: '7.3',
    screens: [{
      id: 'PAGE', title: 'My page', terminal: true,
      data: {
        heading: ex('Your trust card'), intro: ex('What buyers see before they pay you.'),
        name: ex('Bayo Kicks'), city: ex('Port Harcourt'), photo_note: ex('Your face or your shop, in the middle.'),
        instagram: ex(''), tiktok: ex(''), facebook: ex(''), website: ex(''), button: ex('Save my page'),
      },
      layout: { type: 'SingleColumnLayout', children: [
        { type: 'TextSubheading', text: '${data.heading}' },
        { type: 'TextBody', text: '${data.intro}' },
        { type: 'Form', name: 'form', children: [
          { type: 'TextInput', name: 'name', label: 'Name buyers see', 'input-type': 'text', required: true, 'max-chars': 40, 'helper-text': 'Your shop or brand name', 'init-value': '${data.name}' },
          { type: 'TextInput', name: 'city', label: 'City you sell from (optional)', 'input-type': 'text', required: false, 'max-chars': 30, 'init-value': '${data.city}' },
          { type: 'PhotoPicker', name: 'photo', label: 'Photo (optional)', description: '${data.photo_note}', 'photo-source': 'camera_gallery', 'max-file-size-kb': 25600, 'min-uploaded-photos': 0, 'max-uploaded-photos': 1 },
          { type: 'TextSubheading', text: 'Where you sell (optional)' },
          { type: 'TextInput', name: 'instagram', label: 'Instagram', 'input-type': 'text', required: false, 'max-chars': 120, 'helper-text': '@yourshop or a link', 'init-value': '${data.instagram}' },
          { type: 'TextInput', name: 'tiktok', label: 'TikTok', 'input-type': 'text', required: false, 'max-chars': 120, 'helper-text': '@yourshop or a link', 'init-value': '${data.tiktok}' },
          { type: 'TextInput', name: 'facebook', label: 'Facebook', 'input-type': 'text', required: false, 'max-chars': 160, 'helper-text': 'Your page link', 'init-value': '${data.facebook}' },
          { type: 'TextInput', name: 'website', label: 'Website or store', 'input-type': 'text', required: false, 'max-chars': 160, 'init-value': '${data.website}' },
          { type: 'TextCaption', text: '🛡️ Your numbers come from real orders. Nobody can edit them, not even you.' },
          { type: 'Footer', label: '${data.button}', 'on-click-action': { name: 'complete', payload: { name: '${form.name}', city: '${form.city}', photo: '${form.photo}', instagram: '${form.instagram}', tiktok: '${form.tiktok}', facebook: '${form.facebook}', website: '${form.website}' } } },
        ] },
      ] },
    }],
  };
}

// ---------------------------------------------------------------------------------------------
// rating: a few words after 👍, what went wrong after 👎

export function rateFormJson() {
  return {
    version: '7.3',
    screens: [{
      id: 'RATE', title: 'Your rating', terminal: true,
      data: {
        heading: ex('Thanks for rating Bayo'), happy: bool(true), unhappy: bool(false),
        seller: ex('Bayo'), shown_as: ex('Only your first name and area show (Ada, Port Harcourt). Never your number.'),
      },
      layout: { type: 'SingleColumnLayout', children: [
        { type: 'TextSubheading', text: '${data.heading}' },
        { type: 'Form', name: 'form', children: [
          { type: 'TextArea', name: 'words', label: 'A few words for the next buyer', required: '${data.happy}', visible: '${data.happy}', 'max-length': 160, 'helper-text': 'e.g. Fast delivery, exactly like the pictures' },
          { type: 'OptIn', name: 'show', label: 'Show my words on ${data.seller}\'s page', required: false, visible: '${data.happy}' },
          { type: 'TextCaption', text: '${data.shown_as}', visible: '${data.happy}' },
          { type: 'TextArea', name: 'note', label: 'What went wrong?', required: '${data.unhappy}', visible: '${data.unhappy}', 'max-length': 500, 'helper-text': 'Only the Hoolam team sees this' },
          { type: 'TextCaption', text: '🙏 A real person on our team reads every one.', visible: '${data.unhappy}' },
          { type: 'Footer', label: 'Send', 'on-click-action': { name: 'complete', payload: { words: '${form.words}', show: '${form.show}', note: '${form.note}' } } },
        ] },
      ] },
    }],
  };
}

const named = (prefix: string, json: object, extra = '') => `${prefix}_${createHash('sha256').update(JSON.stringify(json) + extra).digest('hex').slice(0, 8)}`;
export const payoutFormName = (endpoint: string, json: object = payoutFormJson()) => named('hoolam_payout', json, endpoint);
export const problemFormName = (json: object = problemFormJson()) => named('hoolam_problem', json);
export const pageFormName = (json: object = pageFormJson()) => named('hoolam_page', json);
export const rateFormName = (json: object = rateFormJson()) => named('hoolam_rate', json);

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const media = (v: unknown) => (Array.isArray(v) ? (v as { id?: string; media_id?: string; mime_type?: string }[]).map((p) => ({ mediaId: String(p.id ?? p.media_id ?? ''), mimeType: p.mime_type ?? null })).filter((p) => p.mediaId) : []);
export const readProblemForm = (f: Record<string, unknown>) => ({ reason: str(f.reason) || 'other', details: str(f.details), photos: media(f.photos) });
export const readPageForm = (f: Record<string, unknown>) => ({
  name: str(f.name), city: str(f.city), photo: media(f.photo)[0] ?? null,
  socials: { instagram: str(f.instagram), tiktok: str(f.tiktok), facebook: str(f.facebook), website: str(f.website) },
});
export const readRateForm = (f: Record<string, unknown>) => ({ words: str(f.words), show: f.show === true || f.show === 'true', note: str(f.note) });
