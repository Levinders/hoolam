import type { Config } from './config.js';
import type { Db, Queryable } from './db.js';
import { PRICING, type PricingRules } from './pricing.js';

/**
 * Settings staff can change from the console. Each has a default (from Render's environment or the code),
 * a type and limits, so a typo can't break the service. Changes apply to NEW deals only: a deal keeps
 * the fee and limits it was created with.
 */
export type SettingType = 'number' | 'money' | 'percent' | 'hours' | 'boolean' | 'phone';

export interface SettingDef {
  key: string;
  group: 'Fees' | 'Limits' | 'Timing' | 'WhatsApp';
  label: string;
  help: string;
  type: SettingType;
  min?: number;
  max?: number;
}

export const SETTING_DEFS: SettingDef[] = [
  { key: 'fee_rate_percent', group: 'Fees', label: 'Fee rate', help: 'Percentage of the item price.', type: 'percent', min: 0, max: 20 },
  { key: 'fee_min', group: 'Fees', label: 'Minimum fee', help: 'The smallest fee on any deal.', type: 'money', min: 0, max: 100_000 },
  { key: 'fee_max', group: 'Fees', label: 'Maximum fee', help: 'The fee never goes above this.', type: 'money', min: 0, max: 1_000_000 },
  { key: 'fee_round_to', group: 'Fees', label: 'Round fees to', help: 'Fees are rounded to the nearest multiple of this.', type: 'money', min: 1, max: 10_000 },
  { key: 'max_deal', group: 'Limits', label: 'Largest deal', help: 'Most a single deal can be (before KYC). You can raise it for one person on their page.', type: 'money', min: 1_000, max: 100_000_000 },
  { key: 'seller_accept_hours', group: 'Timing', label: 'Seller has to accept within', help: 'For deals a buyer starts. After this, the deal closes.', type: 'hours', min: 1, max: 336 },
  { key: 'nudge_after_hours', group: 'Timing', label: 'Remind the buyer after', help: 'Hours after shipping before we ask the buyer if the item arrived.', type: 'hours', min: 1, max: 336 },
  { key: 'flag_after_hours', group: 'Timing', label: 'Flag for the team after', help: 'Hours after shipping before an unconfirmed deal appears in Needs action.', type: 'hours', min: 1, max: 720 },
  { key: 'whatsapp_number', group: 'WhatsApp', label: 'Hoolam\'s WhatsApp number', help: 'The number people message. Used in every "chat with Hoolam" link: the website, seller pages and payment links. Digits only, with the country code.', type: 'phone' },
  { key: 'alerts_enabled', group: 'WhatsApp', label: 'Alert the other side by number', help: 'Send "New order request" / "Payment request" when someone types the other side\'s number.', type: 'boolean' },
  { key: 'forms_enabled', group: 'WhatsApp', label: 'WhatsApp forms', help: 'Offer the buy and sell forms (needs Meta business verification).', type: 'boolean' },
];

type Value = number | boolean | string;
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
      max_deal: this.c.MAX_DEAL_MINOR / this.unit,
      seller_accept_hours: this.c.SELLER_ACCEPT_HOURS, nudge_after_hours: this.c.NUDGE_AFTER_HOURS, flag_after_hours: this.c.FLAG_AFTER_HOURS,
      whatsapp_number: this.c.WHATSAPP_PUBLIC_NUMBER.replace(/\D/g, ''),
      alerts_enabled: true, forms_enabled: this.c.WHATSAPP_BUY_FORM,
    };
  }

  async load(): Promise<void> {
    const r = await this.db.query('SELECT key, value FROM settings');
    this.values = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  }

  all(): Values { return { ...this.defaults(), ...this.values }; }
  get<T extends Value>(key: string): T { return (this.all()[key] ?? this.defaults()[key]) as T; }

  /** Checks a change. Returns an error message, or null when fine. */
  validate(key: string, value: unknown): string | null {
    const def = SETTING_DEFS.find((d) => d.key === key);
    if (!def) return `Unknown setting ${key}`;
    if (def.type === 'boolean') return typeof value === 'boolean' ? null : `${def.label} must be on or off`;
    if (def.type === 'phone') {
      if (typeof value !== 'string' || !/^\d{8,15}$/.test(value)) return 'Enter the full number with the country code, digits only. For example 2348012345678.';
      if (value.startsWith('0')) return 'Start with the country code (234 for Nigeria), not 0.';
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
  maxDealMinor(): number { return Math.round(this.get<number>('max_deal') * this.unit); }
  acceptHours(): number { return this.get('seller_accept_hours'); }
  nudgeHours(): number { return this.get('nudge_after_hours'); }
  flagHours(): number { return this.get('flag_after_hours'); }
  alertsEnabled(): boolean { return this.get('alerts_enabled'); }
  formsEnabled(): boolean { return this.get('forms_enabled'); }
  waNumber(): string { return this.get<string>('whatsapp_number'); }
}
