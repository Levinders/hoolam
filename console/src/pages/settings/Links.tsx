import { Check, Copy, Link2, Plus, QrCode, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, post } from '../../api';
import { useAuth } from '../../auth';
import { ago } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, ErrorBanner, Pill, Skeleton, useCopy, useToast } from '../../ui';
import { SectionHead } from '../Settings';

interface Row { slug: string; url: string; target: string; source: string; sourceLabel: string; campaign: string | null; page: string; pageLabel: string; createdAt: string; createdByName: string | null; taps7: number; tapsTotal: number }
interface Data { rows: Row[]; sources: { key: string; label: string }[]; pages: { key: string; label: string }[]; site: { autoRefresh: boolean; pending: boolean; lastRequestedAt: string | null } }

const tidy = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');

/**
 * Settings → Links: short links to post (hoolam.com/ig). Each opens the website and tells Google Analytics where the
 * visitor came from, without anyone typing tags. Taps are counted, and flyers get a QR code.
 */
export function LinksPage() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useData<Data>('/links');
  const editable = can('brand.update');
  const [slug, setSlug] = useState('');
  const [source, setSource] = useState('instagram');
  const [campaign, setCampaign] = useState('');
  const [page, setPage] = useState('/');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [del, setDel] = useState<Row | null>(null);

  if (q.error) return <><SectionHead title="Links" lede="Short links for your posts." /><ErrorBanner error={q.error} onRetry={q.reload} /></>;
  if (!q.data) return <><SectionHead title="Links" lede="Short links for your posts." /><div className="stack"><Skeleton h={160} /><Skeleton h={220} /></div></>;
  const d = q.data;
  // a new link's page is on the website once it has rebuilt (about 2 minutes)
  const ready = (r: Row) => !d.site.autoRefresh ? null : Date.now() - new Date(r.createdAt).getTime() > 3 * 60_000;

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const next = await post<Data & { created: string }>('/links', { slug, source, campaign: campaign || null, page });
      q.setData(next);
      toast({ kind: 'ok', title: `hoolam.com/${next.created} is set`, body: d.site.autoRefresh ? 'It works in about 2 minutes, once the website updates.' : 'It works after the next website update.' });
      setSlug(''); setCampaign('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <SectionHead title="Links" lede="Short links for your posts, bios and flyers. Each one opens the website and quietly tells Analytics where the visitor came from." />
      <div className="stack">
        {editable && (
          <section className="panel">
            <div className="panel-head"><h2>New link</h2></div>
            <form className="panel-body link-form" onSubmit={(e) => { e.preventDefault(); if (slug.length >= 2) void create(); }}>
              <div className="field">
                <label htmlFor="ln-slug">Link</label>
                <div className="link-prefix"><span>hoolam.com/</span><input id="ln-slug" className="input" placeholder="ig" value={slug} maxLength={40} autoComplete="off"
                  onChange={(e) => setSlug(tidy(e.target.value))} /></div>
              </div>
              <div className="field">
                <label htmlFor="ln-source">Where you'll post it</label>
                <select id="ln-source" className="select" value={source} onChange={(e) => setSource(e.target.value)}>
                  {d.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ln-campaign">Campaign <span className="faint">(optional)</span></label>
                <input id="ln-campaign" className="input" placeholder="launch" value={campaign} maxLength={60} onChange={(e) => setCampaign(tidy(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="ln-page">Opens</label>
                <select id="ln-page" className="select" value={page} onChange={(e) => setPage(e.target.value)}>
                  {d.pages.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <div className="link-go">
                <Button variant="primary" icon={Plus} busy={busy} disabled={slug.length < 2}>Create link</Button>
              </div>
              {err && <p className="err-text small link-err">{err}</p>}
            </form>
          </section>
        )}

        <section className="panel">
          <div className="panel-head"><h2>Your links</h2><span className="right small muted">{d.rows.length} {d.rows.length === 1 ? 'link' : 'links'}</span></div>
          {!d.rows.length ? (
            <div className="panel-body"><p className="small muted">No links yet. Make one for your Instagram bio, a TikTok post or a flyer, then share it instead of the plain website address.</p></div>
          ) : (
            <ul className="link-list">
              {d.rows.map((r) => <LinkRow key={r.slug} r={r} ready={ready(r)} editable={editable} onDelete={() => setDel(r)} />)}
            </ul>
          )}
        </section>
        <p className="small muted">Taps count each time someone opens the link. In Google Analytics, visits from a link show under its source (for example instagram) and campaign.</p>
      </div>

      {del && <ConfirmAction icon={Trash2} tone="danger" title={`Delete hoolam.com/${del.slug}?`} confirmLabel="Delete link" needReason={false}
        description={<>Anyone who taps it after the website updates gets the home page instead. Its tap count goes too.</>}
        onClose={() => setDel(null)}
        onConfirm={async () => { q.setData(await api<Data>(`/links/${del.slug}`, { method: 'DELETE' })); toast({ kind: 'ok', title: `hoolam.com/${del.slug} deleted` }); }} />}
    </>
  );
}

function LinkRow({ r, ready, editable, onDelete }: { r: Row; ready: boolean | null; editable: boolean; onDelete: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <li className="link-row">
      <div className="link-main">
        <div className="link-url">
          <Link2 aria-hidden="true" />
          <b>hoolam.com/{r.slug}</b>
          {ready === false ? <Pill tone="gold" plain>Ready in about 2 minutes</Pill> : ready === null ? <Pill tone="grey" plain>After the next website update</Pill> : <Pill tone="green" plain>Live</Pill>}
        </div>
        <div className="cell-sub">{r.sourceLabel}{r.campaign ? ` · ${r.campaign}` : ''}{r.page !== '/' ? ` · opens ${r.pageLabel}` : ''} · made {ago(r.createdAt)}{r.createdByName ? ` by ${r.createdByName.split(' ')[0]}` : ''}</div>
      </div>
      <div className="link-taps"><b>{r.taps7}</b><span>taps, 7 days</span></div>
      <div className="link-taps"><b>{r.tapsTotal}</b><span>all time</span></div>
      <div className="link-actions">
        <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={() => copy(r.url)}>{copied ? 'Copied' : 'Copy'}</Button>
        <a className="btn sm ghost" href={`/console/api/links/${r.slug}/qr.png`} download><QrCode />QR code</a>
        {editable && <button type="button" className="icon-btn danger" aria-label={`Delete hoolam.com/${r.slug}`} onClick={onDelete}><Trash2 /></button>}
      </div>
    </li>
  );
}
