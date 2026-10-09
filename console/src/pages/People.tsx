import { ArrowUpRight, CirclePause, ChevronRight, Gauge, Globe, ImageOff, Link2Off, Play, Search, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { ACTIONS, ago, dateOnly, dateTime, hours, money } from '../format';
import { useData, useDebounced } from '../hooks';
import { Avatar, Button, ConfirmAction, Empty, ErrorBanner, Pager, Seg, Skeleton, SkeletonRows, StatusPill, useToast } from '../ui';

export function People() {
  const [sp, setSp] = useSearchParams();
  const kind = sp.get('kind') ?? 'all';
  const page = Number(sp.get('page') ?? 1);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 300);
  const nav = useNavigate();
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  useEffect(() => { if ((sp.get('q') ?? '') !== dq) set('q', dq || null); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading, reload } = useData<any>(`/people?page=${page}${kind !== 'all' ? `&kind=${kind}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Buyers & sellers</h1><p className="lede">Everyone who has talked to Hoolam, their record, and the controls to keep orders safe.</p></div></div>
      <section className="panel">
        <div className="toolbar">
          <div className="input-icon"><Search aria-hidden="true" /><input className="input" placeholder="Name, shop name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" /></div>
          <Seg value={kind} onChange={(v) => set('kind', v === 'all' ? null : v)} options={[{ value: 'all', label: 'Everyone' }, { value: 'sellers', label: 'Sellers' }, { value: 'buyers', label: 'Buyers' }, { value: 'paused', label: 'Paused' }]} />
        </div>
        {error ? <div className="panel-body"><ErrorBanner error={error} onRetry={reload} /></div>
          : loading && !data ? <SkeletonRows rows={8} />
          : !data.rows.length ? <Empty icon={Users} title={dq ? `Nobody matches “${dq}”` : 'Nobody here yet'} />
          : (
            <>
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Person</th><th>Phone</th><th className="r">Sales</th><th className="r">Purchases</th><th>Last order</th><th>Joined</th></tr></thead>
                  <tbody>
                    {data.rows.map((u: any) => (
                      <tr key={u.id} className="link" tabIndex={0} onClick={() => nav(`/people/${u.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/people/${u.id}`); }}>
                        <td><div className="row"><Avatar name={u.business_name || u.display_name} gold={u.sales > 0} /><div><div className="cell-main">{u.business_name || u.display_name || 'No name'}</div>
                          <div className="cell-sub">{u.business_name && u.display_name ? u.display_name : u.city ?? ''}{u.blocked && <span className="pill red plain" style={{ height: 18, marginLeft: 6 }}>Paused</span>}{u.profile_public && <span className="pill teal plain" style={{ height: 18, marginLeft: 6 }}>Public page</span>}</div></div></div></td>
                        <td className="num">{u.phone}</td>
                        <td className="r num">{u.sales || <span className="faint">0</span>}</td>
                        <td className="r num">{u.purchases || <span className="faint">0</span>}</td>
                        <td className="muted">{u.last_deal_at ? ago(u.last_deal_at) : '—'}</td>
                        <td className="muted">{dateOnly(u.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />
            </>
          )}
      </section>
    </div>
  );
}

export function Person() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useData<any>(`/people/${id}`);
  const [open, setOpen] = useState<null | 'pause' | 'cap' | 'photo' | { social: string; label: string }>(null);
  const [cap, setCap] = useState<string>('');
  if (error) return <div className="page"><ErrorBanner error={error} onRetry={reload} /></div>;
  if (loading || !data) return <div className="page"><Skeleton h={30} w={300} /><div className="grid side" style={{ marginTop: 20 }}><Skeleton h={300} /><Skeleton h={300} /></div></div>;
  const u = data.user, s = data.seller, b = data.buyer;
  const name = u.business_name || u.display_name || u.phone;
  const capNow = u.deal_cap_minor ? Number(u.deal_cap_minor) : null;
  const stat = (label: string, value: string) => <div><div className="small muted">{label}</div><div className="money" style={{ fontSize: 20, fontWeight: 600 }}>{value}</div></div>;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/people">Buyers & sellers</Link><ChevronRight aria-hidden="true" /><span>{name}</span></nav>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          {s?.photoVersion
            ? <a href={`/console/api/people/${id}/photo`} target="_blank" rel="noreferrer" className="person-photo"><img src={`/console/api/people/${id}/photo?v=${s.photoVersion}`} alt={name} /></a>
            : <Avatar name={name} gold={s?.completed > 0} />}
          <div>
            <h1>{name}</h1>
            <p className="lede">{u.phone}{u.city ? ` · ${u.city}` : ''} · on Hoolam since {dateOnly(u.created_at)}</p>
          </div>
        </div>
        <div className="actions">
          {u.profile_slug && u.profile_public && <a className="btn" href={`/s/${u.profile_slug}`} target="_blank" rel="noreferrer"><Globe />Public page</a>}
          {can('user.cap') && <Button icon={Gauge} onClick={() => { setCap(capNow ? String(capNow / 100) : ''); setOpen('cap'); }}>Order limit</Button>}
          {can('user.block') && (u.blocked
            ? <Button icon={Play} variant="primary" onClick={() => setOpen('pause')}>Unpause account</Button>
            : <Button icon={CirclePause} variant="danger" onClick={() => setOpen('pause')}>Pause account</Button>)}
        </div>
      </div>
      {u.blocked && <div className="banner red" style={{ marginBottom: 16 }}><CirclePause /><div><b>Paused.</b> They can only talk to the team on WhatsApp. Reason: {u.blocked_reason ?? '—'}</div></div>}
      {data.optout && <div className="banner gold" style={{ marginBottom: 16 }}><CirclePause /><div>Tapped “Not me” on an alert {ago(data.optout.created_at)}. Hoolam never sends them alerts.</div></div>}

      <div className="grid side">
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>As a seller</h2>{s?.isNew ? <span className="pill teal plain" style={{ marginLeft: 'auto' }}>New on Hoolam</span> : null}</div>
            <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 16 }}>
              {stat('Orders completed', String(s?.completed ?? 0))}
              {stat('Different buyers', String(s?.buyers ?? 0))}
              {stat('Buyers happy', s?.rated ? `${Math.round((100 * s.happy) / s.rated)}%` : '—')}
              {stat('Usually ships in', hours(s?.shipHours))}
            </div>
            <div className="panel-body" style={{ borderTop: '1px solid var(--line-2)' }}>
              <span className="muted">Problems on their sales: </span>{s?.problems ? `${s.problems} reported · ${s.refunded} refunded · ${s.released} in their favour` : 'none'}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>As a buyer</h2></div>
            <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
              {stat('Purchases completed', String(b?.purchases ?? 0))}
              {stat('Problems reported', String(b?.problems ?? 0))}
              {stat('Ended in a refund', String(b?.refunded ?? 0))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Orders</h2><span className="muted small" style={{ marginLeft: 'auto' }}>Latest 30</span></div>
            {!data.deals.length ? <Empty icon={Users} title="No orders yet" /> : (
              <div className="table-wrap"><table className="t"><thead><tr><th>Order</th><th>As</th><th>Status</th><th className="r">Amount</th><th>Started</th></tr></thead>
                <tbody>{data.deals.map((d: any) => (
                  <tr key={d.code}><td><Link to={`/deals/${d.code}`} className="cell-main">{d.code}</Link><div className="cell-sub">{d.item}</div></td><td className="muted">{d.role === 'seller' ? 'Seller' : 'Buyer'}</td>
                    <td><StatusPill status={d.status} /></td><td className="r money">{money(d.buyer_pays_minor, d.currency)}</td><td className="muted">{dateOnly(d.created_at)}</td></tr>
                ))}</tbody></table></div>
            )}
          </section>
        </div>
        <div className="stack">
          {s && (s.photoVersion || s.socials.length > 0 || u.profile_slug) && (
            <section className="panel">
              <div className="panel-head"><h2>Their public page</h2>{u.profile_public ? <span className="pill green plain" style={{ marginLeft: 'auto' }}>Live</span> : <span className="pill grey plain" style={{ marginLeft: 'auto' }}>Hidden</span>}</div>
              <div className="panel-body stack" style={{ gap: 12 }}>
                {s.photoVersion ? (
                  <div className="row" style={{ gap: 12 }}>
                    <img className="page-photo" src={`/console/api/people/${id}/photo?v=${s.photoVersion}`} alt="" />
                    <div style={{ flex: 1 }}><div className="cell-main">Photo</div><div className="cell-sub">Shown on their page and when their link is shared</div></div>
                    {can('user.block') && <Button size="sm" variant="ghost" icon={ImageOff} onClick={() => setOpen('photo')}>Remove</Button>}
                  </div>
                ) : <p className="small muted">No photo yet. Sellers add one from “My trust card” on WhatsApp.</p>}
                {s.socials.length > 0 && <div className="links">{s.socials.map((l: any) => (
                  <div key={l.kind} className="row" style={{ gap: 10 }}>
                    <span className={`soc-dot ${l.kind}`} aria-hidden="true" />
                    <div style={{ flex: 1, minWidth: 0 }}><div className="cell-sub">{({ instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', website: 'Website' } as Record<string, string>)[l.kind]}</div>
                      <a className="cell-main" href={l.url} target="_blank" rel="noopener noreferrer nofollow" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{l.label}<ArrowUpRight style={{ width: 13, height: 13 }} /></a></div>
                    {can('user.block') && <Button size="sm" variant="ghost" icon={Link2Off} onClick={() => setOpen({ social: l.kind, label: l.label })}>Remove</Button>}
                  </div>
                ))}</div>}
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-head"><h2>Limits</h2></div>
            <div className="panel-body"><dl className="kv"><dt>Largest order</dt><dd className="money">{money(capNow ?? data.normalCapMinor)} {capNow ? <span className="pill gold plain">Custom</span> : <span className="muted small">normal limit</span>}</dd></dl></div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Payout accounts</h2></div>
            <div className="panel-body stack" style={{ gap: 10 }}>
              {!data.banks.length ? <p className="muted small">None added yet.</p> : data.banks.map((a: any, i: number) => (
                <div key={i} className="row"><div style={{ flex: 1 }}><div className="cell-main">{a.account_name}</div><div className="cell-sub">{a.bank_name} ••••{a.last4}</div></div>{a.is_default && <span className="pill teal plain">In use</span>}</div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Team actions on this person</h2></div>
            <div className="panel-body">
              {!data.trail.length ? <p className="muted small">Nobody on the team has changed anything here.</p> : (
                <ol className="timeline">{data.trail.map((t: any, i: number) => (
                  <li key={i}><span className="ic staff"><Users /></span><div className="what">{ACTIONS[t.action] ?? t.action}</div><div className="meta">{t.actor} · {dateTime(t.at)}</div>{t.reason && <div className="why">{t.reason}</div>}</li>
                ))}</ol>
              )}
            </div>
          </section>
        </div>
      </div>

      {open === 'pause' && <ConfirmAction icon={u.blocked ? Play : CirclePause} tone={u.blocked ? 'teal' : 'danger'}
        title={u.blocked ? `Unpause ${name}?` : `Pause ${name}?`} confirmLabel={u.blocked ? 'Unpause account' : 'Pause account'}
        description={u.blocked ? 'They can start and join orders again.' : 'They can\'t start or join orders until unpaused. Orders already paid carry on. They can still talk to the team.'}
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => { await post(`/people/${id}/pause`, { paused: !u.blocked, reason }); toast({ kind: 'ok', title: u.blocked ? 'Account unpaused' : 'Account paused' }); reload(); }} />}
      {open === 'photo' && <ConfirmAction icon={ImageOff} tone="danger" title="Remove their photo?" confirmLabel="Remove photo"
        description="It disappears from their page and from shared links. They can add another one on WhatsApp."
        reasonPlaceholder="e.g. Not a photo of the seller or their shop"
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => { await api(`/people/${id}/photo`, { method: 'DELETE', body: { reason } }); toast({ kind: 'ok', title: 'Photo removed' }); reload(); }} />}
      {open && typeof open === 'object' && <ConfirmAction icon={Link2Off} tone="danger" title={`Remove ${open.label}?`} confirmLabel="Remove link"
        description="It disappears from their page. They can add a link again on WhatsApp."
        reasonPlaceholder="e.g. Links to someone else's shop"
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => { await api(`/people/${id}/social`, { method: 'PUT', body: { kind: open.social, value: null, reason } }); toast({ kind: 'ok', title: 'Link removed' }); reload(); }} />}
      {open === 'cap' && <ConfirmAction icon={Gauge} tone="gold" title="Set their order limit" confirmLabel="Save limit"
        description={<>The most one order can be for {name}. Leave it empty to use the normal limit ({money(data.normalCapMinor)}).</>}
        extra={<div className="field"><label htmlFor="cap">Largest order (₦)</label><input id="cap" className="input" inputMode="numeric" placeholder="e.g. 200000" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ''))} /></div>}
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => { await post(`/people/${id}/cap`, { cap: cap ? Number(cap) : null, reason }); toast({ kind: 'ok', title: 'Order limit saved' }); reload(); }} />}
    </div>
  );
}
