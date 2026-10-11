import { Send } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { post } from '../api';
import { Button, useToast } from '../ui';

/** Same limit as the server: the message goes inside an approved WhatsApp template, as one paragraph. */
export const SUPPORT_MAX = 600;

/** What they type → what's sent: one paragraph (line breaks become spaces), at most 600 characters. */
export const oneParagraph = (t: string) => t.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, SUPPORT_MAX);

/** The text box with the live counter. Used by the support inbox, a person's page and an order. */
export function SupportText({ value, onChange, placeholder, rows = 3, label = 'Message' }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; label?: string }) {
  const left = SUPPORT_MAX - value.length;
  return (
    <div className="support-text">
      <textarea className="input" rows={rows} maxLength={SUPPORT_MAX} placeholder={placeholder} value={value} aria-label={label} aria-describedby="support-count"
        onChange={(e) => onChange(oneParagraph(e.target.value))} />
      <div id="support-count" className={`small ${left <= 40 ? 'err-text' : 'muted'}`} aria-live="polite">{value.length} / {SUPPORT_MAX}{left <= 40 ? ` · ${left} left` : ''} · one paragraph</div>
    </div>
  );
}

/**
 * "Message them": sent on WhatsApp as "🙋 Hoolam support: an update about your order HL-X", at any time,
 * even if they haven't messaged Hoolam in 24 hours. Their reply comes to the support inbox.
 */
export function SupportMessage({ endpoint, body = {}, title, note, onSent }: { endpoint: string; body?: Record<string, unknown>; title: ReactNode; note?: ReactNode; onSent?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const send = async () => {
    setBusy(true);
    try {
      const r = await post<{ via: 'template' | 'chat'; code: string | null }>(endpoint, { ...body, text });
      setText('');
      toast({ kind: 'ok', title: 'Sent on WhatsApp', body: r.code ? `As an update about order ${r.code}.` : 'As a chat message.' });
      onSent?.();
    } catch (x) { toast({ kind: 'error', title: 'Not sent', body: (x as Error).message }); } finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2></div>
      <form className="panel-body stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 2) send(); }}>
        <SupportText value={text} onChange={setText} placeholder="Type your message. They see it as a message from Hoolam support." />
        <div className="row"><span className="small muted">{note ?? 'Sent as “Hoolam support: an update about your order…”. Works any time. Their reply comes to Support.'}</span><span className="spacer" />
          <Button variant="primary" icon={Send} busy={busy} disabled={text.trim().length < 2}>Send</Button>
        </div>
      </form>
    </section>
  );
}
