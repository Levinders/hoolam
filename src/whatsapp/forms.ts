/**
 * Which WhatsApp forms Hoolam can send right now, and why not when it can't.
 *   - Each form is sent in the state Meta says it's in (draft or published), never a guess from settings.
 *   - If WhatsApp refuses to send one, only that form rests for a while (30 minutes), then it's tried again.
 *   - Console → Settings → WhatsApp shows the list, with Meta's reason, and a "Try again now" button.
 * While a form can't be used, the chat asks the same questions one at a time, so nobody gets stuck.
 */

export const FORM_LABELS = {
  buy: 'Buy something',
  buyEdit: 'Buy something: edit order',
  sell: 'Sell something',
  sellEdit: 'Sell something: edit order',
  kyc: 'ID check',
  orders: 'My orders',
  order: 'One order (accept, dispatch, code, review)',
} as const;
export type FormKey = keyof typeof FORM_LABELS;
export const FORM_KEYS = Object.keys(FORM_LABELS) as FormKey[];

export type FormMode = 'draft' | 'published';
export interface FormUse { flowId: string; mode: FormMode }

export interface FormState {
  key: FormKey;
  label: string;
  /** ready: being sent · resting: WhatsApp refused it, tried again at `retryAt` · failed: couldn't be set up on Meta · off: not set up (see reason) */
  state: 'ready' | 'resting' | 'failed' | 'off';
  name: string | null;          // the form's name on Meta (hoolam_buy_…)
  mode: FormMode | null;        // how it's sent: Meta's own state
  reason: string | null;        // Meta's reason, in its words, or why it's off
  at: string | null;            // when this state started
  retryAt: string | null;       // resting until
  backup: boolean;              // the simpler backup version is in use (My orders / One order)
}

/** Meta's error, as plain as it comes: the "details" line when there is one. */
export function metaReason(raw: string | null | undefined): string {
  const text = String(raw ?? '').trim();
  const json = text.slice(text.indexOf('{'));
  try {
    const e = JSON.parse(json)?.error;
    const why = e?.error_data?.details || e?.error_user_msg || e?.message;
    if (why) return String(why).slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300) || 'WhatsApp refused it';
}

export class FormRegistry {
  private s = new Map<FormKey, FormState & { flowId: string | null; until: number }>();

  constructor(private readonly restMinutes = 30, private readonly now = () => Date.now(), private readonly log?: (l: string) => void) {
    for (const key of FORM_KEYS) this.s.set(key, this.blank(key, 'Not set up yet'));
  }

  private blank(key: FormKey, reason: string | null): FormState & { flowId: string | null; until: number } {
    return { key, label: FORM_LABELS[key], state: 'off', name: null, mode: null, reason, at: new Date(this.now()).toISOString(), retryAt: null, backup: false, flowId: null, until: 0 };
  }

  /** Created or found on Meta. `status` is Meta's: PUBLISHED or DRAFT. */
  ready(key: FormKey, r: { flowId: string; name: string; status: string; backup?: boolean; note?: string | null }): void {
    this.s.set(key, { ...this.blank(key, r.note ?? null), state: 'ready', flowId: r.flowId, name: r.name, mode: r.status === 'PUBLISHED' ? 'published' : 'draft', backup: !!r.backup });
  }

  /** Couldn't be set up on Meta. */
  failed(key: FormKey, reason: string, name: string | null = null): void {
    this.s.set(key, { ...this.blank(key, reason), state: 'failed', name });
  }

  /** Not set up, on purpose or for lack of something (dry run, no WHATSAPP_WABA_ID…). */
  off(key: FormKey, reason: string): void { this.s.set(key, this.blank(key, reason)); }

  /** Test helper and manual override: a form with a known id and mode. Null turns it off. */
  set(key: FormKey, f: FormUse | null): void {
    if (!f) return this.off(key, 'Turned off');
    this.ready(key, { flowId: f.flowId, name: this.s.get(key)?.name ?? key, status: f.mode === 'published' ? 'PUBLISHED' : 'DRAFT' });
  }

  /** The form to send, or null (then the chat asks instead). A rested form comes back by itself. */
  use(key: FormKey): FormUse | null {
    const f = this.s.get(key)!;
    if (f.state === 'resting' && this.now() >= f.until) {
      f.state = 'ready'; f.retryAt = null; f.reason = null; f.at = new Date(this.now()).toISOString();
      this.log?.(`${FORM_LABELS[key]} form: trying again after a rest`);
    }
    return f.state === 'ready' && f.flowId && f.mode ? { flowId: f.flowId, mode: f.mode } : null;
  }

  /** WhatsApp refused to send it: rest this one form, keep Meta's reason. */
  refused(key: FormKey, rawError: string | null | undefined): void {
    const f = this.s.get(key)!;
    if (f.state !== 'ready') return;
    const reason = metaReason(rawError);
    f.state = 'resting'; f.reason = reason; f.at = new Date(this.now()).toISOString();
    f.until = this.now() + this.restMinutes * 60_000; f.retryAt = new Date(f.until).toISOString();
    this.log?.(`${FORM_LABELS[key]} form refused by WhatsApp: ${reason}. The chat asks instead; trying again in ${this.restMinutes} minutes.`);
  }

  /** "Try again now": every resting form goes back to ready (failed ones need the Meta setup to run again). */
  wake(): void {
    for (const f of this.s.values()) if (f.state === 'resting') { f.state = 'ready'; f.until = 0; f.retryAt = null; f.reason = null; f.at = new Date(this.now()).toISOString(); }
  }

  get(key: FormKey): FormState { const { flowId: _f, until: _u, ...rest } = this.s.get(key)!; return rest; }
  list(): FormState[] { return FORM_KEYS.map((k) => this.get(k)); }
}
