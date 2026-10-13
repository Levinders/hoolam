import { ArrowDown, ArrowUp, ChevronDown, Eye, EyeOff, HelpCircle, House, ImagePlus, Megaphone, MessageSquareQuote, Pencil, Plus, Reply, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { ago } from '../format';
import { Button, ConfirmAction, Switch, useToast } from '../ui';
import { useSupport } from './hub';

type Kind = 'HOME' | 'QUESTION' | 'NEWS' | 'CHIP' | 'SAVED' | 'WELCOME';
interface Item { id: number; kind: Kind; title: string; body: string; url: string | null; shortcut: string | null; published: boolean; position: number; updatedAt: string; updatedBy: string | null; preview: string; imageId: number | null }

/** What visitors see in the chat, and (kept apart) what only reps use. */
const SECTIONS: { kind: Kind; label: string; icon: typeof House; help: string; reps?: boolean }[] = [
  { kind: 'WELCOME', label: 'Welcome', icon: Sparkles, help: 'The first line of every new chat.' },
  { kind: 'HOME', label: 'Home cards', icon: House, help: 'Cards on the chat’s Home tab. A link can be a page on hoolam.com (/legal/money/) or https://…' },
  { kind: 'QUESTION', label: 'Questions', icon: HelpCircle, help: 'The Questions tab, newest first. Visitors tap a question to open its answer.' },
  { kind: 'NEWS', label: 'News', icon: Megaphone, help: 'Short updates on the News tab, newest first. A picture is optional.' },
  { kind: 'CHIP', label: 'Quick replies', icon: MessageSquareQuote, help: 'Tap-to-send messages above the visitor’s message box.' },
  { kind: 'SAVED', label: 'Saved replies', icon: Reply, help: 'Only for reps. Type / and the shortcut in a reply (like /fees) to drop the answer in, ready to edit.', reps: true },
];
const FOLDS: Kind[] = ['QUESTION', 'CHIP', 'SAVED'];
const PLACEHOLDERS = '{fee_rate}, {fee_min}, {fee_max}, {txn_min}, {max_deal}, {max_deal_verified}, {whatsapp}';

export function ContentManager() {
  const { can } = useAuth();
  const s = useSupport();
  const toast = useToast();
  const editable = can('livechat.content');
  const [kind, setKind] = useState<Kind>('QUESTION');
  const [rows, setRows] = useState<Item[] | null>(null);
  const [edit, setEdit] = useState<Partial<Item> | null>(null);
  const [del, setDel] = useState<Item | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const load = useCallback(() => api<{ rows: Item[] }>('/livechat-content').then((r) => setRows(r.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  const def = SECTIONS.find((k) => k.kind === kind)!;
  const list = (rows ?? []).filter((r) => r.kind === kind);
  const count = (k: Kind) => (rows ?? []).filter((r) => r.kind === k).length;
  const pick = (k: Kind) => { setKind(k); setEdit(null); setOpenId(null); };

  const save = async (it: Partial<Item>, image: File | null | 'remove') => {
    try {
      const r = await post<{ id: number }>('/livechat-content', { id: it.id, kind, title: it.title, body: it.body, url: it.url || null, shortcut: it.shortcut || null, published: it.published ?? true });
      if (image === 'remove' && it.id) await api(`/livechat-content/${it.id}/image`, { method: 'DELETE' });
      else if (image instanceof File) {
        const res = await fetch(`/console/api/livechat-content/${r.id}/image`, { method: 'POST', credentials: 'same-origin', headers: { 'x-hoolam-console': '1', 'content-type': 'application/octet-stream' }, body: image });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'The picture didn’t upload.');
      }
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
  const folds = FOLDS.includes(kind);

  return (
    <div className={`cm${s.expanded ? '' : ' narrow'}`}>
      {s.expanded ? (
        <nav className="cm-nav" aria-label="Chat config">
          {SECTIONS.map((k) => (
            <div key={k.kind} className="cm-navitem">
              {k.reps && <div className="cm-group-h">Only for reps</div>}
              <button className={kind === k.kind ? 'on' : ''} onClick={() => pick(k.kind)}>
                <k.icon />{k.label}{k.kind !== 'WELCOME' && <span className="cm-n">{count(k.kind)}</span>}
              </button>
            </div>
          ))}
        </nav>
      ) : <Picker kind={kind} count={count} onPick={pick} />}
      <section className="cm-main">
        <div className="cm-head">
          <div>{s.expanded && <h3><def.icon />{def.label}</h3>}<p>{def.help}</p></div>
          {editable && kind !== 'WELCOME' && !edit && <Button size="sm" variant="primary" icon={Plus} onClick={() => setEdit({ published: true })}>Add</Button>}
        </div>
        {edit && !edit.id && <Editor kind={kind} item={edit} onCancel={() => setEdit(null)} onSave={save} />}
        {rows === null ? <div className="lc-empty">Loading…</div> : !list.length && !edit ? (
          <div className="lc-empty"><def.icon /><b>Nothing here yet</b>{editable && kind !== 'WELCOME' && <Button size="sm" icon={Plus} onClick={() => setEdit({ published: true })}>Add the first one</Button>}</div>
        ) : (
          <ol className="cm-list">
            {list.map((it, i) => {
              if (edit?.id === it.id) return <li key={it.id}><Editor kind={kind} item={edit} onCancel={() => setEdit(null)} onSave={save} /></li>;
              const open = !folds || openId === it.id;
              const heading = kind === 'CHIP' ? it.body : it.title;
              return (
                <li key={it.id} className={`cm-item${it.published ? '' : ' hidden'}${folds ? ' fold' : ''}${open && folds ? ' open' : ''}`}>
                  <div className="cm-item-top">
                    {folds ? (
                      <button className="cm-toggle" aria-expanded={open} onClick={() => setOpenId(open ? null : it.id)}>
                        <ChevronDown />{kind === 'SAVED' && <span className="cm-short">/{it.shortcut}</span>}<b>{heading}</b>{!it.published && <EyeOff className="cm-off" />}
                      </button>
                    ) : (
                      <div className="cm-item-main">
                        {it.imageId && <img className="cm-thumb" src={`/console/api/livechat-media/${it.imageId}`} alt="" />}
                        <div>{it.title && <b>{it.title}</b>}<p>{it.preview}</p>{it.url && <span className="cm-url">{it.url}</span>}</div>
                      </div>
                    )}
                    {editable && (
                      <div className="cm-item-actions">
                        {kind !== 'WELCOME' && kind !== 'SAVED' && <span className="cm-pub" title={it.published ? 'Showing in the chat' : 'Hidden'}><Switch on={it.published} label={`Show “${heading}” in the chat`} onChange={(v) => publish(it, v)} /></span>}
                        {kind !== 'WELCOME' && <>
                          <button className="sw-icon dark" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></button>
                          <button className="sw-icon dark" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown /></button>
                        </>}
                        <button className="sw-icon dark" aria-label="Edit" onClick={() => { setEdit(it); setOpenId(null); }}><Pencil /></button>
                        {kind !== 'WELCOME' && <button className="sw-icon dark danger" aria-label="Delete" onClick={() => setDel(it)}><Trash2 /></button>}
                      </div>
                    )}
                  </div>
                  {folds && open && kind !== 'CHIP' && <p className="cm-body">{it.preview}</p>}
                  {(open || !folds) && <span className="cm-by">{!it.published && <><EyeOff /> Hidden · </>}Updated {ago(it.updatedAt)}{it.updatedBy ? ` by ${it.updatedBy.split(' ')[0]}` : ''}</span>}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {del && <ConfirmAction icon={Trash2} tone="danger" title="Delete this?" confirmLabel="Delete" description={`“${del.title || del.body.slice(0, 60)}” is removed from ${kind === 'SAVED' ? 'the saved replies' : 'the chat'}. You can add it again later.`}
        needReason={false} onClose={() => setDel(null)} onConfirm={async () => { await api(`/livechat-content/${del.id}`, { method: 'DELETE' }); toast({ kind: 'ok', title: 'Deleted' }); setDel(null); load(); }} />}
    </div>
  );
}

/** The side panel: which part of the chat to set up, as a dropdown. */
function Picker({ kind, count, onPick }: { kind: Kind; count: (k: Kind) => number; onPick: (k: Kind) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  const cur = SECTIONS.find((k) => k.kind === kind)!;
  return (
    <div className="cm-picker" ref={ref}>
      <button className="cm-pick" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <cur.icon /><b>{cur.label}</b>{cur.kind !== 'WELCOME' && <span className="cm-n">{count(cur.kind)}</span>}<ChevronDown className="cm-caret" />
      </button>
      {open && (
        <div className="cm-menu" role="listbox" aria-label="Chat config">
          {SECTIONS.map((k) => (
            <div key={k.kind}>
              {k.reps && <div className="cm-group-h">Only for reps</div>}
              <button role="option" aria-selected={k.kind === kind} className={k.kind === kind ? 'on' : ''} onClick={() => { onPick(k.kind); setOpen(false); }}>
                <k.icon />{k.label}{k.kind !== 'WELCOME' && <span className="cm-n">{count(k.kind)}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Editor({ kind, item, onCancel, onSave }: { kind: Kind; item: Partial<Item>; onCancel: () => void; onSave: (it: Partial<Item>, image: File | null | 'remove') => Promise<void> }) {
  const [f, setF] = useState<Partial<Item>>(item);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<File | null | 'remove'>(null);
  const [preview, setPreview] = useState<string | null>(item.imageId ? `/console/api/livechat-media/${item.imageId}` : null);
  const fileIn = useRef<HTMLInputElement>(null);
  const titleLabel = kind === 'QUESTION' ? 'Question' : kind === 'SAVED' ? 'Name' : 'Title';
  const bodyLabel = kind === 'QUESTION' ? 'Answer' : kind === 'CHIP' ? 'Message' : kind === 'WELCOME' ? 'Welcome line' : kind === 'SAVED' ? 'Reply' : 'Text';
  const pickImage = (file?: File) => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return alert('Use a JPG, PNG or WebP picture.');
    if (file.size > 5 * 1024 * 1024) return alert('Pictures can be up to 5 MB.');
    setImage(file); setPreview(URL.createObjectURL(file));
  };
  return (
    <form className="cm-editor" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(f, image); } finally { setBusy(false); } }}>
      {kind === 'NEWS' && (
        <div className="field"><label>Picture <span className="faint">(optional)</span></label>
          {preview ? (
            <div className="cm-img"><img src={preview} alt="" /><button type="button" className="sw-icon" aria-label="Remove the picture" onClick={() => { setImage(item.imageId ? 'remove' : null); setPreview(null); }}><X /></button></div>
          ) : <button type="button" className="cm-drop" onClick={() => fileIn.current?.click()}><ImagePlus /><span>Add a picture<small>JPG, PNG or WebP, up to 5 MB. Shown wide (16:9).</small></span></button>}
          <input ref={fileIn} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      )}
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
