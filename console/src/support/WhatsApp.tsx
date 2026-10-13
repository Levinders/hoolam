import { ArrowLeft, CircleCheck, Clock, LifeBuoy, MessageSquare, RotateCcw, ScrollText, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { ACTIONS, ago, dateTime, initials, phone } from '../format';
import { SupportText } from '../pages/SupportMessage';
import { Button, Pager, Seg, useToast } from '../ui';
import { useSupport, useSupportEvents } from './hub';

/** WhatsApp support ("Talk to a rep"), inside the widget: the same inbox as before, plus the message log. */
export function WhatsAppSupport() {
  const s = useSupport();
  const [state, setState] = useState<'open' | 'closed' | 'log'>('open');
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(() => {
    if (state === 'log') return;
    api<{ rows: any[] }>(`/support?state=${state}`).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [state]);
  useEffect(() => { setRows(null); load(); }, [load]);
  useSupportEvents((e) => { if (e === 'whatsapp') load(); });
  const showList = s.expanded || s.waId == null;
  if (state === 'log') return <div className="wa-log"><div className="lc-filters"><Views state={state} setState={setState} /></div><MessageLog /></div>;
  return (
    <div className={`lc${s.expanded ? ' wide' : ''}`}>
      {showList && (
        <aside className="lc-list">
          <div className="lc-filters"><Views state={state} setState={setState} /></div>
          <div className="lc-rows">
            {rows === null ? <div className="lc-empty">Loading…</div> : !rows.length ? (
              <div className="lc-empty"><LifeBuoy /><b>{state === 'open' ? 'Inbox zero' : 'Nothing closed yet'}</b><span>{state === 'open' ? 'When someone taps “Talk to a rep” on WhatsApp, it lands here.' : ''}</span></div>
            ) : rows.map((r) => {
              const name = r.business_name || r.display_name || phone(r.phone);
              return (
                <button key={r.id} className={`lc-row${s.waId === r.id ? ' on' : ''}${r.unread ? ' unread' : ''}`} onClick={() => s.setWaId(r.id)}>
                  <span className="sw-av whatsapp" aria-hidden="true">{initials(name)}</span>
                  <span className="lc-row-main">
                    <span className="lc-row-top"><b>{name}</b><span className="lc-when">{ago(r.created_at)}</span></span>
                    <span className="lc-row-msg">{r.message}</span>
                    {r.last_reply_at && <span className="lc-row-meta"><span className="lc-tag mine">Replied {ago(r.last_reply_at)}</span></span>}
                  </span>
                  {r.unread && <span className="sw-dot" aria-label="Unread" />}
                </button>
              );
            })}
          </div>
        </aside>
      )}
      {s.waId != null ? <Thread key={s.waId} id={s.waId} onBack={() => s.setWaId(null)} onChanged={load} />
        : s.expanded && <div className="lc-pick"><MessageSquare /><b>Pick a conversation</b><span>Messages from “Talk to a rep” on WhatsApp. Your reply goes to them on WhatsApp, from Hoolam.</span></div>}
    </div>
  );
}

function Views({ state, setState }: { state: 'open' | 'closed' | 'log'; setState: (v: 'open' | 'closed' | 'log') => void }) {
  return (
    <div className="lc-views" role="tablist">
      {([['open', 'Open'], ['closed', 'Closed'], ['log', 'Message log']] as const).map(([k, l]) => (
        <button key={k} role="tab" aria-selected={state === k} className={state === k ? 'on' : ''} onClick={() => setState(k)}>{k === 'log' && <ScrollText />}{l}</button>
      ))}
    </div>
  );
}

function Thread({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const s = useSupport();
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api(`/support/${id}`).then((x) => { setData(x); setErr(null); }).catch((e) => setErr((e as Error).message)), [id]);
  useEffect(() => { load(); post(`/support/${id}/read`).then(() => { s.refreshCounts(); onChanged(); }).catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data]);
  useSupportEvents((e, d) => { if (e === 'whatsapp' && data && d.phone === data.request.phone) { load(); post(`/support/${id}/read`).then(() => s.refreshCounts()).catch(() => {}); } });
  if (err) return <div className="lc-thread"><div className="lc-empty">{err}</div></div>;
  if (!data) return <div className="lc-thread"><div className="lc-empty">Loading…</div></div>;
  const r = data.request;
  const name = r.business_name || r.display_name || phone(r.phone);
  const send = async (close: boolean) => {
    setBusy(true);
    try {
      await post(`/support/${id}/reply`, { text, close });
      setText(''); toast({ kind: 'ok', title: close ? 'Replied and closed' : 'Reply sent on WhatsApp' }); load(); onChanged();
    } catch (x) { toast({ kind: 'error', title: 'Not sent', body: (x as Error).message }); } finally { setBusy(false); }
  };
  const toggle = async () => {
    try {
      await post(`/support/${id}/close`, { reopen: r.status === 'CLOSED' });
      toast({ kind: 'ok', title: r.status === 'CLOSED' ? 'Reopened' : 'Closed' }); load(); onChanged();
    } catch (x) { toast({ kind: 'error', title: 'Not done', body: (x as Error).message }); }
  };
  return (
    <div className="lc-thread">
      <header className="lc-thead">
        {!s.expanded && <button className="sw-icon dark" onClick={onBack} aria-label="Back to conversations"><ArrowLeft /></button>}
        <span className="sw-av whatsapp big" aria-hidden="true">{initials(name)}</span>
        <div className="lc-who">
          <b>{name}</b>
          <span className="lc-sub">{phone(r.phone)}{r.user_id && <> · <Link to={`/people/${r.user_id}`}>Their record</Link></>}</span>
        </div>
        <div className="lc-actions">
          {can('support.close') && <button className="btn sm" onClick={toggle}>{r.status === 'CLOSED' ? <><RotateCcw />Reopen</> : <><CircleCheck />Close</>}</button>}
        </div>
      </header>
      <div className="lc-strip">
        <span className="lc-ref">S-{r.id}</span>
        {data.windowOpen ? <span className="lc-tag mine"><Clock />Can reply freely ({ago(data.lastInboundAt)})</span> : <span className="lc-tag waiting"><Clock />24 h window closed: sent as a Hoolam support update</span>}
        {r.status === 'CLOSED' && <span className="lc-tag closed">Closed</span>}
      </div>
      <div className="lc-body">
        <div className="lc-msgs">
          {data.thread.map((m: any) => (
            <div key={m.id} className={`lc-msg ${m.from === 'them' ? 'them' : 'us'}${m.from !== 'them' && !m.team ? ' auto' : ''}`}>
              <div className="lc-bubble"><span className="lc-text">{m.text}</span></div>
              <span className="lc-meta">{m.from === 'them' ? first(name) : m.team ? 'Team reply' : 'Hoolam (automatic)'} · {dateTime(m.at)}</span>
            </div>
          ))}
          {data.trail.length > 0 && <div className="lc-system"><span>{data.trail.map((t: any) => `${ACTIONS[t.action] ?? t.action} by ${t.actor}, ${ago(t.at)}`).join(' · ')}</span></div>}
          <div ref={end} />
        </div>
      </div>
      {can('support.reply') && (
        <form className="lc-compose wa" onSubmit={(e) => { e.preventDefault(); send(false); }}>
          <SupportText value={text} onChange={setText} label="Reply" rows={2} placeholder={`Reply to ${first(name)}. They see it on WhatsApp, from Hoolam support.`} />
          <div className="row" style={{ gap: 8 }}><span className="spacer" />
            <Button type="button" size="sm" busy={busy} disabled={text.trim().length < 2} onClick={() => send(true)}>Send and close</Button>
            <Button variant="primary" size="sm" icon={Send} busy={busy} disabled={text.trim().length < 2}>Send</Button>
          </div>
        </form>
      )}
    </div>
  );
}
const first = (n?: string | null) => String(n ?? '').trim().split(/\s+/)[0] ?? '';

function MessageLog() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any | null>(null);
  useEffect(() => { setData(null); api(`/messages?page=${page}${status ? `&status=${status}` : ''}`).then(setData).catch(() => setData({ rows: [], page: 1, pageSize: 50, total: 0 })); }, [page, status]);
  return (
    <div className="wa-log-body">
      <div style={{ padding: '8px 12px' }}><Seg value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: '', label: 'All' }, { value: 'SENT', label: 'Delivered' }, { value: 'FAILED', label: 'Failed' }, { value: 'NEEDS_TEMPLATE', label: '24 h rule' }, { value: 'DRY_RUN', label: 'Test' }]} /></div>
      {!data ? <div className="lc-empty">Loading…</div> : !data.rows.length ? <div className="lc-empty"><MessageSquare /><b>No messages</b></div> : (
        <>
          <div className="wa-log-rows">{data.rows.map((m: any) => (
            <div key={m.id} className="wa-log-row">
              <div className="row" style={{ gap: 8 }}><span className="num small">…{m.phone.slice(-4)}</span><span className={`pill plain ${m.status === 'SENT' ? 'green' : m.status === 'FAILED' ? 'red' : m.status === 'NEEDS_TEMPLATE' ? 'gold' : 'grey'}`}>{m.status === 'SENT' ? 'Delivered' : m.status === 'NEEDS_TEMPLATE' ? '24 h rule' : m.status === 'DRY_RUN' ? 'Test' : 'Failed'}</span><span className="spacer" /><span className="faint small" title={dateTime(m.created_at)}>{ago(m.created_at)}</span></div>
              <div className="small" style={{ color: 'var(--ink-2)', whiteSpace: 'pre-line' }}>{m.text}</div>
              {m.error && <div className="small" style={{ color: 'var(--red)' }}>{m.error}</div>}
            </div>
          ))}</div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
