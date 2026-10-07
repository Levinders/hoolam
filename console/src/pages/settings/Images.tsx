import { ArrowUpRight, CircleCheck, CloudUpload, ImageOff, Link2, Lock, RefreshCw, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useBrand } from '../../brand';
import { ago } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, ErrorBanner, Skeleton, useToast } from '../../ui';
import { SectionHead } from '../Settings';

interface Slot { key: string; group: 'brand' | 'website'; section?: number; label: string; hint: string; aspect: string; round?: boolean; maxWidth: number; svg?: boolean }
interface Item { slot: string; url: string; width: number | null; height: number | null; sizeBytes: number; originalName: string | null; updatedAt: string; updatedBy: string | null; mime: string }
interface Site { autoRefresh: boolean; pending: boolean; lastRequestedAt: string | null; lastError: string | null }
interface MediaData { slots: Slot[]; items: Record<string, Item>; site: Site; siteUrl: string | null }

const SECTIONS: Record<number, string> = { 1: 'Top of the page', 2: 'Second section', 3: 'The five steps', 4: 'Fourth section', 5: 'Quotes' };
const MAX = 12 * 1024 * 1024;
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Sends the file with progress (fetch can't report upload progress). */
function sendFile(slot: string, file: File, onProgress: (p: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/console/api/media/${slot}`);
    x.setRequestHeader('x-hoolam-console', '1');
    x.setRequestHeader('content-type', file.type && file.type.startsWith('image/') ? file.type : 'image/unknown');
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

/** Checks a file before uploading, so mistakes are explained right away. */
function precheck(file: File, svgOk: boolean): string | null {
  const n = file.name.toLowerCase();
  if (/\.(heic|heif)$/.test(n) || /hei[cf]/.test(file.type)) return 'iPhone HEIC photos can\'t be used. Send it as a JPG instead (or share it to yourself on WhatsApp first, then save it).';
  if (file.size > MAX) return `That file is ${kb(file.size)}. The limit is 12 MB.`;
  const isSvg = file.type === 'image/svg+xml' || n.endsWith('.svg');
  if (isSvg && !svgOk) return 'Use a photo (JPG, PNG or WebP) here. SVG is for logos.';
  if (!isSvg && file.type && !/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) return 'Use a JPG, PNG or WebP image.';
  return null;
}

function useMedia() {
  return useData<MediaData>('/media');
}

/** One image spot: preview (yours or the website's drawing), upload by click or drop, remove. */
function SlotCard({ slot, item, editable, onChanged, variant = 'card' }: { slot: Slot; item?: Item; editable: boolean; onChanged: () => void; variant?: 'card' | 'logo' | 'icon' }) {
  const toast = useToast();
  const { refreshBrand } = useBrand();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const fallback = `/console/slots/${slot.key}.webp`;
  const shown = preview ?? item?.url ?? fallback;

  const upload = async (file: File | undefined) => {
    if (!file || !editable || progress !== null) return;
    const bad = precheck(file, !!slot.svg);
    setErr(bad);
    if (bad) return;
    const local = URL.createObjectURL(file);
    setPreview(local); setProgress(0);
    try {
      await sendFile(slot.key, file, setProgress);
      toast({ kind: 'ok', title: `${slot.group === 'brand' ? slot.label : `Section ${slot.section} · ${slot.label}`} updated`, body: 'Shows on the website within about a minute.' });
      if (slot.group === 'brand') refreshBrand();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setProgress(null); setPreview(null); URL.revokeObjectURL(local);
    }
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files?.[0]); };

  return (
    <div className={`slot${variant !== 'card' ? ' slot-logo' : ''}${over ? ' over' : ''}${progress !== null ? ' busy' : ''}`}
      onDragOver={(e) => { if (editable) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <button type="button" className={`slot-preview${slot.round ? ' round' : ''}`} style={{ aspectRatio: slot.aspect }} disabled={!editable}
        onClick={() => input.current?.click()} aria-label={`${item ? 'Replace' : 'Upload'} ${slot.label}`}>
        {variant === 'icon'
          ? <span className="logo-stage icon-stage">{['on-light', 'on-dark'].map((c) => <span key={c} className={c}>{[64, 36, 20].map((n) => <img key={n} src={shown} alt="" style={{ width: n, height: n }} />)}</span>)}</span>
          : variant === 'logo'
          ? <span className="logo-stage"><span className="on-light"><img src={shown} alt="" /></span><span className="on-dark"><img src={preview ?? item?.url ?? '/console/slots/logo-dark.webp'} alt="" /></span></span>
          : <img src={shown} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />}
        <span className={`slot-badge${item || preview ? ' yours' : ''}`}>{item || preview ? <><CircleCheck />Your image</> : 'Drawing'}</span>
        {editable && <span className="slot-drop"><CloudUpload /><b>{over ? 'Drop to upload' : item ? 'Replace' : 'Upload'}</b><span>or drag a file here</span></span>}
        {progress !== null && <span className="slot-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(6, progress * 100)}%` }} /><span>{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Optimising…'}</span></span>}
      </button>
      <div className="slot-body">
        <div className="slot-title"><b>{slot.label}</b>{slot.round && <span className="pill grey plain">Round</span>}</div>
        <p>{slot.hint}</p>
        <span className="slot-meta">{item ? `${item.width ? `${item.width}×${item.height} · ` : 'SVG · '}${kb(item.sizeBytes)} · ${item.updatedBy ?? 'Someone'}, ${ago(item.updatedAt)}` : slot.svg ? 'PNG, SVG or WebP' : 'JPG, PNG or WebP · up to 12 MB'}</span>
        {err && <div className="slot-err" role="alert"><TriangleAlert />{err}</div>}
      </div>
      {editable && (
        <div className="slot-actions">
          <Button size="sm" icon={Upload} onClick={() => input.current?.click()} disabled={progress !== null}>{item ? 'Replace' : 'Upload'}</Button>
          {item && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRemoving(true)} disabled={progress !== null} aria-label="Remove"><span className="lbl">Remove</span></Button>}
        </div>
      )}
      <input ref={input} type="file" hidden accept={slot.svg ? 'image/png,image/jpeg,image/webp,image/svg+xml' : 'image/png,image/jpeg,image/webp'}
        onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      {removing && <ConfirmAction icon={ImageOff} tone="danger" needReason={false} title={`Remove ${slot.group === 'brand' ? 'the ' + slot.label.toLowerCase() : 'this image'}?`} confirmLabel="Remove"
        description={slot.group === 'brand' ? 'Every screen goes back to the built-in Hoolam logo.' : 'The website goes back to its drawing for this spot.'}
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          const r = await fetch(`/console/api/media/${slot.key}`, { method: 'DELETE', headers: { 'x-hoolam-console': '1' } });
          if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Not removed');
          toast({ kind: 'ok', title: 'Removed' });
          if (slot.group === 'brand') refreshBrand();
          onChanged();
        }} />}
    </div>
  );
}

/** "Changes show on the website…" with the state of the automatic refresh. */
function SiteStatus({ site, siteUrl, editable, onDone }: { site: Site; siteUrl: string | null; editable: boolean; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className={`site-status${site.autoRefresh ? '' : ' off'}`}>
      <span className="ss-ic">{site.autoRefresh ? <RefreshCw /> : <Link2 />}</span>
      <div>
        <b>{site.autoRefresh ? (site.pending ? 'Updating the website…' : 'The website updates by itself') : 'The website picks this up live'}</b>
        <span>{site.autoRefresh
          ? (site.lastError ? `Last refresh didn't start (${site.lastError}).` : site.lastRequestedAt ? `Last refreshed ${ago(site.lastRequestedAt)}. New uploads show within about a minute.` : 'New uploads show within about a minute.')
          : 'Visitors see new images once the server is awake. For instant loading, add the website\'s Deploy Hook on Render as SITE_DEPLOY_HOOK.'}</span>
      </div>
      <span className="spacer" />
      {site.autoRefresh && editable && <Button size="sm" variant="ghost" icon={RefreshCw} busy={busy} onClick={async () => {
        setBusy(true);
        try { await post('/media/refresh-site'); toast({ kind: 'ok', title: 'Website refresh started' }); onDone(); } catch (e) { toast({ kind: 'error', title: 'Didn\'t start', body: (e as Error).message }); } finally { setBusy(false); }
      }}>Refresh now</Button>}
      {siteUrl && <a className="btn sm" href={siteUrl} target="_blank" rel="noopener">Open website<ArrowUpRight /></a>}
    </div>
  );
}

function Shell({ children }: { children: (d: MediaData, editable: boolean, reload: () => void) => React.ReactNode }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useMedia();
  const editable = can('brand.update');
  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (loading || !data) return <div className="stack"><Skeleton h={44} w={320} /><Skeleton h={72} /><div className="slot-grid">{[1, 2, 3].map((i) => <Skeleton key={i} h={280} />)}</div></div>;
  return <>{!editable && <div className="banner gold" style={{ marginBottom: 16 }}><Lock /><div>Only owners and admins can change images. You can see them here.</div></div>}{children(data, editable, reload)}</>;
}

export function BrandPage() {
  return (
    <>
      <SectionHead title="Brand" lede="Your logo, used on the website and across this console. Without one, the built-in Hoolam logo shows." />
      <Shell>{(d, editable, reload) => (
        <div className="stack">
          <SiteStatus site={d.site} siteUrl={d.siteUrl} editable={editable} onDone={reload} />
          <div className="brand-grid">
            {d.slots.filter((s) => s.group === 'brand').map((s) => <SlotCard key={s.key} slot={s} item={d.items[s.key]} editable={editable} onChanged={reload} variant={s.key === 'logo' ? 'logo' : 'icon'} />)}
          </div>
          <section className="panel">
            <div className="panel-head"><h2>Where they show</h2></div>
            <div className="panel-body where-grid">
              <div><b>Logo</b><span>Top and bottom of the website · console sign-in page · the console menu if there's no logo icon</span></div>
              <div><b>Logo icon</b><span>Browser tab on the website and console · chat bubbles and the money step on the website · console menu</span></div>
            </div>
          </section>
        </div>
      )}</Shell>
    </>
  );
}

export function ImagesPage() {
  return (
    <>
      <SectionHead title="Website images" lede="Photos for each part of the website, top to bottom. Any spot without one keeps its drawing." />
      <Shell>{(d, editable, reload) => {
        const web = d.slots.filter((s) => s.group === 'website');
        const sections = [...new Set(web.map((s) => s.section!))];
        const used = web.filter((s) => d.items[s.key]).length;
        return (
          <div className="stack">
            <SiteStatus site={d.site} siteUrl={d.siteUrl} editable={editable} onDone={reload} />
            <div className="img-summary"><b>{used} of {web.length}</b> spots have your images<div className="meter"><i style={{ width: `${(used / web.length) * 100}%` }} /></div></div>
            {sections.map((n) => (
              <section className="panel img-section" key={n}>
                <div className="panel-head"><span className="sec-num">{n}</span><div><h2>Section {n}</h2><span className="small muted">{SECTIONS[n]}</span></div></div>
                <div className="panel-body">
                  <div className="slot-grid">
                    {web.filter((s) => s.section === n).flatMap((s) => {
                      const card = <SlotCard key={s.key} slot={s} item={d.items[s.key]} editable={editable} onChanged={reload} />;
                      if (s.key !== 's3-1') return [card];
                      // step 2 shows the logo icon, set on the Brand page
                      return [card, (
                        <div className="slot locked" key="s3-2">
                          <div className="slot-preview" style={{ aspectRatio: '5 / 4' }}>
                            <span className="locked-mark"><img src={d.items.mark?.url ?? '/console/slots/mark.webp'} alt="" /></span>
                            <span className="slot-badge">Logo icon</span>
                          </div>
                          <div className="slot-body"><div className="slot-title"><b>Step 2</b></div><p>Shows your logo icon in the middle.</p><span className="slot-meta"><Link to="/settings/brand">Change it on the Brand page</Link></span></div>
                        </div>
                      )];
                    })}
                  </div>
                </div>
              </section>
            ))}
            <p className="small muted">Tips: faces in the middle for round spots · photos are resized for phones automatically · landscape photos work best everywhere except the round spots.</p>
          </div>
        );
      }}</Shell>
    </>
  );
}
