import { CircleCheck, Clock, LifeBuoy, MessageSquare, RotateCcw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { ACTIONS, ago, dateTime } from '../format';
import { useData } from '../hooks';
import { Avatar, Button, Empty, ErrorBanner, Pager, Seg, SkeletonRows, useToast } from '../ui';

export function Support() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'messages' ? 'messages' : 'inbox';
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Support</h1><p className="lede">Messages from “Talk to a person”. Reply here and it goes to them on WhatsApp, from Hoolam.</p></div>
        <div className="actions"><Seg value={tab} onChange={(v) => setSp(v === 'inbox' ? {} : { tab: v })} options={[{ value: 'inbox', label: 'Conversations' }, { value: 'messages', label: 'Message log' }]} /></div>
      </div>
      {tab === 'inbox' ? <Inbox /> : <MessageLog />}
    </div>
  );
}

function Inbox() {
  const [sp, setSp] = useSearchParams();
  const [state, setState] = useState<'open' | 'closed'>('open');
  const list = useData<any>(`/support?state=${state}`);
  const openId = sp.get('open') ?? list.data?.rows?.[0]?.id?.toString() ?? null;
  return (
    <section className="panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', minHeight: 560, overflow: 'hidden' }}>
      <div style={{ borderRight: '1px solid var(--line-2)', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="toolbar"><Seg value={state} onChange={(v) => { setState(v); setSp({}); }} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} /></div>
        {list.error ? <div className="panel-body"><ErrorBanner error={list.error} /></div> : list.loading ? <SkeletonRows rows={5} /> : !list.data.rows.length
          ? <Empty icon={LifeBuoy} title={state === 'open' ? 'Inbox zero' : 'Nothing closed yet'}>{state === 'open' ? 'When someone taps “Talk to a person”, their message lands here.' : ''}</Empty>
          : (
            <div style={{ overflowY: 'auto' }}>
              {list.data.rows.map((r: any) => (
                <button key={r.id} onClick={() => setSp({ open: String(r.id) })} style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--line-2)', padding: '12px 14px', cursor: 'pointer', background: String(r.id) === openId ? 'var(--teal-50)' : 'transparent' }}>
                  <Avatar name={r.business_name || r.display_name || r.phone} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 6 }}><b style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.business_name || r.display_name || r.phone}</b><span className="spacer" /><span className="faint small nowrap">{ago(r.created_at)}</span></div>
                    <div className="cell-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.message}</div>
                    {r.last_reply_at && <div className="small" style={{ color: 'var(--teal)' }}>Replied {ago(r.last_reply_at)}</div>}
                  </div>
                </button>
              ))}
            </div>
          )}
      </div>
      <div style={{ minWidth: 0 }}>{openId ? <Thread id={openId} onChanged={list.reload} /> : <Empty icon={MessageSquare} title="Pick a conversation" />}</div>
    </section>
  );
}

function Thread({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useData<any>(`/support/${id}`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data]);
  if (error) return <div className="panel-body"><ErrorBanner error={error} /></div>;
  if (loading || !data) return <SkeletonRows rows={4} />;
  const r = data.request;
  const send = async (close: boolean) => {
    setBusy(true);
    try {
      await post(`/support/${id}/reply`, { text, close });
      setText(''); toast({ kind: 'ok', title: close ? 'Replied and closed' : 'Reply sent on WhatsApp' }); reload(); onChanged();
    } catch (x) { toast({ kind: 'error', title: 'Not sent', body: (x as Error).message }); } finally { setBusy(false); }
  };
  const toggle = async () => {
    await post(`/support/${id}/close`, { reopen: r.status === 'CLOSED' });
    toast({ kind: 'ok', title: r.status === 'CLOSED' ? 'Reopened' : 'Closed' }); reload(); onChanged();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-head">
        <div style={{ minWidth: 0 }}>
          <h2>{r.business_name || r.display_name || r.phone}</h2>
          <div className="small muted">{r.phone}{r.user_id && <> · <Link to={`/people/${r.user_id}`}>Their record</Link></>}</div>
        </div>
        <div className="right">
          {data.windowOpen ? <span className="pill green plain"><Clock style={{ width: 13 }} />Can reply ({ago(data.lastInboundAt)})</span> : <span className="pill gold plain"><Clock style={{ width: 13 }} />24 h window closed</span>}
          {can('support.close') && <Button size="sm" icon={r.status === 'CLOSED' ? RotateCcw : CircleCheck} onClick={toggle}>{r.status === 'CLOSED' ? 'Reopen' : 'Close'}</Button>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, background: '#FCFCFA', maxHeight: 520 }}>
        {data.thread.map((m: any) => (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.from === 'them' ? 'flex-end' : 'flex-start' }}>
            <div className={`bubble${m.from === 'them' ? ' them' : m.team ? ' team' : ''}`}>{m.text}</div>
            <span className="faint small" style={{ marginTop: 3 }}>{m.from === 'them' ? 'Them' : m.team ? 'Team reply' : 'Hoolam (automatic)'} · {dateTime(m.at)}</span>
          </div>
        ))}
        {data.trail.length > 0 && <div className="small muted" style={{ textAlign: 'center' }}>{data.trail.map((t: any) => `${ACTIONS[t.action] ?? t.action} by ${t.actor}, ${ago(t.at)}`).join(' · ')}</div>}
        <div ref={end} />
      </div>
      {can('support.reply') && (
        <form style={{ padding: 14, borderTop: '1px solid var(--line-2)', display: 'flex', flexDirection: 'column', gap: 8 }} onSubmit={(e) => { e.preventDefault(); send(false); }}>
          <textarea className="input" rows={3} placeholder={data.windowOpen ? 'Write a reply. It starts with “From the Hoolam team”.' : 'They haven\'t messaged in 24 hours, so WhatsApp won\'t deliver a reply. Ask them to message Hoolam first.'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply" />
          <div className="row"><span className="small muted">Sent on WhatsApp and saved to the audit trail.</span><span className="spacer" />
            <Button type="button" busy={busy} disabled={text.trim().length < 2} onClick={() => send(true)}>Send and close</Button>
            <Button variant="primary" icon={Send} busy={busy} disabled={text.trim().length < 2}>Send</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function MessageLog() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useData<any>(`/messages?page=${page}${status ? `&status=${status}` : ''}`);
  return (
    <section className="panel">
      <div className="toolbar"><Seg value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: '', label: 'All' }, { value: 'SENT', label: 'Delivered to WhatsApp' }, { value: 'FAILED', label: 'Failed' }, { value: 'NEEDS_TEMPLATE', label: 'Blocked by 24 h rule' }, { value: 'DRY_RUN', label: 'Test' }]} /></div>
      {error ? <div className="panel-body"><ErrorBanner error={error} /></div> : loading && !data ? <SkeletonRows rows={8} /> : !data.rows.length ? <Empty icon={MessageSquare} title="No messages" /> : (
        <>
          <div className="table-wrap"><table className="t"><thead><tr><th>To</th><th>Message</th><th>Kind</th><th>Status</th><th>When</th></tr></thead>
            <tbody>{data.rows.map((m: any) => (
              <tr key={m.id}><td className="num nowrap">…{m.phone.slice(-4)}</td><td style={{ maxWidth: 520 }}><div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.text}</div>{m.error && <div className="cell-sub" style={{ color: 'var(--red)' }}>{m.error}</div>}</td>
                <td className="muted">{m.kind}</td><td><span className={`pill plain ${m.status === 'SENT' ? 'green' : m.status === 'FAILED' ? 'red' : m.status === 'NEEDS_TEMPLATE' ? 'gold' : 'grey'}`}>{m.status === 'SENT' ? 'Delivered' : m.status === 'NEEDS_TEMPLATE' ? '24 h rule' : m.status === 'DRY_RUN' ? 'Test' : 'Failed'}</span></td>
                <td className="muted nowrap" title={dateTime(m.created_at)}>{ago(m.created_at)}</td></tr>
            ))}</tbody></table></div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </section>
  );
}
