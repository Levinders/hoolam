import { ArrowUpRight, ChevronDown, CircleCheck, CloudUpload, Eye, Image as ImageIcon, ImageOff, Link2, Lock, RefreshCw, Rocket, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useBrand } from '../../brand';
import { ago, dateOnly } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, ErrorBanner, Skeleton, useToast } from '../../ui';
import { SectionHead } from '../Settings';

interface Slot { key: string; group: 'brand' | 'website'; section?: number; label: string; hint: string; aspect: string; round?: boolean; maxWidth: number; svg?: boolean }
interface Item { slot: string; url: string; width: number | null; height: number | null; sizeBytes: number; originalName: string | null; updatedAt: string; updatedBy: string | null; mime: string }
interface Site { autoRefresh: boolean; pending: boolean; lastRequestedAt: string | null; lastError: string | null }
interface MediaData { slots: Slot[]; items: Record<string, Item>; site: Site; siteUrl: string | null; version: string }
interface Version { version: string; date: string; notes: string; from: string | null; live: boolean; images: number }
interface VersionsData { live: string; siteUrl: string | null; site: Site; lastLive: { at: string; actor: string; details: { from: string; to: string } } | null; websiteSpots: number; versions: Version[] }

const SECTIONS: Record<number, string> = { 1: 'Top of the page', 2: 'Second section', 3: 'The five steps', 4: 'Fourth section', 5: 'Quotes' };
const MAX = 12 * 1024 * 1024;
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Sends the file with progress (fetch can't report upload progress). */
function sendFile(slot: string, file: File, onProgress: (p: number) => void, version?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/console/api/media/${slot}${version ? `?version=${version}` : ''}`);
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

function useMedia(version?: string) {
  return useData<MediaData>(`/media${version ? `?version=${version}` : ''}`);
}

/** One image spot: preview (yours or the website's drawing), upload by click or drop, remove. */
function SlotCard({ slot, item, editable, onChanged, variant = 'card', version, liveVersion }: { slot: Slot; item?: Item; editable: boolean; onChanged: () => void; variant?: 'card' | 'logo' | 'icon'; version?: string; liveVersion?: string }) {
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
      await sendFile(slot.key, file, setProgress, slot.group === 'brand' ? undefined : version);
      toast({ kind: 'ok', title: `${slot.group === 'brand' ? slot.label : `Section ${slot.section} · ${slot.label}`} updated`, body: slot.group === 'brand' ? 'Shows on the website within about a minute.' : `Saved to version ${version}. ${version && version === liveVersion ? 'Shows on the website within about a minute.' : 'Shows when this version is live.'}` });
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
          const r = await fetch(`/console/api/media/${slot.key}${slot.group !== 'brand' && version ? `?version=${version}` : ''}`, { method: 'DELETE', headers: { 'x-hoolam-console': '1' } });
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

function Shell({ children, version }: { children: (d: MediaData, editable: boolean, reload: () => void) => React.ReactNode; version?: string }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useMedia(version);
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

const previewUrl = (siteUrl: string, v: string) => `${siteUrl.replace(/\/+$/, '')}/v/${v}/`;

/** Each version of the home page: preview it, edit its images, choose which one is live. */
export function ContentPage() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('brand.update');
  const vs = useData<VersionsData>('/site/versions');
  const [params, setParams] = useSearchParams();
  const [switching, setSwitching] = useState<Version | null>(null);
  const [goingLive, setGoingLive] = useState<string | null>(null);
  if (vs.error) return <><SectionHead title="Website content" lede="The home page, version by version." /><ErrorBanner error={vs.error} onRetry={vs.reload} /></>;
  if (!vs.data) return <><SectionHead title="Website content" lede="The home page, version by version." /><div className="stack"><Skeleton h={72} /><Skeleton h={220} /><Skeleton h={280} /></div></>;
  const d = vs.data;
  const asked = params.get('v');
  const selected = d.versions.some((v) => v.version === asked) ? asked! : d.live;
  const cur = d.versions.find((v) => v.version === selected)!;
  const pick = (v: string) => setParams(v === d.live ? {} : { v }, { replace: true });

  return (
    <>
      <SectionHead title="Website content" lede="Each version of the home page has its own images. Preview any version, then choose which one visitors see." />
      <div className="stack">
        <SiteStatus site={d.site} siteUrl={d.siteUrl} editable={editable} onDone={vs.reload} />
        {goingLive && (
          <div className="banner teal going-live" role="status"><Rocket /><div>
            <b>Version {goingLive} is going live.</b>{' '}
            {d.site.autoRefresh ? 'The website takes about 2 minutes to update. Refresh the website after that to see it.' : 'The website switches the next time it’s rebuilt. Add the website’s Deploy Hook on Render as SITE_DEPLOY_HOOK so this happens by itself.'}
          </div></div>
        )}

        <section className="panel ver-panel">
          <div className="ver-pick">
            <div className="field ver-field">
              <label htmlFor="home-version">Home page version</label>
              <div className="ver-select">
                <select id="home-version" className="select" value={selected} onChange={(e) => pick(e.target.value)}>
                  {d.versions.map((v) => <option key={v.version} value={v.version}>{v.version}{v.live ? '  ·  Live now' : ''}</option>)}
                </select>
                <ChevronDown aria-hidden="true" />
              </div>
            </div>
            <div className="ver-live small muted">
              Live now: <b>{d.live}</b>{d.lastLive && <><span> · made live by <b>{d.lastLive.actor}</b>, {ago(d.lastLive.at)}</span></>}
            </div>
          </div>
          <div className="ver-detail">
            <div className="ver-title">
              <b>Version {cur.version}</b>
              {cur.live ? <span className="pill green">Live</span> : <span className="pill grey plain">Not live</span>}
            </div>
            <p>{cur.notes}</p>
            <span className="small muted">{dateOnly(cur.date)} · {cur.images} of {d.websiteSpots} images are yours{cur.from ? ` · built on ${cur.from}` : ''}</span>
            <div className="ver-actions">
              {d.siteUrl
                ? <a className="btn" href={previewUrl(d.siteUrl, cur.version)} target="_blank" rel="noopener"><Eye />Preview<ArrowUpRight className="ext" /></a>
                : <span className="btn" aria-disabled="true" title="Add SITE_URL on the server to preview"><Eye />Preview</span>}
              {!cur.live && editable && <Button variant="primary" icon={Rocket} onClick={() => setSwitching(cur)}>Make live</Button>}
            </div>
          </div>
          <div className="ver-foot small muted">
            A new version is made when you approve a set of home page changes. Anyone with a preview link can open it, but search engines never list previews.
            {d.siteUrl && <> <a href={`${d.siteUrl.replace(/\/+$/, '')}/v/draft/`} target="_blank" rel="noopener">See the work in progress<ArrowUpRight /></a></>}
          </div>
        </section>

        <div id="version-images" className="ver-images-head">
          <h3>Images for version {selected}</h3>
          <span className="small muted">{selected === d.live ? 'This version is live, so changes show on the website within about a minute.' : 'This version isn’t live. Changes show in its preview, and on the website once it’s live.'}</span>
        </div>
        <div className="banner grey" style={{ margin: 0 }}><Link2 /><div>The logo is shared by every version. <Link to="/settings/brand">Change it on the Brand page</Link>.</div></div>
        <VersionImages key={selected} version={selected} live={d.live} onChanged={vs.reload} />
      </div>

      {switching && <ConfirmAction icon={Rocket} tone="teal" title={`Make version ${switching.version} live?`} confirmLabel={`Make ${switching.version} live`}
        reasonPlaceholder="For example: the new phone picture tested well"
        description={<>Visitors to the home page will see version <b>{switching.version}</b> instead of <b>{d.live}</b>. You can switch back at any time. The website takes about 2 minutes to update.</>}
        onClose={() => setSwitching(null)}
        onConfirm={async (reason) => {
          const next = await post<VersionsData>(`/site/versions/${switching.version}/live`, { reason });
          vs.setData(next);
          setGoingLive(switching.version);
          setParams({}, { replace: true });
          toast({ kind: 'ok', title: `Version ${switching.version} is going live`, body: 'About 2 minutes.' });
        }} />}
    </>
  );
}

function VersionImages({ version, live, onChanged }: { version: string; live: string; onChanged: () => void }) {
  return (
    <Shell version={version}>{(d, editable, reload) => {
      const web = d.slots.filter((s) => s.group === 'website');
      const sections = [...new Set(web.map((s) => s.section!))];
      const used = web.filter((s) => d.items[s.key]).length;
      const changed = () => { reload(); onChanged(); };
      return (
        <div className="stack">
          <div className="img-summary"><b>{used} of {web.length}</b> spots have your images<div className="meter"><i style={{ width: `${(used / web.length) * 100}%` }} /></div></div>
          {sections.map((n) => (
            <section className="panel img-section" key={n}>
              <div className="panel-head"><span className="sec-num">{n}</span><div><h2>Section {n}</h2><span className="small muted">{SECTIONS[n]}</span></div></div>
              <div className="panel-body">
                <div className="slot-grid">
                  {web.filter((s) => s.section === n).flatMap((s) => {
                    const card = <SlotCard key={s.key} slot={s} item={d.items[s.key]} editable={editable} onChanged={changed} version={version} liveVersion={live} />;
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
  );
}
