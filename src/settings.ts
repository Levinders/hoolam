import type { Config } from './config.js';
import type { Db, Queryable } from './db.js';
import { checkBands, DEFAULT_TXN_BANDS, PRICING, type FeeBand, type PricingRules, type TxnFees } from './pricing.js';
import { COMPANY_SOCIAL_KINDS, COMPANY_SOCIAL_NAMES, companySocialLink, parseCompanySocial, type CompanySocialKind } from './socials.js';

/**
 * Settings staff can change from the console. Each has a default (from Render's environment or the code),
 * a type and limits, so a typo can't break the service. Changes apply to NEW deals only: a deal keeps
 * the fee and limits it was created with.
 */
export type SettingType = 'number' | 'money' | 'percent' | 'hours' | 'minutes' | 'boolean' | 'phone' | 'email' | 'social' | 'bands';

export interface SettingDef {
  key: string;
  group: 'Fees' | 'Limits' | 'Timing' | 'WhatsApp' | 'Contact';
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
  { key: 'max_deal', group: 'Limits', label: 'Largest order', help: 'Most a single order can be (before KYC). You can raise it for one person on their page.', type: 'money', min: 1_000, max: 100_000_000, core: true },
  { key: 'seller_accept_hours', group: 'Timing', label: 'Seller has to accept within', help: 'For orders a buyer starts. After this, the order closes.', type: 'hours', min: 1, max: 336 },
  { key: 'nudge_after_hours', group: 'Timing', label: 'Remind the buyer after', help: 'Hours after shipping before we ask the buyer if the item arrived.', type: 'hours', min: 1, max: 336 },
  { key: 'auto_release_minutes', group: 'Timing', label: 'Pay the seller automatically after', help: 'Once the handover code is entered, the buyer has this long to tap "I\'m happy" or report a problem. If they do neither, the seller is paid.', type: 'minutes', min: 30, max: 20_160 },
  { key: 'dispatch_remind_hours', group: 'Timing', label: 'Remind the seller to dispatch after', help: 'Hours after the buyer pays before we remind a seller who hasn\'t dispatched.', type: 'hours', min: 1, max: 336 },
  { key: 'flag_after_hours', group: 'Timing', label: 'Flag for the team after', help: 'Hours after shipping before an unconfirmed order appears in Needs action.', type: 'hours', min: 1, max: 720 },
  { key: 'whatsapp_number', group: 'WhatsApp', label: 'Hoolam\'s WhatsApp number', help: 'The number people message. Used in every "chat with Hoolam" link: the website, seller pages and payment links. For example 07034577787.', type: 'phone', core: true },
  { key: 'alerts_enabled', group: 'WhatsApp', label: 'Alert the other side by number', help: 'Send "New order request" / "Payment request" when someone types the other side\'s number.', type: 'boolean' },
  { key: 'contact_email', group: 'Contact', label: 'Email', help: 'Where people can write to Hoolam. Shown in the website footer and on the legal pages.', type: 'email' },
  { key: 'contact_phone', group: 'Contact', label: 'Phone for calls', help: 'Optional. Leave it empty to show Hoolam\'s WhatsApp number instead.', type: 'phone', optional: true },
  ...COMPANY_SOCIAL_KINDS.map((k): SettingDef => ({ key: `company_${k}`, group: 'Contact', label: COMPANY_SOCIAL_NAMES[k], help: `Hoolam's ${COMPANY_SOCIAL_NAMES[k]} page. Paste the link or type the username. Empty hides it.`, type: 'social', social: k, optional: true })),
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
      max_deal: this.c.MAX_DEAL_MINOR / this.unit,
      auto_release_minutes: 1440, dispatch_remind_hours: 12,
      seller_accept_hours: this.c.SELLER_ACCEPT_HOURS, nudge_after_hours: this.c.NUDGE_AFTER_HOURS, flag_after_hours: this.c.FLAG_AFTER_HOURS,
      whatsapp_number: this.c.WHATSAPP_PUBLIC_NUMBER.replace(/\D/g, ''),
      alerts_enabled: true, forms_enabled: this.c.WHATSAPP_BUY_FORM,
      contact_email: 'hello@hoolam.com', contact_phone: '',
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
  acceptHours(): number { return this.get('seller_accept_hours'); }
  nudgeHours(): number { return this.get('nudge_after_hours'); }
  flagHours(): number { return this.get('flag_after_hours'); }
  autoReleaseMinutes(): number { return this.get('auto_release_minutes'); }
  dispatchRemindHours(): number { return this.get('dispatch_remind_hours'); }
  alertsEnabled(): boolean { return this.get('alerts_enabled'); }
  formsEnabled(): boolean { return this.get('forms_enabled'); }
  waNumber(): string { return this.get<string>('whatsapp_number'); }
  /** How people reach Hoolam: shown in the website footer and on the legal pages. */
  contact(): { email: string; phone: string; whatsapp: string; socials: NonNullable<ReturnType<typeof companySocialLink>>[] } {
    return {
      email: this.get<string>('contact_email'), phone: this.get<string>('contact_phone'), whatsapp: this.waNumber(),
      socials: COMPANY_SOCIAL_KINDS.map((k) => companySocialLink(k, this.get<string>(`company_${k}`))).filter((x): x is NonNullable<typeof x> => !!x),
    };
  }
}
