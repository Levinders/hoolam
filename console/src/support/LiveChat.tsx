import { ArrowLeft, CircleCheck, Eye, FileText, Globe, MessageCircle, PanelRightClose, PanelRightOpen, Paperclip, RotateCcw, Search, Send, StickyNote, ThumbsDown, ThumbsUp, UserRound, UserRoundCheck, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as KE } from 'react';
import { Link } from 'react-router-dom';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { ago, initials } from '../format';
import { useDebounced } from '../hooks';
import { useToast } from '../ui';
import { useSupport, useSupportEvents } from './hub';

type View = 'open' | 'mine' | 'unassigned' | 'closed';
const VIEWS: { key: View; label: string }[] = [{ key: 'open', label: 'Open' }, { key: 'mine', label: 'Mine' }, { key: 'unassigned', label: 'Waiting' }, { key: 'closed', label: 'Closed' }];
const first = (n?: string | null) => String(n ?? '').trim().split(/\s+/)[0] ?? '';
const time = (at: string) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const day = (at: string) => {
  const d = new Date(at), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The live chat inbox: the list on the left (or first, in the side panel), the conversation on the right. */
export function LiveChat() {
  const s = useSupport();
  const meId = useAuth().me?.id ?? '';
  const [view, setView] = useState<View>('open');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(() => {
    api<{ rows: any[] }>(`/livechat?view=${view}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [view, dq]);
  useEffect(() => { setRows(null); load(); }, [load]);
  useSupportEvents((e, d) => { if (e === 'chat' && (d.type === 'message' || d.type === 'thread' || d.type === 'viewers' || d.type === 'seen')) load(); });
  const showList = s.expanded || s.liveId == null;
  return (
    <div className={`lc${s.expanded ? ' wide' : ''}`}>
      {showList && (
        <aside className="lc-list">
          <div className="lc-filters">
            <div className="lc-search"><Search /><input placeholder="Search name, number or message" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" /></div>
            <div className="lc-views" role="tablist">
              {VIEWS.map((v) => <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? 'on' : ''} onClick={() => setView(v.key)}>{v.label}</button>)}
            </div>
          </div>
          <div className="lc-rows">
            {rows === null ? <div className="lc-empty">Loading…</div> : !rows.length ? (
              <div className="lc-empty"><MessageCircle /><b>{view === 'closed' ? 'No closed chats' : dq ? 'Nothing found' : 'No chats waiting'}</b><span>{view === 'closed' || dq ? '' : 'When someone starts a chat on hoolam.com, it shows up here straight away.'}</span></div>
            ) : rows.map((r) => (
              <button key={r.id} className={`lc-row${s.liveId === r.id ? ' on' : ''}${r.unread ? ' unread' : ''}`} onClick={() => s.setLiveId(r.id)}>
                <span className="sw-av live" aria-hidden="true">{initials(r.name)}</span>
                <span className="lc-row-main">
                  <span className="lc-row-top"><b>{r.name}</b><span className="lc-when">{r.last ? ago(r.last.at) : ''}</span></span>
                  <span className="lc-row-msg">{r.last?.kind === 'STAFF' ? <em>{first(r.last.by)}: </em> : null}{r.last?.text}</span>
                  <span className="lc-row-meta">
                    {r.assignedName ? <span className={`lc-tag${r.assignedTo === meId ? ' mine' : ''}`}><UserRoundCheck />{r.assignedTo === meId ? 'You' : first(r.assignedName)}</span> : r.status === 'OPEN' ? <span className="lc-tag waiting">Waiting for a rep</span> : null}
                    {r.viewers?.some((v: any) => v.id !== meId) && <span className="lc-tag view"><Eye />{r.viewers.filter((v: any) => v.id !== meId).map((v: any) => first(v.name)).join(', ')}</span>}
                    {r.rating && (r.rating === 'UP' ? <ThumbsUp className="lc-rate up" /> : <ThumbsDown className="lc-rate down" />)}
                  </span>
                </span>
                {r.unread > 0 && <span className="sw-n">{r.unread}</span>}
              </button>
            ))}
          </div>
        </aside>
      )}
      {s.liveId != null ? <Thread key={s.liveId} id={s.liveId} onBack={() => s.setLiveId(null)} onChanged={load} />
        : s.expanded && <div className="lc-pick"><MessageCircle /><b>Pick a chat</b><span>Chats from hoolam.com, newest first. Waiting chats need a rep.</span></div>}
    </div>
  );
}

function Thread({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const s = useSupport();
  const { me } = useAuth();
  const toast = useToast();
  const [t, setT] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typing, setTyping] = useState<number>(0);
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<any[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  const load = useCallback(() => api(`/livechat/${id}`).then((x) => { setT(x); setErr(null); }).catch((e) => setErr((e as Error).message)), [id]);
  useEffect(() => { load(); api<{ rows: any[] }>('/livechat-content').then((r) => setSaved(r.rows.filter((x) => x.kind === 'SAVED'))).catch(() => {}); }, [load]);

  // "I'm looking at this chat" (others see it), and read everything shown
  useEffect(() => {
    const on = () => post(`/livechat/${id}/view`, { on: true }).catch(() => {});
    on();
    const tick = setInterval(on, 20_000);
    return () => { clearInterval(tick); post(`/livechat/${id}/view`, { on: false }).catch(() => {}); };
  }, [id]);
  const lastId = t?.messages?.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!lastId || document.hidden) return;
    post(`/livechat/${id}/read`, { upTo: lastId }).then(() => s.refreshCounts()).catch(() => {});
  }, [id, lastId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lastId, typing]);

  useSupportEvents((e, d) => {
    if (e !== 'chat' || d.threadId !== id) return;
    if (d.type === 'message') {
      setT((x: any) => (x && !x.messages.some((m: any) => m.id === d.message.id) ? { ...x, messages: [...x.messages, d.message] } : x));
      if (d.message.kind === 'VISITOR') setTyping(0);
      if (d.message.kind === 'SYSTEM') load();
    } else if (d.type === 'typing' && d.who === 'visitor') {
      setTyping(Date.now());
    } else if (d.type === 'seen' && d.by === 'visitor') {
      setT((x: any) => (x ? { ...x, visitorReadUpTo: d.upTo } : x));
    } else if (d.type === 'viewers') {
      setT((x: any) => (x ? { ...x, viewers: d.viewers } : x));
    } else if (d.type === 'thread') load();
  });
  useEffect(() => { if (!typing) return; const k = setTimeout(() => setTyping(0), 5000); return () => clearTimeout(k); }, [typing]);

  const act = async (path: string, done: string) => {
    try { await post(`/livechat/${id}/${path}`); toast({ kind: 'ok', title: done }); load(); onChanged(); } catch (x) { toast({ kind: 'error', title: 'Not done', body: (x as Error).message }); }
  };
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await post(`/livechat/${id}/${mode === 'note' ? 'note' : 'reply'}`, { text: body });
      setText(''); if (mode === 'note') setMode('reply'); load(); onChanged();
    } catch (x) { toast({ kind: 'error', title: 'Not sent', body: (x as Error).message }); } finally { setBusy(false); box.current?.focus(); }
  };
  const upload = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) return toast({ kind: 'error', title: 'Too big', body: 'Files can be up to 10 MB.' });
    setBusy(true);
    try {
      const res = await fetch(`/console/api/livechat/${id}/files`, { method: 'POST', credentials: 'same-origin', headers: { 'x-hoolam-console': '1', 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) }, body: f });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed');
      load(); onChanged();
    } catch (x) { toast({ kind: 'error', title: 'Not sent', body: (x as Error).message }); } finally { setBusy(false); }
  };
  const onType = (v: string) => {
    setText(v);
    if (mode === 'reply' && Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); post(`/livechat/${id}/typing`).catch(() => {}); }
  };

  // saved replies: type "/" and a word
  const slash = /^\/([a-z0-9-]*)$/i.exec(text.trim());
  const matches = useMemo(() => (slash ? saved.filter((x) => x.shortcut.startsWith(slash[1]!.toLowerCase()) || x.title.toLowerCase().includes(slash[1]!.toLowerCase())).slice(0, 6) : []), [slash?.[1], saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [slash?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const usePick = (x: any) => { setText(x.preview); box.current?.focus(); };
  const onKey = (e: KE<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => (p + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => (p - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); usePick(matches[pick]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  if (err) return <div className="lc-thread"><div className="lc-empty">{err}</div></div>;
  if (!t) return <div className="lc-thread"><div className="lc-empty">Loading…</div></div>;
  const othersHandling = t.assignedTo && !t.mine;
  const others = (t.viewers ?? []).filter((v: any) => v.id !== me?.id);
  const lastStaff = [...t.messages].reverse().find((m: any) => m.kind === 'STAFF');
  // the visitor's rating shows in the chat where it happened
  const rated = t.rating && t.ratedAt ? (
    <div className={`lc-system rated ${t.rating === 'UP' ? 'good' : 'bad'}`}><span>{t.rating === 'UP' ? <ThumbsUp /> : <ThumbsDown />}{first(t.visitor.name)} rated {t.ratedStaff ? first(t.ratedStaff) : 'the chat'}: {t.rating === 'UP' ? 'helpful' : 'not helpful'} · {time(t.ratedAt)}</span></div>
  ) : null;
  const ratedAt = rated ? (() => { const i = t.messages.findIndex((m: any) => new Date(m.at) > new Date(t.ratedAt)); return i < 0 ? t.messages.length : i; })() : -1;
  return (
    <div className="lc-thread">
      <header className="lc-thead">
        {!s.expanded && <button className="sw-icon dark" onClick={onBack} aria-label="Back to chats"><ArrowLeft /></button>}
        <span className="sw-av live big" aria-hidden="true">{initials(t.visitor.name)}</span>
        <div className="lc-who">
          <b>{t.visitor.name}</b>
          <span className="lc-sub">
            <a href={`https://wa.me/234${String(t.visitor.phone).slice(1)}`} target="_blank" rel="noopener">{t.visitor.phone}</a>
            <span className="lc-ref">{t.ref}</span>
            {t.assignedName ? <span className={`lc-handler${t.mine ? ' mine' : ''}`} title={t.mine ? 'You are handling this chat' : `${t.assignedName} is handling this chat`}><UserRoundCheck />{t.mine ? 'You' : first(t.assignedName)}</span>
              : <span className="lc-handler waiting">Waiting for a rep</span>}
          </span>
        </div>
        <div className="lc-actions">
          {othersHandling && <button className="btn sm" onClick={() => { if (confirm(`Take this chat over from ${first(t.assignedName)}? ${t.visitor.name.split(' ')[0]} will see that you joined.`)) act('assign', 'You have this chat now'); }}><UserRoundCheck />Take over</button>}
          {!t.assignedTo && t.status === 'OPEN' && <button className="btn sm" onClick={() => act('assign', 'You have this chat now')}><UserRoundCheck />Take it</button>}
          {t.status === 'OPEN' ? <button className="btn sm" onClick={() => act('close', 'Chat closed')}><CircleCheck />Close</button>
            : <button className="btn sm" onClick={() => act('reopen', 'Chat reopened')}><RotateCcw />Reopen</button>}
        </div>
      </header>

      <div className="lc-body">
        <div className="lc-msgs">
          {t.messages.map((m: any, i: number) => {
            const prev = t.messages[i - 1];
            const newDay = !prev || day(prev.at) !== day(m.at);
            return (
              <Fragment key={m.id}>
                {i === ratedAt && rated}
                {newDay && <div className="lc-day"><span>{day(m.at)}</span></div>}
                <Message m={m} t={t} seen={m.id === lastStaff?.id && t.visitorReadUpTo >= m.id} />
              </Fragment>
            );
          })}
          {rated && ratedAt === t.messages.length && rated}
          {typing > 0 && <div className="lc-msg them"><div className="lc-typing" aria-label={`${first(t.visitor.name)} is typing`}><i /><i /><i /></div></div>}
          {others.length > 0 && <div className="lc-here"><Eye />{others.map((v: any) => first(v.name)).join(', ')} {others.length === 1 ? 'is' : 'are'} looking at this chat too</div>}
          <div ref={end} />
        </div>
        {s.expanded && <InfoRail t={t} />}
      </div>

      {othersHandling ? (
        <div className="lc-locked"><UserRoundCheck /><span><b>{first(t.assignedName)}</b> is handling this chat. You can read along, add an internal note, or take it over.</span>
          <button className="btn sm" onClick={() => setMode('note')}><StickyNote />Add a note</button></div>
      ) : null}
      {(!othersHandling || mode === 'note') && (
        <div className={`lc-compose${mode === 'note' ? ' note' : ''}`}>
          <div className="lc-modes" role="tablist">
            {!othersHandling && <button role="tab" aria-selected={mode === 'reply'} className={mode === 'reply' ? 'on' : ''} onClick={() => setMode('reply')}><Send />Reply</button>}
            <button role="tab" aria-selected={mode === 'note'} className={mode === 'note' ? 'on' : ''} onClick={() => setMode('note')}><StickyNote />Internal note</button>
            <span className="lc-hint">{mode === 'note' ? 'Only the team sees notes.' : t.status === 'CLOSED' ? 'Replying reopens the chat.' : 'Type / for saved replies'}</span>
          </div>
          {matches.length > 0 && (
            <div className="lc-saved" role="listbox" aria-label="Saved replies">
              {matches.map((x, i) => (
                <button key={x.id} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseEnter={() => setPick(i)} onClick={() => usePick(x)}>
                  <b>/{x.shortcut}</b><span>{x.title}</span><em>{x.preview}</em>
                </button>
              ))}
            </div>
          )}
          <div className="lc-inputrow">
            {mode === 'reply' && <>
              <button className="sw-icon dark" aria-label="Attach a photo or PDF" title="Attach a photo or PDF (up to 10 MB)" onClick={() => fileIn.current?.click()} disabled={busy}><Paperclip /></button>
              <input ref={fileIn} type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
            </>}
            <textarea ref={box} rows={1} value={text} placeholder={mode === 'note' ? 'Write a note for the team…' : `Reply to ${first(t.visitor.name)}…`}
              onChange={(e) => onType(e.target.value)} onKeyDown={onKey} aria-label={mode === 'note' ? 'Internal note' : 'Reply'} />
            <button className="lc-send" onClick={send} disabled={busy || !text.trim()} aria-label={mode === 'note' ? 'Save note' : 'Send'}>{mode === 'note' ? <StickyNote /> : <Send />}</button>
          </div>
          {mode === 'note' && othersHandling && <button className="lc-cancel" onClick={() => { setMode('reply'); setText(''); }}><X />Cancel</button>}
        </div>
      )}
    </div>
  );
}

/** Plain page names for where a chat started. */
export function pageName(path?: string | null): string {
  const p = String(path || '/').replace(/[?#].*$/, '');
  if (p === '/' || /^\/v\/[^/]+\/?$/.test(p)) return 'Home page';
  if (p.startsWith('/about')) return 'About';
  if (p.startsWith('/contact')) return 'Contact us';
  if (p === '/legal/' || p === '/legal') return 'Legal pages';
  const legal = /^\/legal\/([a-z-]+)/.exec(p);
  if (legal) return ({ terms: 'Terms of service', privacy: 'Privacy policy', 'holding-agreement': 'Holding agreement', disputes: 'If something goes wrong', 'acceptable-use': 'Acceptable use', money: 'Where the money sits', cookies: 'Cookies', 'delete-your-data': 'Delete your data' } as Record<string, string>)[legal[1]!] ?? 'Legal pages';
  return 'Website';
}

/** Full screen: the visitor's details and every internal note, folding down to icons. */
function InfoRail({ t }: { t: any }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('hoolam:support:rail') !== '0'; } catch { return true; } });
  const [pane, setPane] = useState<'about' | 'notes'>('about');
  const notes = t.messages.filter((m: any) => m.kind === 'NOTE');
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem('hoolam:support:rail', v ? '1' : '0'); } catch { /* ignore */ } };
  const jump = (id: number) => {
    const el = document.getElementById(`lcm-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  };
  const show = (p: 'about' | 'notes') => { setPane(p); set(true); };
  return (
    <aside className={`lc-info${open ? '' : ' folded'}`}>
      <div className="lc-rail">
        <button className={`sw-icon dark${open && pane === 'about' ? ' on' : ''}`} title={`About ${first(t.visitor.name)}`} aria-label={`About ${first(t.visitor.name)}`} onClick={() => (open && pane === 'about' ? set(false) : show('about'))}><UserRound /></button>
        <button className={`sw-icon dark${open && pane === 'notes' ? ' on' : ''}`} title="Internal notes" aria-label={`Internal notes (${notes.length})`} onClick={() => (open && pane === 'notes' ? set(false) : show('notes'))}><StickyNote />{notes.length > 0 && <span className="lc-rail-n">{notes.length}</span>}</button>
        <span className="spacer" />
        <button className="sw-icon dark" title={open ? 'Fold' : 'Open'} aria-label={open ? 'Fold the side panel' : 'Open the side panel'} onClick={() => set(!open)}>{open ? <PanelRightClose /> : <PanelRightOpen />}</button>
      </div>
      {open && (pane === 'about' ? (
        <div className="lc-pane">
          <h3>About {first(t.visitor.name)}</h3>
          <dl>
            <dt>WhatsApp</dt><dd>{t.visitor.phone}</dd>
            <dt>On Hoolam</dt><dd>{t.visitor.userId ? <Link to={`/people/${t.visitor.userId}`}>Their record · {t.visitor.orders} order{t.visitor.orders === 1 ? '' : 's'}</Link> : 'Not yet (no orders on this number)'}</dd>
            <dt>Started on</dt><dd className="row" style={{ gap: 6 }}><Globe style={{ width: 14 }} className="faint" />{pageName(t.sourcePage)}</dd>
            <dt>Started</dt><dd>{ago(t.createdAt)}</dd>
          </dl>
          {t.waNotifiedAt && <p className="small muted">We told them about a reply on WhatsApp {ago(t.waNotifiedAt)}.</p>}
        </div>
      ) : (
        <div className="lc-pane">
          <h3>Internal notes <span className="faint">{notes.length}</span></h3>
          {!notes.length ? <p className="small muted">No notes yet. Notes are only for the team.</p> : (
            <ol className="lc-notes">{[...notes].reverse().map((n: any) => (
              <li key={n.id}><button onClick={() => jump(n.id)}><span>{n.body}</span><small>{[first(n.by), ago(n.at)].filter(Boolean).join(' · ')}</small></button></li>
            ))}</ol>
          )}
        </div>
      ))}
    </aside>
  );
}

function Message({ m, t, seen }: { m: any; t: any; seen: boolean }) {
  if (m.kind === 'SYSTEM') {
    const who = first(m.by);
    const line = m.body === 'joined' ? `${who} joined the chat` : m.body === 'closed' ? `${who || 'A rep'} closed the chat` : m.body === 'ended' ? `${first(t.visitor.name)} ended the chat`
      : m.body === 'reopened' ? (who ? `${who} reopened the chat` : `${first(t.visitor.name)} came back, so the chat reopened`) : m.body === 'whatsapp' ? `They had left, so we told them on WhatsApp` : m.body;
    return <div className="lc-system"><span>{line} · {time(m.at)}</span></div>;
  }
  const mine = m.kind === 'STAFF' || m.kind === 'NOTE';
  return (
    <div id={`lcm-${m.id}`} className={`lc-msg ${mine ? 'us' : 'them'}${m.kind === 'NOTE' ? ' lc-note' : ''}`}>
      {m.kind === 'NOTE' && <span className="lc-notelabel"><StickyNote />Internal note · only the team sees this</span>}
      <div className="lc-bubble">
        {m.file && <FileView f={m.file} />}
        {m.body && <span className="lc-text">{m.body}</span>}
      </div>
      <span className="lc-meta">{mine ? `${first(m.by)} · ` : ''}{time(m.at)}{seen && <b className="lc-seen"> · Seen</b>}</span>
    </div>
  );
}

function FileView({ f }: { f: { id: number; name: string; mime: string; size: number } }) {
  const url = `/console/api/livechat/files/${f.id}`;
  if (f.mime.startsWith('image/')) return <a href={url} target="_blank" rel="noopener" className="lc-img"><img src={url} alt={f.name} loading="lazy" /></a>;
  return <a href={url} className="lc-file" download={f.name}><FileText /><span><b>{f.name}</b><small>PDF · {size(f.size)}</small></span></a>;
}
