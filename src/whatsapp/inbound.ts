import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Inbound {
  id: string;            // WhatsApp message id, used to ignore duplicates
  phone: string;         // E.164 with +
  name: string | null;
  type: 'text' | 'button' | 'audio' | 'image' | 'welcome' | 'other'; // welcome = they opened the chat for the first time
  text: string;          // typed text, or the button title
  buttonId: string | null;
  mediaId: string | null;
}

/** Checks X-Hub-Signature-256 against the raw request body. */
export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=') || !appSecret) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pulls the messages out of a WhatsApp Cloud API webhook body. Status updates are ignored. */
export function parseInbound(body: unknown): Inbound[] {
  const out: Inbound[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contacts = (value.contacts as { wa_id: string; profile?: { name?: string } }[] | undefined) ?? [];
      for (const m of (value.messages as Record<string, any>[] | undefined) ?? []) {
        const from = String(m.from ?? '');
        if (!from) continue;
        const name = contacts.find((c) => c.wa_id === from)?.profile?.name ?? null;
        const base = { id: String(m.id), phone: '+' + from.replace(/^\+/, ''), name, buttonId: null as string | null, mediaId: null as string | null };
        if (m.type === 'text') out.push({ ...base, type: 'text', text: String(m.text?.body ?? '') });
        else if (m.type === 'interactive' && m.interactive?.button_reply) out.push({ ...base, type: 'button', text: String(m.interactive.button_reply.title ?? ''), buttonId: String(m.interactive.button_reply.id) });
        else if (m.type === 'interactive' && m.interactive?.list_reply) out.push({ ...base, type: 'button', text: String(m.interactive.list_reply.title ?? ''), buttonId: String(m.interactive.list_reply.id) });
        else if (m.type === 'request_welcome') out.push({ ...base, type: 'welcome', text: '' });
        else if (m.type === 'button') out.push({ ...base, type: 'button', text: String(m.button?.text ?? ''), buttonId: String(m.button?.payload ?? m.button?.text ?? '') });
        else if (m.type === 'audio') out.push({ ...base, type: 'audio', text: '', mediaId: String(m.audio?.id ?? '') });
        else if (m.type === 'image') out.push({ ...base, type: 'image', text: String(m.image?.caption ?? ''), mediaId: String(m.image?.id ?? '') });
        else out.push({ ...base, type: 'other', text: '' });
      }
    }
  }
  return out;
}

/** Nigerian numbers: 08012345678, 2348012345678, +234 801 234 5678 → +2348012345678 */
export function normalizePhone(input: string, defaultCountryCode = '234'): string | null {
  const d = input.replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(d)) return d;
  if (/^0\d{10}$/.test(d)) return '+' + defaultCountryCode + d.slice(1);
  if (/^\d{12,15}$/.test(d)) return '+' + d;
  return null;
}
