import type { Queryable } from '../db.js';
import type { Art, ChatArt, Clip, StickerName } from '../chat-art/index.js';

export interface Button { id: string; title: string } // WhatsApp: max 3 buttons, title max 20 chars
export interface ListRow { id: string; title: string; description?: string } // title max 24, description max 72
export interface ListSection { title: string; rows: ListRow[] }              // section title max 24
/** Hoolam's contact card: "Save contact" opens the phone's new-contact screen, filled in. */
export interface ContactCard { name: string; phone: string; org?: string; email?: string; url?: string }
export type Outbound = (
  | { kind: 'text'; text: string; noMenu?: boolean }   // noMenu: keep it plain (e.g. a message meant to be forwarded)
  | { kind: 'location'; latitude: number; longitude: number; name?: string; address?: string } // a map pin (tap for directions)
  | { kind: 'contact'; contact: ContactCard }
  | { kind: 'buttons'; text: string; buttons: Button[]; headerImage?: string } // headerImage: a media id shown on top (set by the Messenger from `art`)
  | { kind: 'list'; text: string; button: string; sections: ListSection[]; header?: string; footer?: string } // max 10 rows; header/footer max 60
  | { kind: 'image'; mediaId: string; caption?: string }                                                      // caption max 1024
  | { kind: 'form'; text: string; cta: string; flowId: string; flowToken: string; screen: string; mode: 'draft' | 'published'; header?: string; footer?: string; live?: boolean; data?: Record<string, unknown> } // live: the form asks our endpoint for its first screen; data: fills in a form's first screen
) & {
  replyTo?: string;  // the person's message this answers (WhatsApp shows it quoted above our reply)
  art?: Art;         // a picture: on top of a button message, as a text message's picture with the text under it, or just before
  clips?: Clip[];    // voice notes / videos after it, only if the owner has uploaded them (`once`: first time only)
  sticker?: StickerName; // a sticker after it
  react?: { to: string; emoji: string }; // react to their message (✅ instead of a "Got it" text)
};
/** The extras a message carries, kept when a message is reshaped. */
const extrasOf = (m: Outbound) => ({
  ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.art ? { art: m.art } : {}), ...(m.clips ? { clips: m.clips } : {}),
  ...(m.sticker ? { sticker: m.sticker } : {}), ...(m.react ? { react: m.react } : {}),
});

/** A pre-approved template: the only way to message someone who hasn't written to us in the last 24 hours. */
export interface Template {
  name: string;
  language: string;
  params: string[];          // fills {{1}}, {{2}}, ... in the body
  buttonPayloads?: string[]; // what each quick-reply button sends back to us
  buttonTitles?: string[];   // the button labels as approved in the template (for logs and the terminal chat)
  preview: string;           // readable version for logs and the outbound_messages table
  maxParam?: number;         // longest value allowed (default 120; the support message allows 600)
  replyTo?: string;          // the person's message this answers (shown quoted)
  headerImage?: string;      // a media id for templates with a picture at the top
  art?: Art;                 // or the picture to make for it (when the template has a picture at the top)
  codeButton?: string;       // an authentication template's code, for its "Copy code" button
}

export type SendStatus = 'SENT' | 'DRY_RUN' | 'FAILED' | 'NEEDS_TEMPLATE';

/** WhatsApp rejects template values with new lines, tabs or long runs of spaces. */
export const templateText = (s: string, max = 120) => s.replace(/[\n\r\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max);

export const MENU_BUTTON: Button = { id: 'menu:open', title: 'Main menu' };

/**
 * "Main menu" as the last option wherever there's room, so nobody is ever stuck: plain messages get the button,
 * messages with 1 or 2 buttons get it as the last one, lists get it as the last row. Messages that already have it,
 * have 3 buttons, are the menu itself, or are too long for a button message stay as they are.
 */
export function withMenuOption(msg: Outbound): Outbound {
  if (msg.kind === 'text') {
    if (msg.noMenu || msg.text.length > 1024) return msg;
    return { kind: 'buttons', text: msg.text, buttons: [MENU_BUTTON], ...extrasOf(msg) };
  }
  if (msg.kind === 'buttons') {
    if (msg.buttons.length >= 3 || msg.buttons.some((b) => b.id === 'menu:open')) return msg;
    return { ...msg, buttons: [...msg.buttons, MENU_BUTTON] };
  }
  if (msg.kind === 'list') {
    const rows = msg.sections.flatMap((x) => x.rows);
    if (rows.length >= 10 || rows.some((r) => r.id.startsWith('menu:')) || msg.sections.length >= 10) return msg;
    return { ...msg, sections: [...msg.sections, { title: 'More', rows: [{ id: 'menu:open', title: '🏠 Main menu' }] }] };
  }
  return msg;
}

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

  /** Template name → Meta's status (APPROVED, PENDING, REJECTED…). Filled in on start and refreshed on a timer. */
  private readonly templates = new Map<string, string>();
  setTemplateStatus(name: string, status: string | null) { if (status) this.templates.set(name, status); }
  templateStatus(name: string): string | null { return this.templates.get(name) ?? null; }
  /** A reworded template's earlier name: used while Meta reviews the new one, if the old one was approved. */
  private readonly previous = new Map<string, string>();
  private readonly previousShape = new Map<string, { params?: number[]; buttons?: number }>();
  /** `shape`: which of the new values (0-based) and how many buttons the older version takes, when they differ. */
  setTemplateReplaces(name: string, previousName: string, shape?: { params?: number[]; buttons?: number }) {
    this.previous.set(name, previousName);
    if (shape && (shape.params || shape.buttons !== undefined)) this.previousShape.set(previousName, shape);
  }
  /** Draws and uploads the chat's pictures, voice notes and stickers (none in tests that don't set it). */
  private art: ChatArt | null = null;
  setArt(art: ChatArt) { this.art = art; }

  /** Templates with a picture at the top (their older versions have none). */
  private readonly imageHeaders = new Set<string>();
  setTemplateImageHeader(name: string) { this.imageHeaders.add(name); }
  /** The approved name to send under (the template itself, or the version it replaces), or null if neither is approved. */
  usableTemplate(name: string): string | null {
    if (this.templateStatus(name) === 'APPROVED') return name;
    const prev = this.previous.get(name);
    return prev && this.templateStatus(prev) === 'APPROVED' ? prev : null;
  }

  /**
   * Sends a chat message. Outside the 24-hour window, sends the fallback template instead if Meta has approved it;
   * otherwise records the message as NEEDS_TEMPLATE so the team can see it in the console.
   */
  async send(phone: string, msg: Outbound, fallback?: Template): Promise<SendStatus> {
    msg = withMenuOption(msg);
    checkLimits(msg);
    const s = await this.db.query('SELECT last_inbound_at FROM chat_sessions WHERE phone=$1', [phone]);
    const last: Date | null = s.rows[0]?.last_inbound_at ?? null;
    if (!last || Date.now() - new Date(last).getTime() > DAY_MS) {
      const use = fallback ? this.usableTemplate(fallback.name) : null;
      if (fallback && use) {
        this.o.log?.(`whatsapp …${phone.slice(-4)} is outside the 24-hour window: sending template ${use}`);
        return this.sendTemplate(phone, { ...fallback, name: use, art: fallback.art ?? msg.art });
      }
      const why = fallback ? `template ${fallback.name} is ${this.templateStatus(fallback.name)?.toLowerCase() ?? 'not on Meta yet'}` : 'no template for this message';
      this.o.log?.(`whatsapp not sent to …${phone.slice(-4)}: outside the 24-hour window (${why})`);
      await this.record(phone, msg, 'NEEDS_TEMPLATE', `Outside the 24-hour window; ${why}`);
      return 'NEEDS_TEMPLATE';
    }
    return this.withExtras(phone, msg);
  }

  /**
   * The message with its extras: a reaction first, the picture (on top of a button message, as a text message's
   * picture, or just before), then voice notes, videos and a sticker. Extras never stop the message: if a picture
   * can't be made, the message goes without it.
   */
  private async withExtras(phone: string, msg: Outbound): Promise<SendStatus> {
    const to = phone.replace(/^\+/, '');
    const quiet = { quiet: true };
    if (msg.react && !this.o.dryRun) await this.deliver(phone, { kind: 'text', text: `[reaction ${msg.react.emoji}]` }, { messaging_product: 'whatsapp', to, type: 'reaction', reaction: { message_id: msg.react.to, emoji: msg.react.emoji } }, 'reaction', quiet);
    let main: Outbound = msg;
    if (msg.art && this.art && !this.o.dryRun) { // in dry run the message is logged as it is (the art is kept in its record)
      const id = await this.art.image(msg.art);
      if (id) {
        if (msg.kind === 'buttons') main = { ...msg, headerImage: id };
        else if (msg.kind === 'text' && msg.text.length <= 1024) main = { kind: 'image', mediaId: id, caption: msg.text, ...extrasOf(msg) };
        else await this.deliver(phone, { kind: 'image', mediaId: id }, toPayload(to, { kind: 'image', mediaId: id }), 'image', quiet);
      }
    }
    const status = await this.deliver(phone, main, toPayload(to, main));
    if (status === 'FAILED' && main !== msg) return this.deliver(phone, msg, toPayload(to, msg)); // the picture was refused: send it plain
    if (!this.art) return status;
    for (const c of msg.clips ?? []) {
      const clip = await this.art.clip(phone, c);
      if (clip) await this.deliver(phone, { kind: 'text', text: `[${clip.kind} ${c.slot}]` }, { messaging_product: 'whatsapp', to, type: clip.kind, [clip.kind]: { id: clip.id } }, clip.kind, quiet);
    }
    if (msg.sticker) {
      const id = await this.art.sticker(msg.sticker);
      if (id) await this.deliver(phone, { kind: 'text', text: `[sticker ${msg.sticker}]` }, { messaging_product: 'whatsapp', to, type: 'sticker', sticker: { id } }, 'sticker', quiet);
    }
    return status;
  }

  /** Sends an approved template. Allowed outside the 24-hour window. */
  /** Has Meta approved this template (or the version it replaces)? */
  canUseTemplate(name: string): boolean { return this.usableTemplate(name) !== null; }

  /** Is the person's 24-hour window open (they messaged Hoolam in the last 24 hours)? */
  async windowOpen(phone: string): Promise<boolean> {
    const s = await this.db.query('SELECT last_inbound_at FROM chat_sessions WHERE phone=$1', [phone]);
    const last: Date | null = s.rows[0]?.last_inbound_at ?? null;
    return !!last && Date.now() - new Date(last).getTime() < DAY_MS;
  }

  async sendTemplate(phone: string, tpl: Template): Promise<SendStatus> {
    const t = { ...tpl, name: this.usableTemplate(tpl.name) ?? tpl.name };
    if (!t.headerImage && t.art && this.art && this.imageHeaders.has(t.name)) t.headerImage = (await this.art.image(t.art)) ?? undefined;
    // the older version may take different values or fewer buttons: send it what it has
    const shape = t.name !== tpl.name ? this.previousShape.get(t.name) : undefined;
    if (shape?.params) t.params = shape.params.map((i) => tpl.params[i] ?? '');
    if (shape?.buttons !== undefined) {
      t.buttonPayloads = t.buttonPayloads?.slice(0, shape.buttons);
      t.buttonTitles = t.buttonTitles?.slice(0, shape.buttons);
    }
    const to = phone.replace(/^\+/, '');
    const payload = {
      messaging_product: 'whatsapp', to, type: 'template',
      ...(t.replyTo ? { context: { message_id: t.replyTo } } : {}),
      template: {
        name: t.name, language: { code: t.language },
        components: [
          ...(t.headerImage && this.imageHeaders.has(t.name) ? [{ type: 'header', parameters: [{ type: 'image', image: { id: t.headerImage } }] }] : []),
          ...(t.params.length ? [{ type: 'body', parameters: t.params.map((p) => ({ type: 'text', text: templateText(p, t.maxParam ?? 120) })) }] : []),
          ...(t.buttonPayloads ?? []).map((p, i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: p }] })),
          ...(t.codeButton ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.codeButton }] }] : []),
        ],
      },
    };
    const shown: Outbound = t.buttonTitles?.length && t.buttonPayloads?.length
      ? { kind: 'buttons', text: `[template ${t.name}] ${t.preview}`, buttons: t.buttonPayloads.map((id, i) => ({ id, title: t.buttonTitles![i] ?? id })) }
      : { kind: 'text', text: `[template ${t.name}] ${t.preview}` };
    return this.deliver(phone, shown, payload, 'template');
  }

  private async deliver(phone: string, msg: Outbound, payload: Record<string, unknown>, kind?: string, opts: { quiet?: boolean } = {}): Promise<SendStatus> {
    if (this.o.dryRun) {
      if (!opts.quiet) this.o.log?.(`[whatsapp → ${phone}] ${render(msg)}`); // extras (pictures, stickers) stay out of the chat log
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
      let waId: string | null = null;
      try { waId = ((await res.json()) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null; } catch { /* no id: fine */ }
      this.o.log?.(`whatsapp sent to …${phone.slice(-4)}${kind ? ' (' + kind + ')' : ''}`);
      await this.record(phone, msg, 'SENT', undefined, kind, waId);
      return 'SENT';
    } catch (err) {
      this.o.log?.(`whatsapp send FAILED to …${phone.slice(-4)}${kind ? ' (' + kind + ')' : ''}: ${(err as Error).message}`);
      await this.record(phone, msg, 'FAILED', (err as Error).message, kind);
      return 'FAILED';
    }
  }

  private async record(phone: string, msg: Outbound, status: string, error?: string, kind?: string, waId: string | null = null) {
    // dry run: a made-up id, so "seen" can be tried out in tests and on the test number
    const id = waId ?? (status === 'DRY_RUN' ? `dry.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}` : null);
    await this.db.query('INSERT INTO outbound_messages (phone, kind, body, status, error, wa_id) VALUES ($1,$2,$3,$4,$5,$6)', [phone, kind ?? msg.kind, JSON.stringify(msg), status, error ?? null, id]);
  }

  /** WhatsApp's id of the last message we sent this person (to match a "read" receipt later). */
  async lastSentId(phone: string): Promise<string | null> {
    const r = await this.db.query(`SELECT wa_id FROM outbound_messages WHERE phone=$1 AND status IN ('SENT','DRY_RUN') ORDER BY id DESC LIMIT 1`, [phone]);
    return r.rows[0]?.wa_id ?? null;
  }

  /**
   * Their message turns blue-ticked and "typing…" shows until our reply (WhatsApp shows it for up to 25 seconds).
   * Never throws: if WhatsApp refuses, the reply still goes as normal.
   */
  async markReadTyping(messageId: string): Promise<void> {
    if (this.o.dryRun || !messageId || !messageId.startsWith('wamid.')) return;
    try {
      const res = await this.fetch(`https://graph.facebook.com/${this.o.graphVersion}/${this.o.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }),
      });
      if (!res.ok) this.o.log?.(`typing indicator refused (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    } catch (e) { this.o.log?.(`typing indicator failed: ${(e as Error).message}`); }
  }
}

export function toPayload(to: string, msg: Outbound): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', to, ...(msg.replyTo ? { context: { message_id: msg.replyTo } } : {}) };
  if (msg.kind === 'location') return { ...base, type: 'location', location: { latitude: msg.latitude, longitude: msg.longitude, ...(msg.name ? { name: msg.name } : {}), ...(msg.address ? { address: msg.address } : {}) } };
  if (msg.kind === 'contact') {
    const c = msg.contact;
    const digits = c.phone.replace(/\D/g, '');
    return {
      ...base, type: 'contacts',
      contacts: [{
        name: { formatted_name: c.name, first_name: c.name },
        phones: [{ phone: '+' + digits, type: 'WORK', wa_id: digits }],
        ...(c.org ? { org: { company: c.org } } : {}),
        ...(c.email ? { emails: [{ email: c.email, type: 'WORK' }] } : {}),
        ...(c.url ? { urls: [{ url: c.url, type: 'WORK' }] } : {}),
      }],
    };
  }
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
            ...(msg.live ? { flow_action: 'data_exchange' } : { flow_action: 'navigate', flow_action_payload: { screen: msg.screen, ...(msg.data ? { data: msg.data } : {}) } }),
          },
        },
      },
    };
  }
  if (msg.kind === 'buttons') {
    return {
      ...base, type: 'interactive',
      interactive: {
        type: 'button', body: { text: msg.text },
        ...(msg.headerImage ? { header: { type: 'image', image: { id: msg.headerImage } } } : {}),
        action: { buttons: msg.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
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
  if (msg.kind === 'location') return `[📍 ${msg.name ?? 'location'} ${msg.latitude},${msg.longitude}]`;
  if (msg.kind === 'contact') return `[📇 contact card: ${msg.contact.name} +${msg.contact.phone.replace(/\D/g, '')}]`;
  if (msg.kind === 'form') return `${msg.text}  [📝 ${msg.cta}]`;
  return `${msg.header ? msg.header + '\n' : ''}${msg.text}${msg.footer ? '\n' + msg.footer : ''}  [${msg.button} ▾: ${msg.sections.flatMap((s) => s.rows.map((r) => r.title)).join(' | ')}]`;
}
