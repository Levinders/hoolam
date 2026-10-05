import type { Queryable } from '../db.js';

export interface Button { id: string; title: string } // WhatsApp: max 3 buttons, title max 20 chars
export interface ListRow { id: string; title: string; description?: string } // title max 24, description max 72
export interface ListSection { title: string; rows: ListRow[] }              // section title max 24
export type Outbound =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: Button[] }
  | { kind: 'list'; text: string; button: string; sections: ListSection[]; header?: string; footer?: string } // max 10 rows; header/footer max 60
  | { kind: 'image'; mediaId: string; caption?: string }                                                      // caption max 1024
  | { kind: 'form'; text: string; cta: string; flowId: string; flowToken: string; screen: string; mode: 'draft' | 'published'; header?: string; footer?: string };

/** A pre-approved template: the only way to message someone who hasn't written to us in the last 24 hours. */
export interface Template {
  name: string;
  language: string;
  params: string[];          // fills {{1}}, {{2}}, ... in the body
  buttonPayloads?: string[]; // what each quick-reply button sends back to us
  buttonTitles?: string[];   // the button labels as approved in the template (for logs and the terminal chat)
  preview: string;           // readable version for logs and the outbound_messages table
}

export type SendStatus = 'SENT' | 'DRY_RUN' | 'FAILED' | 'NEEDS_TEMPLATE';

/** WhatsApp rejects template values with new lines, tabs or long runs of spaces. */
export const templateText = (s: string, max = 120) => s.replace(/[\n\r\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max);

/** Throws if a message breaks WhatsApp's limits, so mistakes show up in tests, not on someone's phone. */
export function checkLimits(msg: Outbound): void {
  if (msg.kind === 'buttons') {
    if (msg.buttons.length < 1 || msg.buttons.length > 3) throw new Error('WhatsApp allows 1 to 3 buttons');
    for (const b of msg.buttons) if (b.title.length > 20) throw new Error(`Button title too long: "${b.title}"`);
  }
  if (msg.kind === 'list') {
    if (msg.button.length > 20) throw new Error(`List button too long: "${msg.button}"`);
    if ((msg.header ?? '').length > 60 || (msg.footer ?? '').length > 60) throw new Error('List header/footer max 60 characters');
    const rows = msg.sections.flatMap((s) => s.rows);
    if (rows.length < 1 || rows.length > 10) throw new Error('WhatsApp lists allow 1 to 10 rows in total');
    if (msg.sections.length > 10) throw new Error('WhatsApp lists allow up to 10 sections');
    for (const s of msg.sections) if (s.title.length > 24) throw new Error(`Section title too long: "${s.title}"`);
    for (const r of rows) {
      if (r.title.length > 24) throw new Error(`List row title too long: "${r.title}"`);
      if ((r.description ?? '').length > 72) throw new Error(`List row description too long: "${r.description}"`);
      if (r.id.length > 200) throw new Error('List row id too long');
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('List row ids must be unique');
  }
  if (msg.kind === 'form' && msg.cta.length > 30) throw new Error(`Form button too long: "${msg.cta}"`);
  if (msg.kind === 'image' && (msg.caption ?? '').length > 1024) throw new Error('Image caption too long');
}

export interface MessengerOptions {
  dryRun: boolean;
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const DAY_MS = 24 * 3600_000;

/**
 * Sends WhatsApp messages through the Cloud API.
 * WhatsApp only allows free-form messages within 24 hours of the person's last message to us.
 * Outside that window a pre-approved template is required, so we record the message as
 * NEEDS_TEMPLATE instead of sending something WhatsApp would reject.
 */
export class Messenger {
  private readonly fetch: typeof fetch;
  constructor(private readonly db: Queryable, private readonly o: MessengerOptions) {
    this.fetch = o.fetchImpl ?? fetch;
  }

  async send(phone: string, msg: Outbound): Promise<SendStatus> {
    checkLimits(msg);
    const s = await this.db.query('SELECT last_inbound_at FROM chat_sessions WHERE phone=$1', [phone]);
    const last: Date | null = s.rows[0]?.last_inbound_at ?? null;
    if (!last || Date.now() - new Date(last).getTime() > DAY_MS) {
      this.o.log?.(`whatsapp not sent to …${phone.slice(-4)}: outside the 24-hour window (needs a template)`);
      await this.record(phone, msg, 'NEEDS_TEMPLATE', 'Outside the 24-hour window; send an approved template instead');
      return 'NEEDS_TEMPLATE';
    }
    return this.deliver(phone, msg, toPayload(phone.replace(/^\+/, ''), msg));
  }

  /** Sends an approved template. Allowed outside the 24-hour window. */
  async sendTemplate(phone: string, t: Template): Promise<SendStatus> {
    const to = phone.replace(/^\+/, '');
    const payload = {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: t.name, language: { code: t.language },
        components: [
          ...(t.params.length ? [{ type: 'body', parameters: t.params.map((p) => ({ type: 'text', text: templateText(p) })) }] : []),
          ...(t.buttonPayloads ?? []).map((p, i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: p }] })),
        ],
      },
    };
    const shown: Outbound = t.buttonTitles?.length && t.buttonPayloads?.length
      ? { kind: 'buttons', text: `[template ${t.name}] ${t.preview}`, buttons: t.buttonPayloads.map((id, i) => ({ id, title: t.buttonTitles![i] ?? id })) }
      : { kind: 'text', text: `[template ${t.name}] ${t.preview}` };
    return this.deliver(phone, shown, payload, 'template');
  }

  private async deliver(phone: string, msg: Outbound, payload: Record<string, unknown>, kind?: string): Promise<SendStatus> {
    if (this.o.dryRun) {
      this.o.log?.(`[whatsapp → ${phone}] ${render(msg)}`);
      await this.record(phone, msg, 'DRY_RUN', undefined, kind);
      return 'DRY_RUN';
    }
    try {
      const res = await this.fetch(`https://graph.facebook.com/${this.o.graphVersion}/${this.o.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      this.o.log?.(`whatsapp sent to …${phone.slice(-4)}${kind ? ' (' + kind + ')' : ''}`);
      await this.record(phone, msg, 'SENT', undefined, kind);
      return 'SENT';
    } catch (err) {
      this.o.log?.(`whatsapp send FAILED to …${phone.slice(-4)}${kind ? ' (' + kind + ')' : ''}: ${(err as Error).message}`);
      await this.record(phone, msg, 'FAILED', (err as Error).message, kind);
      return 'FAILED';
    }
  }

  private async record(phone: string, msg: Outbound, status: string, error?: string, kind?: string) {
    await this.db.query('INSERT INTO outbound_messages (phone, kind, body, status, error) VALUES ($1,$2,$3,$4,$5)', [phone, kind ?? msg.kind, JSON.stringify(msg), status, error ?? null]);
  }
}

export function toPayload(to: string, msg: Outbound): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', to };
  if (msg.kind === 'text') return { ...base, type: 'text', text: { body: msg.text, preview_url: false } };
  if (msg.kind === 'image') return { ...base, type: 'image', image: { id: msg.mediaId, ...(msg.caption ? { caption: msg.caption } : {}) } };
  if (msg.kind === 'form') {
    return {
      ...base, type: 'interactive',
      interactive: {
        type: 'flow', body: { text: msg.text },
        ...(msg.header ? { header: { type: 'text', text: msg.header } } : {}),
        ...(msg.footer ? { footer: { text: msg.footer } } : {}),
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3', flow_id: msg.flowId, flow_token: msg.flowToken, flow_cta: msg.cta, mode: msg.mode,
            flow_action: 'navigate', flow_action_payload: { screen: msg.screen },
          },
        },
      },
    };
  }
  if (msg.kind === 'buttons') {
    return {
      ...base, type: 'interactive',
      interactive: { type: 'button', body: { text: msg.text }, action: { buttons: msg.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } },
    };
  }
  return {
    ...base, type: 'interactive',
    interactive: {
      type: 'list', body: { text: msg.text },
      ...(msg.header ? { header: { type: 'text', text: msg.header } } : {}),
      ...(msg.footer ? { footer: { text: msg.footer } } : {}),
      action: {
        button: msg.button,
        sections: msg.sections.map((s) => ({ title: s.title, rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) })),
      },
    },
  };
}

export function render(msg: Outbound): string {
  if (msg.kind === 'text') return msg.text;
  if (msg.kind === 'buttons') return `${msg.text}  ${msg.buttons.map((b) => `[${b.title}]`).join(' ')}`;
  if (msg.kind === 'image') return `[photo]${msg.caption ? ' ' + msg.caption : ''}`;
  if (msg.kind === 'form') return `${msg.text}  [📝 ${msg.cta}]`;
  return `${msg.header ? msg.header + '\n' : ''}${msg.text}${msg.footer ? '\n' + msg.footer : ''}  [${msg.button} ▾: ${msg.sections.flatMap((s) => s.rows.map((r) => r.title)).join(' | ')}]`;
}
