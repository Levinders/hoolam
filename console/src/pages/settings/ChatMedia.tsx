import { ChevronDown, Clapperboard, FileText, Image as ImageIcon, LayoutTemplate, Mic, RotateCcw, Smile, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ago } from '../../format';
import { useData } from '../../hooks';
import { Button, Pill, useToast } from '../../ui';

/**
 * Settings → WhatsApp → Chat pictures and voice. Folded by default; each item folds too.
 * Pictures and stickers: Hoolam's own until replaced. Live cards: drawn for each order; a replacement is a background.
 * Voice notes and videos: nothing goes until one is uploaded; each has its script or shot list.
 */
type Kind = 'picture' | 'card' | 'voice' | 'video' | 'sticker';
interface Item { id: string; kind: Kind; title: string; when: string; size?: string; script?: string[]; length?: string; custom: boolean; updatedAt: string | null; fileName: string | null; bytes: number | null; mime: string | null }

const GROUPS: { kind: Kind; title: string; icon: typeof Mic; help: string }[] = [
  { kind: 'picture', title: 'Pictures', icon: ImageIcon, help: 'Drawn by Hoolam in your brand. Replace any of them with your own design at the size shown. The website shows some of them too, so a replacement changes both.' },
  { kind: 'card', title: 'Live cards', icon: LayoutTemplate, help: 'Drawn fresh for every order with its real amounts, names and photos. Upload a background to change the look; the words are drawn on top, so keep the middle calm.' },
  { kind: 'voice', title: 'Voice notes', icon: Mic, help: 'Nothing is sent until you upload one. Record each script on your phone (a WhatsApp voice note to yourself works), then upload the file. Most go only the first time someone reaches that moment. The ones marked Website play on hoolam.com instead; the play button shows once you upload.' },
  { kind: 'video', title: 'Videos', icon: Clapperboard, help: 'For later. Nothing is sent until you upload one. Vertical, 10 to 30 seconds, captions on screen, MP4 under 16 MB.' },
  { kind: 'sticker', title: 'Stickers', icon: Smile, help: 'Sent after a few happy moments. Replace with a 512 × 512 WebP or PNG with a see-through background.' },
];
const ACCEPT: Record<Kind, string> = {
  picture: 'image/jpeg,image/png,image/webp', card: 'image/jpeg,image/png,image/webp', sticker: 'image/webp,image/png',
  voice: 'audio/*,.opus,.ogg,.mp3,.m4a,.aac,.amr', video: 'video/mp4,video/3gpp,video/quicktime',
};
const MIME_BY_EXT: Record<string, string> = {
  opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
const mimeOf = (f: File) => MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] ?? f.type ?? 'application/octet-stream';
const fileUrl = (it: Item) => `/console/api/chat-media/${it.id}/file?v=${encodeURIComponent(it.updatedAt ?? 'default')}`;
const sizeText = (n: number | null) => n == null ? '' : n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`;

function upload(id: string, file: File, onProgress: (p: number) => void): Promise<{ items: Item[] }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/console/api/chat-media/${id}`);
    x.setRequestHeader('x-hoolam-console', '1');
    x.setRequestHeader('content-type', mimeOf(file));
    x.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let body: any = null; try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status === 401) window.dispatchEvent(new Event('hoolam:signed-out'));
      x.status >= 200 && x.status < 300 ? resolve(body) : reject(new Error(body?.error ?? `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    x.send(file);
  });
}

export function ChatMediaPanel() {
  const q = useData<{ items: Item[]; canEdit: boolean }>('/chat-media');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const list = items ?? q.data?.items ?? [];
  if (!q.data) return null;
  const n = (k: Kind) => list.filter((i) => i.kind === k);
  const yours = list.filter((i) => i.custom && (i.kind === 'picture' || i.kind === 'card' || i.kind === 'sticker')).length;
  const voices = n('voice'), recorded = voices.filter((v) => v.custom).length;
  return (
    <section className={`panel wam-panel${open ? ' open' : ''}`}>
      <button type="button" className="wam-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="wam-head-ic"><ImageIcon /></span>
        <span className="wam-head-text">
          <b>Chat pictures and voice</b>
          <span className="small muted">{list.length - voices.length - n('video').length} pictures and cards{yours ? ` · ${yours} of yours` : ''} · {recorded} of {voices.length} voice notes recorded</span>
        </span>
        <ChevronDown className={`wam-chev${open ? ' turned' : ''}`} />
      </button>
      {open && (
        <div className="wam-body">
          {GROUPS.map((g) => <Group key={g.kind} g={g} items={n(g.kind)} canEdit={q.data!.canEdit} onItems={setItems} />)}
        </div>
      )}
    </section>
  );
}

function Group({ g, items, canEdit, onItems }: { g: (typeof GROUPS)[number]; items: Item[]; canEdit: boolean; onItems: (i: Item[]) => void }) {
  const done = items.filter((i) => i.custom).length;
  const status = g.kind === 'voice' || g.kind === 'video' ? `${done} of ${items.length} uploaded` : done ? `${done} replaced` : 'All Hoolam\'s own';
  return (
    <div className="wam-group">
      <div className="wam-group-head"><g.icon /><h3>{g.title}</h3><span className="small muted">{status}</span></div>
      <p className="small muted wam-help">{g.help}</p>
      <ul className="wam-list">{items.map((it) => <Row key={it.id} it={it} canEdit={canEdit} onItems={onItems} />)}</ul>
    </div>
  );
}

function Row({ it, canEdit, onItems }: { it: Item; canEdit: boolean; onItems: (i: Item[]) => void }) {
  const [open, setOpen] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const media = it.kind === 'voice' || it.kind === 'video';
  const visual = !media;
  const pill = media ? (it.custom ? <Pill tone="green">Uploaded</Pill> : <Pill tone="grey">Not yet</Pill>) : it.custom ? <Pill tone="gold">Yours</Pill> : <Pill tone="teal">Hoolam's</Pill>;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(0);
    try {
      const r = await upload(it.id, f, (p) => setBusy(p));
      onItems(r.items);
      toast({ kind: 'ok', title: media ? `${it.title}: uploaded` : `${it.title}: replaced`, body: media ? 'It goes out from the next time that moment comes.' : 'New messages use it straight away.' });
    } catch (e) { toast({ kind: 'error', title: 'Not uploaded', body: (e as Error).message }); }
    finally { setBusy(null); if (input.current) input.current.value = ''; }
  };
  const reset = async () => {
    try {
      const r = await api<{ items: Item[] }>(`/chat-media/${it.id}`, { method: 'DELETE' });
      onItems(r.items);
      toast({ kind: 'ok', title: media ? `${it.title}: removed` : `${it.title}: back to Hoolam's`, body: media ? 'Nothing is sent for it now.' : undefined });
    } catch (e) { toast({ kind: 'error', title: 'Not changed', body: (e as Error).message }); }
  };

  return (
    <li className={`wam-row${open ? ' open' : ''}`}>
      <button type="button" className="wam-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`wam-thumb ${it.kind}`}>
          {visual ? <img src={fileUrl(it)} alt="" loading="lazy" /> : it.kind === 'voice' ? <Mic /> : <Clapperboard />}
        </span>
        <span className="wam-row-text"><b>{it.title}</b><span className="small muted">{it.when}</span></span>
        {pill}
        <ChevronDown className={`wam-chev${open ? ' turned' : ''}`} />
      </button>
      {open && (
        <div className="wam-row-body">
          {visual && <div className={`wam-preview ${it.kind}`}><img src={fileUrl(it)} alt={`${it.title}, as it goes out`} /></div>}
          {it.kind === 'voice' && it.custom && <audio className="wam-audio" controls preload="none" src={fileUrl(it)} />}
          {it.kind === 'video' && it.custom && <video className="wam-video" controls preload="none" src={fileUrl(it)} />}
          <div className="wam-side">
            <dl className="wam-facts">
              <div><dt>Used</dt><dd>{it.when}</dd></div>
              {it.size && <div><dt>{it.kind === 'card' ? 'Background size' : 'Size'}</dt><dd>{it.size}</dd></div>}
              {it.length && <div><dt>Length</dt><dd>About {it.length}</dd></div>}
              {it.custom && <div><dt>Yours</dt><dd>{it.fileName ?? 'Uploaded file'}{it.bytes ? ` · ${sizeText(it.bytes)}` : ''}{it.updatedAt ? ` · ${ago(it.updatedAt)}` : ''}</dd></div>}
            </dl>
            {it.kind === 'card' && <p className="small muted">The preview uses made-up details. Real messages show the order's own amounts, names and photos.</p>}
            {it.id.startsWith('form-') && <p className="small muted">This picture goes inside the WhatsApp form. Changing it sends the forms to Meta again; until the new version is ready, people keep getting the current one.</p>}
            {it.script && (
              <div className="wam-script">
                <button type="button" className="wam-script-toggle" aria-expanded={showScript} onClick={() => setShowScript(!showScript)}>
                  <FileText />{it.kind === 'voice' ? 'Script to say' : 'Shots to film'}<ChevronDown className={`wam-chev${showScript ? ' turned' : ''}`} />
                </button>
                {showScript && (it.kind === 'voice'
                  ? <div className="wam-lines">{it.script.map((l, i) => <p key={i}>{l}</p>)}</div>
                  : <ol className="wam-shots">{it.script.map((l, i) => <li key={i}>{l}</li>)}</ol>)}
              </div>
            )}
            {canEdit && (
              <div className="wam-actions">
                <input ref={input} type="file" accept={ACCEPT[it.kind]} hidden onChange={(e) => pick(e.target.files?.[0])} />
                <Button size="sm" variant={media && !it.custom ? 'primary' : 'ghost'} icon={Upload} busy={busy !== null} onClick={() => input.current?.click()}>
                  {busy !== null && busy > 0 && busy < 1 ? `Uploading ${Math.round(busy * 100)}%` : media ? (it.custom ? 'Upload a new one' : it.kind === 'voice' ? 'Upload recording' : 'Upload video') : it.kind === 'card' ? 'Upload background' : 'Replace'}
                </Button>
                {it.custom && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={reset}>{media ? 'Remove' : 'Back to Hoolam\'s'}</Button>}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

