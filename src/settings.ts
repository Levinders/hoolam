import type { Config } from './config.js';
import type { Db, Queryable } from './db.js';
import { checkBands, DEFAULT_TXN_BANDS, PRICING, type FeeBand, type PricingRules, type TxnFees } from './pricing.js';
import { FIRST_VERSION, isHomeVersion } from './site-versions.js';
import { CATEGORIES } from './deals/categories.js';
import { COMPANY_SOCIAL_KINDS, COMPANY_SOCIAL_NAMES, companySocialLink, parseCompanySocial, type CompanySocialKind } from './socials.js';

/**
 * Settings staff can change from the console. Each has a default (from Render's environment or the code),
 * a type and limits, so a typo can't break the service. Changes apply to NEW deals only: a deal keeps
 * the fee and limits it was created with.
 */
export type SettingType = 'number' | 'money' | 'percent' | 'hours' | 'minutes' | 'boolean' | 'phone' | 'email' | 'social' | 'bands' | 'text';

export interface SettingDef {
  key: string;
  group: 'Fees' | 'Limits' | 'Timing' | 'WhatsApp' | 'Contact' | 'Features' | 'Ambassadors' | 'Market' | 'Security';
  /** Within a feature's settings: the heading it sits under (Earnings, Payouts…). */
  sub?: string;
  label: string;
  help: string;
  type: SettingType;
  min?: number;
  max?: number;
  core?: boolean;   // owner only: money and the number people message
  optional?: boolean; // may be left empty
  social?: CompanySocialKind;
}

export const SETTING_DEFS: SettingDef[] = [
  { key: 'fee_rate_percent', group: 'Fees', label: 'Fee rate', help: 'Percentage of the item price.', type: 'percent', min: 0, max: 20, core: true },
  { key: 'fee_min', group: 'Fees', label: 'Minimum fee', help: 'The smallest fee on any deal.', type: 'money', min: 0, max: 100_000, core: true },
  { key: 'fee_max', group: 'Fees', label: 'Maximum fee', help: 'The fee never goes above this.', type: 'money', min: 0, max: 1_000_000, core: true },
  { key: 'fee_round_to', group: 'Fees', label: 'Round fees to', help: 'Fees are rounded to the nearest multiple of this.', type: 'money', min: 1, max: 10_000, core: true },
  { key: 'seller_txn_fee', group: 'Fees', label: 'Seller transaction fee', help: 'A flat fee by order size, taken from the seller\'s payout on orders the buyer started. Only the seller sees it.', type: 'bands', core: true },
  { key: 'buyer_txn_fee', group: 'Fees', label: 'Buyer transaction fee', help: 'A flat fee by order size, added to what the buyer pays on orders the seller started. Only the buyer sees it.', type: 'bands', core: true },
  { key: 'handover_code_tries', group: 'Limits', label: 'Wrong handover code tries', help: 'How many wrong codes a seller can enter before the order locks and a rep helps finish the handover.', type: 'number', min: 1, max: 20 },
  { key: 'max_deal', group: 'Limits', label: 'Largest order without ID', help: 'Most a single order can be before the person checks their ID (BVN or NIN). Above this, they verify once, then carry on. You can set a different limit for one person on their page.', type: 'money', min: 1_000, max: 100_000_000, core: true },
  { key: 'max_deal_verified', group: 'Limits', label: 'Largest order once verified', help: 'Most a single order can be after the person has checked their ID. Must be at least the limit without ID.', type: 'money', min: 1_000, max: 1_000_000_000, core: true },
  { key: 'seller_accept_hours', group: 'Timing', label: 'Time to accept an order', help: 'The seller (for an order a buyer starts) or the buyer (for an order a seller starts) has this long to accept. After this, the order closes.', type: 'hours', min: 1, max: 336 },
  { key: 'nudge_after_hours', group: 'Timing', label: 'Remind the buyer after', help: 'Hours after shipping before we ask the buyer if the item arrived.', type: 'hours', min: 1, max: 336 },
  { key: 'auto_release_minutes', group: 'Timing', label: 'Pay the seller automatically after', help: 'Once the handover code is entered, the buyer has this long to tap "I\'m happy" or report a problem. If they do neither, the seller is paid.', type: 'minutes', min: 30, max: 20_160 },
  { key: 'dispatch_remind_hours', group: 'Timing', label: 'Remind the seller to dispatch after', help: 'Hours after the buyer pays before we remind a seller who hasn\'t dispatched.', type: 'hours', min: 1, max: 336 },
  { key: 'unpaid_close_hours', group: 'Timing', label: 'Close unpaid orders after', help: 'Hours an order can wait for the buyer to pay before it closes.', type: 'hours', min: 1, max: 720 },
  { key: 'rep_reply_minutes', group: 'Timing', label: 'Reps reply within', help: 'What we promise in the menu and when someone asks for a rep.', type: 'minutes', min: 5, max: 2_880 },
  { key: 'problem_reply_hours', group: 'Timing', label: 'Problem cases answered within', help: 'What we promise a buyer when they report a problem.', type: 'hours', min: 1, max: 168 },
  { key: 'flag_after_hours', group: 'Timing', label: 'Flag for the team after', help: 'Hours after shipping before an unconfirmed order appears in Needs action.', type: 'hours', min: 1, max: 720 },
  { key: 'whatsapp_number', group: 'WhatsApp', label: 'Hoolam\'s WhatsApp number', help: 'The number people message. Used in every "chat with Hoolam" link: the website, seller pages and payment links. For example 07034577787.', type: 'phone', core: true },
  { key: 'alerts_enabled', group: 'WhatsApp', label: 'Alert the other side by number', help: 'Send "New order request" / "Payment request" when someone types the other side\'s number.', type: 'boolean' },
  { key: 'contact_email', group: 'Contact', label: 'Email', help: 'Where people can write to Hoolam. Shown in the website footer and on the legal pages.', type: 'email' },
  { key: 'contact_phone', group: 'Contact', label: 'Phone for calls', help: 'Optional. Leave it empty to show Hoolam\'s WhatsApp number instead.', type: 'phone', optional: true },
  ...COMPANY_SOCIAL_KINDS.map((k): SettingDef => ({ key: `company_${k}`, group: 'Contact', label: COMPANY_SOCIAL_NAMES[k], help: `Hoolam's ${COMPANY_SOCIAL_NAMES[k]} page. Paste the link or type the username. Empty hides it.`, type: 'social', social: k, optional: true })),
  { key: 'feature_seller_stats', group: 'Features', label: 'Seller page stats', help: 'Sellers see their page views and "Buy" taps under My page in WhatsApp, and buyers see a seller\'s page views (from 50) on their public page and trust card. Counting never stops: when this is off, nobody sees the numbers; turn it on and the full history shows.', type: 'boolean', core: true },
  // ----- Features → Ambassadors (owner only). Everything below shows under the Ambassadors card. -----
  { key: 'feature_ambassadors', group: 'Features', label: 'Ambassadors', help: 'People you approve bring new sellers and buyers, and earn a share of what Hoolam makes on their orders. Off: nobody sees the programme (menu, website page, links). Earnings already made are kept.', type: 'boolean', core: true },
  { key: 'amb_seller_pct', group: 'Ambassadors', sub: 'Earnings', label: 'Share on sellers they bring', help: 'Of everything Hoolam earns (Hoolam fee and transaction fee) on each completed order of a seller they brought. You can set a different share for one ambassador on their page.', type: 'percent', min: 0, max: 50, core: true },
  { key: 'amb_buyer_pct', group: 'Ambassadors', sub: 'Earnings', label: 'Share on buyers they bring', help: 'Of everything Hoolam earns on each completed order of a buyer they brought.', type: 'percent', min: 0, max: 50, core: true },
  { key: 'amb_seller_bonus', group: 'Ambassadors', sub: 'Earnings', label: 'Seller bonus', help: 'Paid once for each seller they bring, when that seller completes the number of orders below.', type: 'money', min: 0, max: 100_000, core: true },
  { key: 'amb_bonus_orders', group: 'Ambassadors', sub: 'Earnings', label: 'Completed orders for the bonus', help: 'How many orders a new seller must complete before the ambassador gets the seller bonus.', type: 'number', min: 1, max: 20, core: true },
  { key: 'amb_payout_day', group: 'Ambassadors', sub: 'Payouts', label: 'Payout day', help: 'The day of the month earnings from the month before are paid. 1 = the 1st.', type: 'number', min: 1, max: 28, core: true },
  { key: 'amb_payout_min', group: 'Ambassadors', sub: 'Payouts', label: 'Minimum payout', help: 'Earnings below this wait for the next month. When an ambassador ends, they\'re paid whatever they\'re owed.', type: 'money', min: 0, max: 1_000_000, core: true },
  { key: 'amb_term_3', group: 'Ambassadors', sub: 'Terms', label: '3-month term', help: 'Ambassadors can choose 3 months.', type: 'boolean', core: true },
  { key: 'amb_term_6', group: 'Ambassadors', sub: 'Terms', label: '6-month term', help: 'Ambassadors can choose 6 months.', type: 'boolean', core: true },
  { key: 'amb_term_12', group: 'Ambassadors', sub: 'Terms', label: '12-month term', help: 'Ambassadors can choose 12 months.', type: 'boolean', core: true },
  { key: 'amb_notice_days', group: 'Ambassadors', sub: 'Terms', label: 'Notice before a term ends', help: 'Days before the end of a term that we ask them to renew, switch or end. No answer: it renews on the same term.', type: 'number', min: 1, max: 30, core: true },
  { key: 'amb_apply_web', group: 'Ambassadors', sub: 'Joining', label: 'Applications on the website', help: 'People can apply on hoolam.com/ambassadors.', type: 'boolean', core: true },
  { key: 'amb_apply_whatsapp', group: 'Ambassadors', sub: 'Joining', label: 'Applications in WhatsApp', help: 'People can apply from the WhatsApp menu.', type: 'boolean', core: true },
  { key: 'amb_menu_after', group: 'Ambassadors', sub: 'Joining', label: 'Show in the menu after', help: 'Completed orders someone needs before "Become an ambassador" shows in their WhatsApp menu. Ambassadors and people who applied always see it.', type: 'number', min: 0, max: 50, core: true },
  { key: 'feature_seller_video', group: 'Features', label: 'Seller videos', help: 'Sellers can send a short video in WhatsApp (My page → Video). Hoolam checks each one before it shows on their page. Off: they don\'t see the option and no videos show; approved ones are kept for when it\'s back on.', type: 'boolean', core: true },
  { key: 'feature_menu_order_code', group: 'Features', label: '"I have an order code" in the menu', help: 'Buyers see "I have an order code" in their WhatsApp menu. Off: it\'s left out of the menu; order links, typed codes and the View button on order alerts still work.', type: 'boolean', core: true },
  // ----- Features → Market (owner only). Everything below shows under the Market card. -----
  { key: 'feature_market', group: 'Features', label: 'Market', help: 'Sellers list items in WhatsApp (My items) and buyers browse them as swipe cards (Browse the market), then buy with the money held as usual. Off: no menu row, listing or market page shows; nothing listed is lost.', type: 'boolean', core: true },
  { key: 'mk_approval', group: 'Market', sub: 'Who can list', label: 'Approval before listing', help: 'On: sellers tap Apply to list, and you approve or decline them here. Off: any seller with a checked ID and a payout account lists straight away.', type: 'boolean', core: true },
  { key: 'mk_items_per_seller', group: 'Market', sub: 'Who can list', label: 'Items per seller', help: 'Live listings each seller can have. You can set a higher number for one seller on the Market page.', type: 'number', min: 1, max: 100_000, core: true },
  { key: 'mk_upgrade_on', group: 'Market', sub: 'Who can list', label: 'More items for a fee', help: 'On: a seller at the limit sees Get more items with the plan below; you confirm their payment on the Market page and their limit rises. Off: they\'re told to talk to a rep.', type: 'boolean', core: true },
  { key: 'mk_upgrade_items', group: 'Market', sub: 'Who can list', label: 'Items with the upgrade', help: 'How many live items a seller can have on the paid plan.', type: 'number', min: 2, max: 100_000, core: true },
  { key: 'mk_upgrade_price', group: 'Market', sub: 'Who can list', label: 'Upgrade price per month', help: 'What the paid plan costs for 30 days.', type: 'money', min: 0, max: 10_000_000, core: true },
  ...CATEGORIES.map((c): SettingDef => ({ key: `mk_cat_${c.id}`, group: 'Market', sub: 'What can be listed', label: c.title, help: `Sellers can list in ${c.title}, and buyers can browse it.`, type: 'boolean', core: true })),
  { key: 'mk_expire_days', group: 'Market', sub: 'What can be listed', label: 'Listings expire after', help: 'Days before a listing hides unless the seller renews it. They\'re reminded 3 days before.', type: 'number', min: 3, max: 365, core: true },
  { key: 'mk_blocked_words', group: 'Market', sub: 'What can be listed', label: 'Blocked words', help: 'Words that stop a listing, separated by commas. Checked in the name and details, ignoring capitals.', type: 'text', core: true },
  { key: 'mk_usual_fee', group: 'Market', sub: 'Fees', label: 'Usual Hoolam fee applies', help: 'On: the buyer pays Hoolam\'s usual fee on market orders, as on any order they start. Off: no Hoolam fee on market orders.', type: 'boolean', core: true },
  { key: 'mk_usual_txn', group: 'Market', sub: 'Fees', label: 'Usual transaction fee applies', help: 'On: the seller pays the usual transaction fee on market orders. Off: no transaction fee on market orders.', type: 'boolean', core: true },
  { key: 'mk_fees_on', group: 'Market', sub: 'Fees', label: 'Market fees', help: 'On: the market fees below are added on market orders, on top of whichever usual fees are on.', type: 'boolean', core: true },
  { key: 'mk_buyer_rate', group: 'Market', sub: 'Fees', label: 'Buyer market fee', help: 'Percentage of the order, paid by the buyer.', type: 'percent', min: 0, max: 20, core: true },
  { key: 'mk_buyer_min', group: 'Market', sub: 'Fees', label: 'Buyer market fee, at least', help: 'The smallest buyer market fee (0 for none).', type: 'money', min: 0, max: 100_000, core: true },
  { key: 'mk_buyer_max', group: 'Market', sub: 'Fees', label: 'Buyer market fee, at most', help: 'The biggest buyer market fee.', type: 'money', min: 0, max: 1_000_000, core: true },
  { key: 'mk_seller_rate', group: 'Market', sub: 'Fees', label: 'Seller market fee', help: 'Percentage of the order, taken from what the seller receives.', type: 'percent', min: 0, max: 20, core: true },
  { key: 'mk_seller_min', group: 'Market', sub: 'Fees', label: 'Seller market fee, at least', help: 'The smallest seller market fee (0 for none).', type: 'money', min: 0, max: 100_000, core: true },
  { key: 'mk_seller_max', group: 'Market', sub: 'Fees', label: 'Seller market fee, at most', help: 'The biggest seller market fee.', type: 'money', min: 0, max: 1_000_000, core: true },
  { key: 'mk_reports_hide', group: 'Market', sub: 'Keeping it clean', label: 'Reports before hiding', help: 'Reports from different buyers that hide an item until the team looks.', type: 'number', min: 1, max: 50, core: true },
  { key: 'mk_strikes', group: 'Market', sub: 'Keeping it clean', label: 'Strikes before listing stops', help: 'Removed listings (in 90 days) before a seller can\'t list until you let them.', type: 'number', min: 1, max: 50, core: true },
  { key: 'mk_back_in_stock', group: 'Market', sub: 'Bringing people back', label: 'Back in stock messages', help: 'Buyers who saved an item hear when it\'s back, once they agreed to updates.', type: 'boolean', core: true },
  { key: 'mk_new_from_sellers', group: 'Market', sub: 'Bringing people back', label: 'New from sellers you\'ve bought from', help: 'Past buyers who agreed get swipe cards of a seller\'s new items (at most once a week each).', type: 'boolean', core: true },
  { key: 'mk_ad_links', group: 'Market', sub: 'Bringing people back', label: 'Ads that open WhatsApp on an item', help: 'Make a link per item for Facebook and Instagram ads; Hoolam counts the taps and orders each ad brings.', type: 'boolean', core: true },
  { key: 'feature_menu_check_seller', group: 'Features', label: '"Check a seller" in the menu', help: 'Buyers see "Check a seller" in their WhatsApp menu. Off: it\'s left out of the menu; typing "check a seller" and the trust card before paying still work.', type: 'boolean', core: true },
  { key: 'feature_about_founder', group: 'Features', label: 'Who\'s behind Hoolam on About', help: 'Your photo, name, a one-line promise and your voice note on the About page. Off: the section is left out.', type: 'boolean', core: true },
  { key: 'feature_site_numbers', group: 'Features', label: 'Live numbers on the website', help: 'Real counts from your orders on the website (home, about and ambassadors pages). Each number shows only once it reaches its minimum below. Test orders never count.', type: 'boolean', core: true },
  { key: 'site_min_completed', group: 'Features', sub: 'Website numbers', label: 'Show "orders completed" from', help: 'Orders where the seller was paid.', type: 'number', min: 1, max: 1_000_000, core: true },
  { key: 'site_min_started', group: 'Features', sub: 'Website numbers', label: 'Show "orders started" from', help: 'Every order started on Hoolam.', type: 'number', min: 1, max: 1_000_000, core: true },
  { key: 'site_min_refunded', group: 'Features', sub: 'Website numbers', label: 'Show "buyers refunded in full" from', help: 'Orders decided for the buyer, with all their money returned.', type: 'number', min: 1, max: 100_000, core: true },
  { key: 'site_min_amb_paid', group: 'Features', sub: 'Website numbers', label: 'Show "paid to ambassadors" from', help: 'Naira paid out to ambassadors. Shown on the ambassadors page.', type: 'money', min: 1, max: 1_000_000_000, core: true },
  { key: 'two_step_login', group: 'Security', label: 'Authenticator code at sign-in', help: 'On: signing in to the console needs the email, the password and the 6-digit code from an authenticator app. Off: the email and password are enough. Authenticators already set up are kept, so turning it back on works straight away; anyone without one sets it up at their next sign-in.', type: 'boolean', core: true },
  { key: 'forms_enabled', group: 'WhatsApp', label: 'WhatsApp forms', help: 'Offer the buy and sell forms (needs Meta business verification).', type: 'boolean' },
];

type Value = number | boolean | string | FeeBand[];
export type SettingValue = Value;
type Values = Record<string, Value>;

export class Settings {
  private values: Values = {};
  private readonly unit: number;

  constructor(private readonly db: Db, private readonly c: Config) {
    this.unit = c.CURRENCY === 'NGN' ? 100 : 1;
  }

  /** Defaults when nothing has been saved yet. Money is stored in MAJOR units (naira) for readability. */
  defaults(): Values {
    const p = PRICING[this.c.CURRENCY];
    return {
      fee_rate_percent: p.ratePercent, fee_min: p.min, fee_max: p.max, fee_round_to: p.roundTo,
      seller_txn_fee: DEFAULT_TXN_BANDS, buyer_txn_fee: DEFAULT_TXN_BANDS,
      max_deal: this.c.MAX_DEAL_MINOR / this.unit, max_deal_verified: 2_000_000,
      auto_release_minutes: 1440, dispatch_remind_hours: 12,
      unpaid_close_hours: 72, rep_reply_minutes: 30, problem_reply_hours: 24, handover_code_tries: 5,
      seller_accept_hours: this.c.SELLER_ACCEPT_HOURS, nudge_after_hours: this.c.NUDGE_AFTER_HOURS, flag_after_hours: this.c.FLAG_AFTER_HOURS,
      whatsapp_number: this.c.WHATSAPP_PUBLIC_NUMBER.replace(/\D/g, ''),
      alerts_enabled: true, forms_enabled: this.c.WHATSAPP_BUY_FORM, feature_seller_stats: false, two_step_login: false,
      feature_ambassadors: false, amb_seller_pct: 20, amb_buyer_pct: 10, amb_seller_bonus: 1000, amb_bonus_orders: 3,
      amb_payout_day: 1, amb_payout_min: 5000, amb_term_3: true, amb_term_6: true, amb_term_12: true, amb_notice_days: 7,
      amb_apply_web: true, amb_apply_whatsapp: true, amb_menu_after: 1,
      feature_site_numbers: true, feature_about_founder: false, feature_seller_video: false, feature_menu_order_code: false, feature_menu_check_seller: false,
      feature_market: false, mk_approval: false, mk_items_per_seller: 50, mk_upgrade_on: false, mk_upgrade_items: 150, mk_upgrade_price: 3000,
      ...Object.fromEntries(CATEGORIES.map((c) => [`mk_cat_${c.id}`, ['clothing', 'shoes', 'bags', 'beauty'].includes(c.id)])),
      mk_expire_days: 30, mk_blocked_words: 'fake, replica, counterfeit, first copy, clone, gun, rifle, pistol, ammunition, weed, cannabis, codeine, tramadol, cocaine, rx only, prescription',
      mk_usual_fee: true, mk_usual_txn: true, mk_fees_on: false, mk_buyer_rate: 0, mk_buyer_min: 0, mk_buyer_max: 0, mk_seller_rate: 0, mk_seller_min: 0, mk_seller_max: 0,
      mk_reports_hide: 3, mk_strikes: 3, mk_back_in_stock: false, mk_new_from_sellers: false, mk_ad_links: false, site_min_completed: 50, site_min_started: 100, site_min_refunded: 5, site_min_amb_paid: 100_000,
      contact_email: 'hello@hoolam.com', contact_phone: '',
      home_version: FIRST_VERSION, // the live home page version (Console → Settings → Website content)
      ...Object.fromEntries(COMPANY_SOCIAL_KINDS.map((k) => [`company_${k}`, ''])),
    };
  }

  async load(): Promise<void> {
    const r = await this.db.query('SELECT key, value FROM settings');
    this.values = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  }

  all(): Values { return { ...this.defaults(), ...this.values }; }
  get<T extends Value>(key: string): T { return (this.all()[key] ?? this.defaults()[key]) as T; }

  /** Tidies what staff typed (spaces in numbers, full links for usernames) before it's checked. */
  normalize(key: string, value: unknown): unknown {
    const def = SETTING_DEFS.find((d) => d.key === key);
    if (!def || typeof value !== 'string') return value;
    if (def.type === 'phone') { const d = value.replace(/\D/g, ''); return /^0\d{10}$/.test(d) ? '234' + d.slice(1) : d; } // 0803… → 2348…
    if (def.type === 'email') return value.trim().toLowerCase();
    if (def.type === 'social') {
      if (!value.trim()) return '';
      const r = parseCompanySocial(def.social!, value);
      return 'value' in r ? r.value : value;
    }
    return value;
  }

  /** Checks a change. Returns an error message, or null when fine. */
  validate(key: string, value: unknown): string | null {
    const def = SETTING_DEFS.find((d) => d.key === key);
    if (!def) return `Unknown setting ${key}`;
    if (def.type === 'boolean') return typeof value === 'boolean' ? null : `${def.label} must be on or off`;
    if (def.type === 'bands') { const e = checkBands(value); return e ? `${def.label}: ${e}` : null; }
    if (def.optional && value === '') return null;
    if (def.type === 'text') return typeof value === 'string' && value.length <= 4000 ? null : `${def.label} must be text (up to 4,000 characters)`;
    if (def.type === 'email') return typeof value === 'string' && /^[^\s@<>"]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? null : 'Enter a full email address, like hello@hoolam.com.';
    if (def.type === 'social') {
      if (typeof value !== 'string') return `${def.label} must be a link or a username`;
      const r = parseCompanySocial(def.social!, value);
      return 'error' in r ? r.error : null;
    }
    if (def.type === 'phone') {
      if (typeof value !== 'string' || !/^[1-9]\d{7,14}$/.test(value)) return 'Enter the full number, for example 07034577787.';
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${def.label} must be a number`;
    if (def.min != null && value < def.min) return `${def.label} can't be below ${def.min}`;
    if (def.max != null && value > def.max) return `${def.label} can't be above ${def.max}`;
    return null;
  }

  async save(q: Queryable, changes: Record<string, Value>, staffId: string | null): Promise<void> {
    const next = { ...this.all(), ...changes };
    if ((next.fee_min as number) > (next.fee_max as number)) throw new Error('The minimum fee can\'t be above the maximum fee');
    if ((next.max_deal as number) > (next.max_deal_verified as number)) throw new Error('The largest order once verified can\'t be below the largest order without ID');
    if (!next.amb_term_3 && !next.amb_term_6 && !next.amb_term_12) throw new Error('Keep at least one ambassador term (3, 6 or 12 months)');
    if ((next.mk_buyer_min as number) > (next.mk_buyer_max as number) && (next.mk_buyer_max as number) > 0) throw new Error('The buyer market fee minimum can\'t be above its maximum');
    if ((next.mk_seller_min as number) > (next.mk_seller_max as number) && (next.mk_seller_max as number) > 0) throw new Error('The seller market fee minimum can\'t be above its maximum');
    if (!CATEGORIES.some((c) => next[`mk_cat_${c.id}`])) throw new Error('Keep at least one market category');
    for (const k of ['mk_items_per_seller', 'mk_upgrade_items', 'mk_expire_days', 'mk_reports_hide', 'mk_strikes']) if (k in changes && !Number.isInteger(changes[k])) throw new Error('Use a whole number');
    for (const k of ['amb_bonus_orders', 'amb_payout_day', 'amb_notice_days', 'amb_menu_after', 'site_min_completed', 'site_min_started', 'site_min_refunded']) if (k in changes && !Number.isInteger(changes[k])) throw new Error('Use a whole number');
    for (const [k, v] of Object.entries(changes)) {
      await q.query(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [k, JSON.stringify(v), staffId]);
    }
    this.values = { ...this.values, ...changes };
  }

  // ---------- what the deal engine reads ----------
  pricing(): PricingRules {
    return {
      ratePercent: this.get('fee_rate_percent'), min: this.get('fee_min'), max: this.get('fee_max'),
      roundTo: this.get('fee_round_to'), buyerShare: PRICING[this.c.CURRENCY].buyerShare,
    };
  }
  /** The flat transaction fee bands (major units). */
  txnFees(): TxnFees {
    const read = (k: string) => { const v = this.get<Value>(k) as unknown; return checkBands(v) ? DEFAULT_TXN_BANDS : (v as FeeBand[]); };
    return { seller: read('seller_txn_fee'), buyer: read('buyer_txn_fee') };
  }
  maxDealMinor(): number { return Math.round(this.get<number>('max_deal') * this.unit); }
  /** The most one order can be once the person has checked their ID (never below the no-ID limit). */
  maxDealVerifiedMinor(): number { return Math.max(this.maxDealMinor(), Math.round(this.get<number>('max_deal_verified') * this.unit)); }
  acceptHours(): number { return this.get('seller_accept_hours'); }
  /** Console → Settings → Features → Market: everything the market reads. Money in minor units. */
  market() {
    const m = (k: string) => Math.round(this.get<number>(k) * this.unit);
    return {
      on: this.get<boolean>('feature_market'), approval: this.get<boolean>('mk_approval'), perSeller: this.get<number>('mk_items_per_seller'),
      upgrade: { on: this.get<boolean>('mk_upgrade_on'), items: this.get<number>('mk_upgrade_items'), priceMinor: m('mk_upgrade_price') },
      categories: CATEGORIES.filter((c) => this.get<boolean>(`mk_cat_${c.id}`)).map((c) => c.id as string),
      expireDays: this.get<number>('mk_expire_days'),
      blocked: String(this.get<string>('mk_blocked_words') ?? '').split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter((w) => w.length > 1),
      fees: {
        usualFee: this.get<boolean>('mk_usual_fee'), usualTxn: this.get<boolean>('mk_usual_txn'), extra: this.get<boolean>('mk_fees_on'),
        buyer: { rate: this.get<number>('mk_buyer_rate'), minMinor: m('mk_buyer_min'), maxMinor: m('mk_buyer_max') },
        seller: { rate: this.get<number>('mk_seller_rate'), minMinor: m('mk_seller_min'), maxMinor: m('mk_seller_max') },
      },
      reportsHide: this.get<number>('mk_reports_hide'), strikes: this.get<number>('mk_strikes'),
      backInStock: this.get<boolean>('mk_back_in_stock'), newFromSellers: this.get<boolean>('mk_new_from_sellers'), adLinks: this.get<boolean>('mk_ad_links'),
    };
  }
  /** The home page version visitors see. */
  homeVersion(): string { const v = this.get<string>('home_version'); return isHomeVersion(v) ? v : FIRST_VERSION; }
  nudgeHours(): number { return this.get('nudge_after_hours'); }
  flagHours(): number { return this.get('flag_after_hours'); }
  autoReleaseMinutes(): number { return this.get('auto_release_minutes'); }
  dispatchRemindHours(): number { return this.get('dispatch_remind_hours'); }
  unpaidCloseHours(): number { return this.get('unpaid_close_hours'); }
  /** Live numbers on the website: on or off, and the count each one needs before it shows. */
  siteNumbers() {
    return { on: this.get<boolean>('feature_site_numbers'), minCompleted: this.get<number>('site_min_completed'), minStarted: this.get<number>('site_min_started'),
      minRefunded: this.get<number>('site_min_refunded'), minAmbPaid: this.get<number>('site_min_amb_paid') };
  }
  repReplyMinutes(): number { return this.get('rep_reply_minutes'); }
  problemReplyHours(): number { return this.get('problem_reply_hours'); }
  handoverCodeTries(): number { return this.get('handover_code_tries'); }
  alertsEnabled(): boolean { return this.get('alerts_enabled'); }
  formsEnabled(): boolean { return this.get('forms_enabled'); }
  waNumber(): string { return this.get<string>('whatsapp_number'); }
  /** The ambassador programme's settings (Features → Ambassadors). Money in minor units. */
  ambassadors() {
    return {
      on: this.get<boolean>('feature_ambassadors') === true,
      sellerPct: this.get<number>('amb_seller_pct'), buyerPct: this.get<number>('amb_buyer_pct'),
      bonusMinor: Math.round(this.get<number>('amb_seller_bonus') * this.unit), bonusOrders: this.get<number>('amb_bonus_orders'),
      payoutDay: this.get<number>('amb_payout_day'), payoutMinMinor: Math.round(this.get<number>('amb_payout_min') * this.unit),
      terms: ([3, 6, 12] as const).filter((n) => this.get<boolean>(`amb_term_${n}`) !== false),
      noticeDays: this.get<number>('amb_notice_days'),
      applyWeb: this.get<boolean>('amb_apply_web') !== false, applyWhatsApp: this.get<boolean>('amb_apply_whatsapp') !== false,
      menuAfter: this.get<number>('amb_menu_after'),
    };
  }
  /** How people reach Hoolam: shown in the website footer and on the legal pages. */
  contact(): { email: string; phone: string; whatsapp: string; socials: NonNullable<ReturnType<typeof companySocialLink>>[] } {
    return {
      email: this.get<string>('contact_email'), phone: this.get<string>('contact_phone'), whatsapp: this.waNumber(),
      socials: COMPANY_SOCIAL_KINDS.map((k) => companySocialLink(k, this.get<string>(`company_${k}`))).filter((x): x is NonNullable<typeof x> => !!x),
    };
  }
}
