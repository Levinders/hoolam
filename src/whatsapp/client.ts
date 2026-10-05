import type { Queryable } from '../db.js';

export interface Button { id: string; title: string } // WhatsApp: max 3 buttons, title max 20 chars
export type Outbound =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: Button[] };

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

  async send(phone: string, msg: Outbound): Promise<void> {
    if (msg.kind === 'buttons') {
      if (msg.buttons.length < 1 || msg.buttons.length > 3) throw new Error('WhatsApp allows 1 to 3 buttons');
      for (const b of msg.buttons) if (b.title.length > 20) throw new Error(`Button title too long: "${b.title}"`);
    }
    const s = await this.db.query('SELECT last_inbound_at FROM chat_sessions WHERE phone=$1', [phone]);
    const last: Date | null = s.rows[0]?.last_inbound_at ?? null;
    if (!last || Date.now() - new Date(last).getTime() > DAY_MS) {
      this.o.log?.(`whatsapp not sent to …${phone.slice(-4)}: outside the 24-hour window (needs a template)`);
      await this.record(phone, msg, 'NEEDS_TEMPLATE', 'Outside the 24-hour window; send an approved template instead');
      return;
    }
    if (this.o.dryRun) {
      this.o.log?.(`[whatsapp → ${phone}] ${render(msg)}`);
      await this.record(phone, msg, 'DRY_RUN');
      return;
    }
    const to = phone.replace(/^\+/, '');
    const payload = msg.kind === 'text'
      ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text, preview_url: false } }
      : {
          messaging_product: 'whatsapp', to, type: 'interactive',
          interactive: { type: 'button', body: { text: msg.text }, action: { buttons: msg.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } },
        };
    try {
      const res = await this.fetch(`https://graph.facebook.com/${this.o.graphVersion}/${this.o.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      this.o.log?.(`whatsapp sent to …${phone.slice(-4)}`);
      await this.record(phone, msg, 'SENT');
    } catch (err) {
      this.o.log?.(`whatsapp send FAILED to …${phone.slice(-4)}: ${(err as Error).message}`);
      await this.record(phone, msg, 'FAILED', (err as Error).message);
    }
  }

  private async record(phone: string, msg: Outbound, status: string, error?: string) {
    await this.db.query('INSERT INTO outbound_messages (phone, kind, body, status, error) VALUES ($1,$2,$3,$4,$5)', [phone, msg.kind, JSON.stringify(msg), status, error ?? null]);
  }
}

export function render(msg: Outbound): string {
  return msg.kind === 'text' ? msg.text : `${msg.text}  ${msg.buttons.map((b) => `[${b.title}]`).join(' ')}`;
}
