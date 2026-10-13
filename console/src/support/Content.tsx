import { ArrowDown, ArrowUp, Eye, EyeOff, HelpCircle, House, Megaphone, MessageSquareQuote, Pencil, Plus, Reply, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { ago } from '../format';
import { Button, ConfirmAction, Switch, useToast } from '../ui';

type Kind = 'HOME' | 'QUESTION' | 'NEWS' | 'CHIP' | 'SAVED' | 'WELCOME';
interface Item { id: number; kind: Kind; title: string; body: string; url: string | null; shortcut: string | null; published: boolean; position: number; updatedAt: string; updatedBy: string | null; preview: string }

/** What visitors see in the chat (four kinds), and what only reps use (saved replies), kept apart. */
const GROUPS: { title: string; note: string; kinds: { kind: Kind; label: string; icon: typeof House; help: string }[] }[] = [
  {
    title: 'What visitors see', note: 'Shown in the chat on hoolam.com.',
    kinds: [
      { kind: 'WELCOME', label: 'Welcome', icon: Sparkles, help: 'The first line of every new chat.' },
      { kind: 'HOME', label: 'Home cards', icon: House, help: 'Cards on the chat’s Home tab. A link can be a page on hoolam.com (/legal/money/) or https://…' },
      { kind: 'QUESTION', label: 'Questions', icon: HelpCircle, help: 'The Questions tab. Visitors tap a question to read the answer.' },
      { kind: 'NEWS', label: 'News', icon: Megaphone, help: 'Short updates on the News tab, newest at the top.' },
      { kind: 'CHIP', label: 'Quick replies', icon: MessageSquareQuote, help: 'Tap-to-send messages above the visitor’s message box.' },
    ],
  },
  {
    title: 'Only for reps', note: 'Never shown to visitors.',
    kinds: [{ kind: 'SAVED', label: 'Saved replies', icon: Reply, help: 'Type / and the shortcut in a chat reply (like /fees) to drop the answer in, ready to edit.' }],
  },
];
const ALL = GROUPS.flatMap((g) => g.kinds);
const PLACEHOLDERS = '{fee_rate}, {fee_min}, {fee_max}, {txn_min}, {max_deal}, {max_deal_verified}, {whatsapp}';

export function ContentManager() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('livechat.content');
  const [kind, setKind] = useState<Kind>('QUESTION');
  const [rows, setRows] = useState<Item[] | null>(null);
  const [edit, setEdit] = useState<Partial<Item> | null>(null);
  const [del, setDel] = useState<Item | null>(null);
  const load = useCallback(() => api<{ rows: Item[] }>('/livechat-content').then((r) => setRows(r.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  const def = ALL.find((k) => k.kind === kind)!;
  const list = (rows ?? []).filter((r) => r.kind === kind);
  const count = (k: Kind) => (rows ?? []).filter((r) => r.kind === k).length;

  const save = async (it: Partial<Item>) => {
    try {
      await post('/livechat-content', { id: it.id, kind, title: it.title, body: it.body, url: it.url || null, shortcut: it.shortcut || null, published: it.published ?? true });
      toast({ kind: 'ok', title: it.id ? 'Saved' : 'Added', body: kind === 'SAVED' ? 'Reps can use it straight away.' : it.published === false ? 'Saved as hidden.' : 'Live in the chat now.' });
      setEdit(null); load();
    } catch (x) { toast({ kind: 'error', title: 'Not saved', body: (x as Error).message }); }
  };
  const publish = async (it: Item, v: boolean) => {
    try { await post('/livechat-content', { ...it, published: v }); toast({ kind: 'ok', title: v ? 'Showing in the chat' : 'Hidden from the chat' }); load(); }
    catch (x) { toast({ kind: 'error', title: 'Not changed', body: (x as Error).message }); }
  };
  const move = async (i: number, d: -1 | 1) => {
    const ids = list.map((x) => x.id);
    const j = i + d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setRows((r) => r && [...r.filter((x) => x.kind !== kind), ...ids.map((id, n) => ({ ...list.find((x) => x.id === id)!, position: n + 1 }))]);
    await post('/livechat-content/reorder', { kind, ids }).catch(() => load());
  };

  return (
    <div className="cm">
      <nav className="cm-nav" aria-label="Chat content">
        {GROUPS.map((g) => (
          <div key={g.title} className="cm-group">
            <div className="cm-group-h">{g.title}<span>{g.note}</span></div>
            {g.kinds.map((k) => (
              <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => { setKind(k.kind); setEdit(null); }}>
                <k.icon />{k.label}{k.kind !== 'WELCOME' && <span className="cm-n">{count(k.kind)}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="cm-main">
        <div className="cm-head">
          <div><h3><def.icon />{def.label}</h3><p>{def.help}</p></div>
          {editable && kind !== 'WELCOME' && !edit && <Button size="sm" variant="primary" icon={Plus} onClick={() => setEdit({ published: true })}>Add</Button>}
        </div>
        {edit && <Editor kind={kind} item={edit} onCancel={() => setEdit(null)} onSave={save} />}
        {rows === null ? <div className="lc-empty">Loading…</div> : !list.length && !edit ? (
          <div className="lc-empty"><def.icon /><b>Nothing here yet</b>{editable && kind !== 'WELCOME' && <Button size="sm" icon={Plus} onClick={() => setEdit({ published: true })}>Add the first one</Button>}</div>
        ) : (
          <ol className="cm-list">
            {list.map((it, i) => (
              <li key={it.id} className={`cm-item${it.published ? '' : ' hidden'}${edit?.id === it.id ? ' editing' : ''}`}>
                <div className="cm-item-main">
                  {kind === 'SAVED' && <span className="cm-short">/{it.shortcut}</span>}
                  {it.title && <b>{it.title}</b>}
                  <p>{it.preview}</p>
                  {it.url && <span className="cm-url">{it.url}</span>}
                  <span className="cm-by">{!it.published && <><EyeOff /> Hidden · </>}Updated {ago(it.updatedAt)}{it.updatedBy ? ` by ${it.updatedBy.split(' ')[0]}` : ''}</span>
                </div>
                {editable && (
                  <div className="cm-item-actions">
                    {kind !== 'WELCOME' && kind !== 'SAVED' && <label className="cm-pub" title={it.published ? 'Showing in the chat' : 'Hidden'}><Switch on={it.published} label={`Show “${it.title || it.body}” in the chat`} onChange={(v) => publish(it, v)} />{it.published ? <Eye /> : <EyeOff />}</label>}
                    {kind !== 'WELCOME' && <>
                      <button className="sw-icon dark" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></button>
                      <button className="sw-icon dark" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown /></button>
                    </>}
                    <button className="sw-icon dark" aria-label="Edit" onClick={() => setEdit(it)}><Pencil /></button>
                    {kind !== 'WELCOME' && <button className="sw-icon dark danger" aria-label="Delete" onClick={() => setDel(it)}><Trash2 /></button>}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {del && <ConfirmAction icon={Trash2} tone="danger" title="Delete this?" confirmLabel="Delete" description={`“${del.title || del.body.slice(0, 60)}” is removed from ${kind === 'SAVED' ? 'the saved replies' : 'the chat'}. You can add it again later.`}
        needReason={false} onClose={() => setDel(null)} onConfirm={async () => { await api(`/livechat-content/${del.id}`, { method: 'DELETE' }); toast({ kind: 'ok', title: 'Deleted' }); setDel(null); load(); }} />}
    </div>
  );
}

function Editor({ kind, item, onCancel, onSave }: { kind: Kind; item: Partial<Item>; onCancel: () => void; onSave: (it: Partial<Item>) => Promise<void> }) {
  const [f, setF] = useState<Partial<Item>>(item);
  const [busy, setBusy] = useState(false);
  const titleLabel = kind === 'QUESTION' ? 'Question' : kind === 'SAVED' ? 'Name' : 'Title';
  const bodyLabel = kind === 'QUESTION' ? 'Answer' : kind === 'CHIP' ? 'Message' : kind === 'WELCOME' ? 'Welcome line' : kind === 'SAVED' ? 'Reply' : 'Text';
  return (
    <form className="cm-editor" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(f); } finally { setBusy(false); } }}>
      {kind === 'SAVED' && <div className="field"><label htmlFor="cm-short">Shortcut</label><div className="cm-shortin"><span>/</span><input id="cm-short" className="input" placeholder="fees" value={f.shortcut ?? ''} onChange={(e) => setF({ ...f, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></div></div>}
      {['HOME', 'QUESTION', 'NEWS', 'SAVED'].includes(kind) && <div className="field"><label htmlFor="cm-title">{titleLabel}</label><input id="cm-title" className="input" value={f.title ?? ''} maxLength={140} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></div>}
      <div className="field"><label htmlFor="cm-body">{bodyLabel}</label><textarea id="cm-body" className="input" rows={kind === 'CHIP' || kind === 'WELCOME' ? 2 : 5} maxLength={4000} value={f.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} autoFocus={kind === 'CHIP' || kind === 'WELCOME'} /></div>
      {(kind === 'QUESTION' || kind === 'SAVED') && <p className="small muted">Live values: {PLACEHOLDERS}. They always show the console’s current numbers.</p>}
      {(kind === 'HOME' || kind === 'NEWS') && <div className="field"><label htmlFor="cm-url">Link <span className="faint">(optional)</span></label><input id="cm-url" className="input" placeholder="/#pricing or https://…" value={f.url ?? ''} onChange={(e) => setF({ ...f, url: e.target.value })} /></div>}
      <div className="row" style={{ gap: 8 }}>
        {kind !== 'WELCOME' && kind !== 'SAVED' && <label className="row small" style={{ gap: 8 }}><Switch on={f.published ?? true} label="Show in the chat" onChange={(v) => setF({ ...f, published: v })} />Show in the chat</label>}
        <span className="spacer" />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" busy={busy}>{item.id ? 'Save' : 'Add'}</Button>
      </div>
    </form>
  );
}
