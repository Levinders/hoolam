import { Ban, Check, Copy, ExternalLink, Flag, Link2, PackageSearch, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, Store, Trash2, TrendingUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { ago, dateOnly, money, moneyShort, pct, phone } from '../format';
import { useData } from '../hooks';
import { AreaChart, BarChart, Button, ConfirmAction, Empty, ErrorBanner, Modal, Pill, Seg, Skeleton, SkeletonRows, useCopy, useToast } from '../ui';

/**
 * Market (main menu): how the market is doing, the regular check of new and reported items, sellers (asking to
 * list, more items, limits, stopped), every item, and ad links. Settings live in Settings → Features → Market.
 */
type Tab = 'overview' | 'check' | 'sellers' | 'items' | 'ads';
const STATUS: Record<string, { label: string; tone: 'green' | 'gold' | 'grey' | 'teal' | 'red' }> = {
  LIVE: { label: 'Live', tone: 'green' }, SOLD_OUT: { label: 'Sold out', tone: 'grey' }, PAUSED: { label: 'Paused', tone: 'gold' },
  HIDDEN: { label: 'Paused for a look', tone: 'gold' }, EXPIRED: { label: 'Expired', tone: 'grey' }, REMOVED: { label: 'Removed', tone: 'red' },
};
const photo = (id: number, pos = 0) => `/console/api/market/photo/${id}/${pos}`;
const n0 = (n: number) => Number(n || 0).toLocaleString('en-NG');

export function MarketPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'overview';
  const q = useData<any>('/market');
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  if (q.error) return <div className="page"><ErrorBanner error={q.error} onRetry={q.reload} /></div>;
  if (!q.data) return <div className="page"><Skeleton h={30} w={240} /><div className="kpis" style={{ marginTop: 20 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={86} />)}</div><Skeleton h={320} style={{ marginTop: 16 }} /></div>;
  const d = q.data, o = d.overview;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Market</h1><p className="lede">Sellers list items in WhatsApp; buyers browse them as swipe cards and pay through Hoolam.</p></div>
        <div className="actions"><Link className="btn" to="/settings/features"><Settings2 />Settings</Link></div>
      </div>
      {!d.on && <div className="banner gold" style={{ marginBottom: 16 }}><Store /><div><b>The market is off.</b> Nobody sees it in WhatsApp. Everything listed is kept. Turn it on in <Link to="/settings/features">Settings → Features → Market</Link>.</div></div>}
      <div className="kpis">
        <div className="kpi"><div className="k">Live items</div><div className="v">{n0(o.totals.live)}</div><div className="d flat">{n0(o.totals.new_week)} listed this week</div></div>
        <div className="kpi"><div className="k">Sellers listing</div><div className="v">{n0(o.totals.sellers)}</div><div className="d flat">{o.totals.sold_out ? `${n0(o.totals.sold_out)} item${o.totals.sold_out === 1 ? '' : 's'} sold out` : 'With live items'}</div></div>
        <div className="kpi"><div className="k">Market sales</div><div className="v money">{money(o.money.salesMinor)}</div><div className="d flat">{n0(o.money.orders)} paid order{o.money.orders === 1 ? '' : 's'} · 30 days</div></div>
        <div className="kpi"><div className="k">Hoolam earned</div><div className="v money">{money(o.money.earnedMinor)}</div><div className="d flat">Fees on market orders · 30 days</div></div>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="toolbar mk-tabs">
          <Seg value={tab} onChange={setTab} options={[
            { value: 'overview', label: 'Overview' },
            { value: 'check', label: 'To check', n: o.totals.to_check || undefined },
            { value: 'sellers', label: 'Sellers', n: (o.waiting.applications + o.waiting.upgrades) || undefined },
            { value: 'items', label: 'All items' },
            ...(d.adLinks ? [{ value: 'ads' as Tab, label: 'Ad links' }] : []),
          ]} />
        </div>
        {tab === 'overview' && <Overview o={o} cats={d.categories} />}
        {tab === 'check' && <CheckList canReview={d.canReview} reportsHide={d.reportsHide} cats={d.categories} onChange={q.reload} />}
        {tab === 'sellers' && <Sellers d={d} onChange={q.reload} />}
        {tab === 'items' && <Items cats={d.categories} />}
        {tab === 'ads' && <Ads canManage={d.canManage} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
/** The numbers: how buyers move from a card to a paid order, by day, what sells, and what people look for. */
function Overview({ o, cats }: { o: any; cats: Record<string, string> }) {
  const a = o.activity;
  const steps: [string, number, string][] = [
    ['Cards seen', a.seen, 'Shown in a swipe page'],
    ['Opened', a.views, 'See more, or the item page'],
    ['Tapped Buy safely', a.buys, 'Started an order'],
    ['Paid', a.orders, 'Money held by Hoolam'],
  ];
  if (!a.seen && !o.totals.live) return <Empty icon={Store} title="Nothing listed yet">When sellers list items, you'll see here how buyers find them, what sells and what people search for.</Empty>;
  return (
    <div className="panel-body stack" style={{ gap: 18 }}>
      <div className="grid side">
        <div>
          <h3 className="mk-h">From card to paid order <span className="muted small">last 30 days</span></h3>
          <div className="funnel">
            {steps.map(([label, n, hint], i) => (
              <div className="funnel-row" key={label} title={hint}>
                <span>{label}</span>
                <div className="funnel-bar"><i style={{ width: `${Math.max(2, pct(n, Math.max(1, steps[0]![1])))}%`, animationDelay: `${i * 70}ms` }} /></div>
                <span className="num" style={{ textAlign: 'right' }}><b>{n0(n)}</b> <span className="muted">{i ? `${pct(n, steps[i - 1]![1])}%` : ''}</span></span>
              </div>
            ))}
          </div>
          <p className="small" style={{ marginTop: 10 }}>❤️ <b>{n0(a.saves)}</b> saves · {pct(a.saves, Math.max(1, a.views))}% of items opened. Saved items bring buyers back.</p>
          <p className="small muted" style={{ marginTop: 4 }}>Each percentage is how many made it from the step above. A big drop at <b>Opened</b> usually means weak photos or prices; at <b>Paid</b>, sellers slow to accept.</p>
        </div>
        <div>
          <h3 className="mk-h">Searched, nothing found <span className="muted small">what buyers want</span></h3>
          {!o.missing.length ? <p className="small muted">Every search found something. 👍</p> : (
            <ul className="mk-words">{o.missing.map((x: any) => <li key={x.query}><span>{x.query}</span><b>{x.n}×</b></li>)}</ul>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>Tell sellers: these are items buyers asked for and couldn't find.</p>
        </div>
      </div>

      <div className="grid two">
        <div><h3 className="mk-h">Items opened per day</h3><AreaChart data={o.days} value={(x) => x.views} format={(n) => String(Math.round(n))} label="Items opened per day" /></div>
        <div><h3 className="mk-h">Paid market orders per day</h3><BarChart data={o.days} value={(x) => x.orders} format={(n) => String(Math.round(n))} label="Paid market orders per day" /></div>
      </div>

      <div className="grid two">
        <div>
          <h3 className="mk-h">What sells <span className="muted small">last 30 days</span></h3>
          {!o.top.length ? <p className="small muted">No item has been opened yet.</p> : (
            <ul className="mk-top">{o.top.map((t: any) => (
              <li key={t.id}>
                <img src={photo(t.id)} alt="" loading="lazy" />
                <div className="mk-top-t"><b>{t.title}</b><span className="cell-sub">{t.seller} · {money(t.price_minor)}</span></div>
                <span className="mk-top-n" title="Opened · saved · paid orders">{n0(t.views)} <small>opened</small> · {n0(t.saves)} <small>saved</small> · <b>{n0(t.orders)}</b> <small>sold</small></span>
              </li>
            ))}</ul>
          )}
        </div>
        <div>
          <h3 className="mk-h">Categories</h3>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Category</th><th className="r">Live</th><th className="r">Opened</th><th className="r">Sold</th></tr></thead>
            <tbody>{o.categories.map((c: any) => (
              <tr key={c.category}><td>{cats[c.category] ?? c.category}</td><td className="r num">{n0(c.live)}</td><td className="r num">{n0(c.views)}</td><td className="r num">{n0(c.orders)}{c.views ? <span className="faint small"> · {pct(c.orders, c.views)}%</span> : null}</td></tr>
            ))}</tbody>
          </table></div>
          {!!o.searches.length && (<>
            <h3 className="mk-h" style={{ marginTop: 16 }}>Top searches</h3>
            <ul className="mk-words">{o.searches.map((x: any) => <li key={x.query}><span>{x.query}</span><b>{x.n}×</b>{!x.found && <Pill tone="gold" plain>none found</Pill>}</li>)}</ul>
          </>)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
/** The regular check: new items since the last look (reported ones first). Keep, or remove with a reason. */
function CheckList({ canReview, reportsHide, cats, onChange }: { canReview: boolean; reportsHide: number; cats: Record<string, string>; onChange: () => void }) {
  const q = useData<any>('/market/check');
  const toast = useToast();
  const [remove, setRemove] = useState<any>(null);
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const keep = async (r: any) => {
    setBusy(r.id);
    try { await post(`/market/listings/${r.id}/keep`, {}); q.reload(); onChange(); } catch (e) { toast({ kind: 'error', title: 'Not kept', body: (e as Error).message }); } finally { setBusy(null); }
  };
  const rows = q.data?.rows ?? [];
  const clean = rows.filter((r: any) => !r.reports && r.status !== 'HIDDEN');
  return (
    <>
      <div className="panel-body row wrap" style={{ gap: 10, paddingBottom: 0 }}>
        <p className="small muted" style={{ margin: 0, flex: 1, minWidth: 240 }}>Items go live straight away. Look over new ones here: <b>Keep</b> clears them from this list; <b>Remove</b> takes them down, tells the seller why, and counts a strike. Items with {reportsHide} report{reportsHide === 1 ? '' : 's'} pause on their own until you look.</p>
        {canReview && clean.length > 1 && <Button icon={Check} busy={busy === 'all'} onClick={async () => {
          setBusy('all');
          try { await post('/market/keep-all', { ids: clean.map((r: any) => r.id) }); toast({ kind: 'ok', title: `${clean.length} items kept` }); q.reload(); onChange(); } finally { setBusy(null); }
        }}>Keep all {clean.length} without reports</Button>}
      </div>
      {q.error ? <div className="panel-body"><ErrorBanner error={q.error} onRetry={q.reload} /></div>
        : !q.data ? <SkeletonRows rows={4} />
        : !rows.length ? <Empty icon={ShieldCheck} title="All looked over">New items show here as sellers list them.</Empty>
        : (
          <ul className="mk-check">
            {rows.map((r: any) => (
              <li key={r.id} className={r.reports ? 'flagged' : ''}>
                <a href={r.url} target="_blank" rel="noreferrer" className="mk-ph"><img src={photo(r.id)} alt={r.title} loading="lazy" /></a>
                <div className="mk-body">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <b className="mk-title">{r.title}</b>
                    {r.status !== 'LIVE' && <Pill tone={STATUS[r.status]?.tone ?? 'grey'} plain>{STATUS[r.status]?.label ?? r.status}</Pill>}
                    {r.reports > 0 && <Pill tone="red" plain><Flag style={{ width: 12, height: 12 }} />{r.reports} report{r.reports === 1 ? '' : 's'}</Pill>}
                  </div>
                  <div className="mk-price">{r.promo_minor ? <><s>{money(r.price_minor)}</s> {money(r.promo_minor)}</> : money(r.price_minor)} <span className="muted small">· {cats[r.category] ?? r.category} · {r.stock} in stock</span></div>
                  {r.details && <p className="mk-details">{r.details}</p>}
                  {r.reasons?.length ? <p className="small" style={{ color: 'var(--red)', margin: '4px 0 0' }}>Reported: {r.reasons.join(', ')}</p> : null}
                  <div className="cell-sub"><Link to={`/people/${r.seller_id}`}>{r.seller_name}</Link>{r.kyc_status === 'VERIFIED' && ' · ✓ ID checked'} · {[r.area, r.city].filter(Boolean).join(', ') || 'No area'} · listed {ago(r.created_at)}</div>
                </div>
                {canReview && (
                  <div className="mk-acts">
                    <Button size="sm" icon={Check} busy={busy === r.id} onClick={() => keep(r)}>{r.status === 'HIDDEN' ? 'Keep and show' : 'Keep'}</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRemove(r)}>Remove</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {remove && <ConfirmAction icon={Trash2} tone="danger" title={`Remove “${remove.title}”?`} confirmLabel="Remove"
        description="It comes down now. The seller gets a WhatsApp message with the item's picture and your reason, and it counts as a strike."
        reasonPlaceholder="e.g. Fake designer item · Not allowed in the market · Photo taken from another seller"
        onClose={() => setRemove(null)}
        onConfirm={async (reason) => {
          const r = await post<{ stopped: boolean }>(`/market/listings/${remove.id}/remove`, { reason });
          toast({ kind: 'ok', title: 'Removed', body: r.stopped ? 'That was their last strike: they can\'t list until you let them (Sellers).' : 'The seller has been told.' });
          q.reload(); onChange();
        }} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
/** Sellers asking to list, asking for more items, and everyone listing (limits, strikes, stop or allow). */
function Sellers({ d, onChange }: { d: any; onChange: () => void }) {
  const q = useData<any>('/market/sellers');
  const toast = useToast();
  const [decline, setDecline] = useState<any>(null);
  const [upgrade, setUpgrade] = useState<{ row: any; ok: boolean } | null>(null);
  const [ref, setRef] = useState('');
  const [limit, setLimit] = useState<any>(null);
  const [stop, setStop] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const approve = async (a: any) => {
    setBusy(a.user_id);
    try { await post(`/market/sellers/${a.user_id}/decide`, { ok: true }); toast({ kind: 'ok', title: `${a.name} can list`, body: 'They got a WhatsApp message.' }); q.reload(); onChange(); }
    catch (e) { toast({ kind: 'error', title: 'Not approved', body: (e as Error).message }); } finally { setBusy(null); }
  };
  if (q.error) return <div className="panel-body"><ErrorBanner error={q.error} onRetry={q.reload} /></div>;
  if (!q.data) return <SkeletonRows rows={5} />;
  const apps = q.data.applications.filter((a: any) => a.status === 'APPLIED');
  const asks = q.data.upgrades.filter((u: any) => u.status === 'ASKED');
  return (
    <div className="panel-body stack" style={{ gap: 20 }}>
      {d.approval || apps.length ? (
        <div>
          <h3 className="mk-h">Asking to list {apps.length ? <Pill tone="gold" plain>{apps.length}</Pill> : null}</h3>
          {!apps.length ? <p className="small muted">Nobody waiting. With approval on, sellers tap <b>Apply</b> under My items in WhatsApp.</p> : (
            <ul className="amb-apps">{apps.map((a: any) => (
              <li key={a.user_id} className="amb-app">
                <div className="amb-app-top">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cell-main"><Link to={`/people/${a.user_id}`}>{a.name}</Link></div>
                    <div className="cell-sub">{phone(a.phone)} · {a.kyc_status === 'VERIFIED' ? '✓ ID checked' : 'ID not checked yet'} · {a.completed ? `${a.completed} completed order${a.completed === 1 ? '' : 's'}` : 'No orders yet'} · asked {ago(a.created_at)}</div>
                  </div>
                </div>
                {a.note && <p className="amb-why">“{a.note}”</p>}
                {d.canReview && <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <Button variant="primary" icon={Check} busy={busy === a.user_id} onClick={() => approve(a)}>Approve</Button>
                  <Button variant="ghost" icon={X} onClick={() => setDecline(a)}>Decline</Button>
                </div>}
              </li>
            ))}</ul>
          )}
        </div>
      ) : null}

      {(d.upgrade.on || asks.length) ? (
        <div>
          <h3 className="mk-h">Want more items {asks.length ? <Pill tone="gold" plain>{asks.length}</Pill> : null} <span className="muted small">{d.upgrade.items} items for {money(d.upgrade.priceMinor)} / month</span></h3>
          {!asks.length ? <p className="small muted">Nobody waiting. Sellers at their limit see <b>Get more items</b> in WhatsApp.</p> : (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Seller</th><th className="r">To pay</th><th>Asked</th><th /></tr></thead>
              <tbody>{asks.map((u: any) => (
                <tr key={u.id}>
                  <td><Link to={`/people/${u.user_id}`} className="cell-main">{u.name}</Link><div className="cell-sub">{phone(u.phone)}</div></td>
                  <td className="r money">{money(u.amount_minor)}</td>
                  <td className="nowrap">{ago(u.created_at)}</td>
                  <td className="r">{d.canManage && <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="primary" icon={Check} onClick={() => { setRef(''); setUpgrade({ row: u, ok: true }); }}>Paid</Button>
                    <Button size="sm" variant="ghost" icon={X} onClick={() => setUpgrade({ row: u, ok: false })}>Decline</Button>
                  </div>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      ) : null}

      <div>
        <h3 className="mk-h">Everyone listing <span className="muted small">{d.perSeller} items each by default · {d.strikes} strikes stop listing</span></h3>
        {!q.data.sellers.length ? <p className="small muted">Nobody has listed yet.</p> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Seller</th><th className="r">Items</th><th className="r">Market orders</th><th className="r">Strikes</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.sellers.map((s: any) => {
              const full = s.items >= s.limit;
              return (
                <tr key={s.user_id}>
                  <td><Link to={`/people/${s.user_id}`} className="cell-main">{s.name}</Link><div className="cell-sub">{phone(s.phone)} · listed {ago(s.last_listed)}</div></td>
                  <td className="r"><span className="num">{s.items}</span><span className="faint"> / {s.limit}</span>{s.limit_until && <div className="cell-sub">until {dateOnly(s.limit_until)}</div>}{full && <div className="cell-sub" style={{ color: 'var(--gold-ink)' }}>at limit</div>}</td>
                  <td className="r num">{s.orders}</td>
                  <td className="r num">{s.strikes ? <span style={{ color: s.strikes >= d.strikes - 1 ? 'var(--red)' : undefined }}>{s.strikes}</span> : <span className="faint">0</span>}</td>
                  <td>{s.status === 'STOPPED' ? <Pill tone="red" plain>Can't list</Pill> : s.status === 'DECLINED' ? <Pill tone="grey" plain>Declined</Pill> : <Pill tone="green" plain>Listing</Pill>}{s.reason && <div className="cell-sub">{s.reason}</div>}</td>
                  <td className="r">{d.canManage && <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setLimit({ ...s, value: String(s.item_limit ?? s.limit), days: '' })}>Limit</Button>
                    <Button size="sm" variant="ghost" icon={s.status === 'STOPPED' ? Check : Ban} onClick={() => setStop(s)}>{s.status === 'STOPPED' ? 'Allow' : 'Stop'}</Button>
                  </div>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>

      {decline && <ConfirmAction icon={X} tone="danger" title={`Decline ${decline.name}?`} confirmLabel="Decline"
        description="They get a WhatsApp message with your reason, and can still sell with Sell something."
        reasonPlaceholder="e.g. Please check your ID first · We don't allow phones in the market yet"
        onClose={() => setDecline(null)}
        onConfirm={async (reason) => { await post(`/market/sellers/${decline.user_id}/decide`, { ok: false, reason }); toast({ kind: 'ok', title: 'Declined' }); q.reload(); onChange(); }} />}
      {upgrade && <ConfirmAction icon={upgrade.ok ? Check : X} tone={upgrade.ok ? 'gold' : 'danger'} needReason={!upgrade.ok}
        title={upgrade.ok ? `${upgrade.row.name} paid ${money(upgrade.row.amount_minor)}?` : `Decline ${upgrade.row.name}'s request?`}
        confirmLabel={upgrade.ok ? 'Confirm payment' : 'Decline'}
        description={upgrade.ok ? `Their limit goes up to ${upgrade.row.items} items for 30 days, and they get a WhatsApp message.` : 'They get a WhatsApp message to talk to a rep.'}
        extra={upgrade.ok ? <div className="field"><label htmlFor="ref">Payment reference</label><input id="ref" className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="From the transfer, so it can be found later" /></div> : undefined}
        extraValid={!upgrade.ok || ref.trim().length >= 3}
        onClose={() => setUpgrade(null)}
        onConfirm={async (reason) => { await post(`/market/upgrades/${upgrade.row.id}`, { ok: upgrade.ok, reference: ref, reason }); toast({ kind: 'ok', title: upgrade.ok ? 'Limit raised' : 'Declined' }); q.reload(); onChange(); }} />}
      {limit && <ConfirmAction icon={SlidersHorizontal} tone="gold" title={`Items for ${limit.name}`} confirmLabel="Save limit"
        description={`Everyone else can have ${d.perSeller} live items. Leave it empty to go back to that.`}
        extra={<div className="row" style={{ gap: 10 }}>
          <div className="field" style={{ flex: 1 }}><label htmlFor="lim">Live items</label><input id="lim" className="input num" type="number" min={1} value={limit.value} onChange={(e) => setLimit({ ...limit, value: e.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label htmlFor="days">For how many days</label><input id="days" className="input num" type="number" min={1} placeholder="Always" value={limit.days} onChange={(e) => setLimit({ ...limit, days: e.target.value })} /></div>
        </div>}
        onClose={() => setLimit(null)}
        onConfirm={async (reason) => { await post(`/market/sellers/${limit.user_id}/limit`, { limit: limit.value === '' ? null : Number(limit.value), days: limit.days ? Number(limit.days) : null, reason }); toast({ kind: 'ok', title: 'Limit saved' }); q.reload(); }} />}
      {stop && <ConfirmAction icon={stop.status === 'STOPPED' ? Check : Ban} tone={stop.status === 'STOPPED' ? 'gold' : 'danger'}
        title={stop.status === 'STOPPED' ? `Let ${stop.name} list again?` : `Stop ${stop.name} listing?`}
        confirmLabel={stop.status === 'STOPPED' ? 'Allow listing' : 'Stop listing'}
        description={stop.status === 'STOPPED' ? 'Their strikes are cleared and they get a WhatsApp message. Their paused items stay paused until they resume them.' : 'Their live items pause now and they can\'t list until you allow them again. Orders already running carry on.'}
        onClose={() => setStop(null)}
        onConfirm={async (reason) => { await post(`/market/sellers/${stop.user_id}/stop`, { stop: stop.status !== 'STOPPED', reason }); toast({ kind: 'ok', title: 'Saved' }); q.reload(); onChange(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function Items({ cats }: { cats: Record<string, string> }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const q = useData<any>(`/market/listings?q=${encodeURIComponent(query)}&status=${status}`);
  return (
    <>
      <div className="panel-body row wrap" style={{ gap: 10, paddingBottom: 0 }}>
        <form className="input-icon" onSubmit={(e) => { e.preventDefault(); setQuery(text.trim()); }} style={{ flex: 1, minWidth: 220 }}>
          <Search aria-hidden="true" /><input className="input" placeholder="Item, code or seller" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setQuery(text.trim())} aria-label="Search items" />
        </form>
        <Seg value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'LIVE', label: 'Live' }, { value: 'SOLD_OUT', label: 'Sold out' }, { value: 'PAUSED', label: 'Paused' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'REMOVED', label: 'Removed' }]} />
      </div>
      {q.error ? <div className="panel-body"><ErrorBanner error={q.error} onRetry={q.reload} /></div>
        : !q.data ? <SkeletonRows rows={6} />
        : !q.data.rows.length ? <Empty icon={PackageSearch} title="No items found">{query ? 'Try another word.' : 'Items show here once sellers list them.'}</Empty>
        : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Item</th><th className="r">Price</th><th className="r">Stock</th><th className="r">Opened</th><th className="r">Sold</th><th>Status</th></tr></thead>
            <tbody>{q.data.rows.map((r: any) => (
              <tr key={r.id}>
                <td><div className="row" style={{ gap: 10 }}>
                  <img className="mk-thumb" src={photo(r.id)} alt="" loading="lazy" />
                  <div style={{ minWidth: 0 }}><a className="cell-main" href={r.url} target="_blank" rel="noreferrer">{r.title}<ExternalLink className="ext" /></a>
                    <div className="cell-sub"><Link to={`/people/${r.seller_id}`}>{r.seller_name}</Link> · {cats[r.category] ?? r.category} · {r.city ?? 'No area'} · {r.code}</div></div>
                </div></td>
                <td className="r money">{r.promo_minor ? <><s className="faint">{moneyShort(r.price_minor)}</s> {money(r.promo_minor)}</> : money(r.price_minor)}</td>
                <td className="r num">{r.stock}</td>
                <td className="r num">{n0(r.views)}</td>
                <td className="r num">{n0(r.orders)}</td>
                <td><Pill tone={STATUS[r.status]?.tone ?? 'grey'} plain>{STATUS[r.status]?.label ?? r.status}</Pill>{r.reports ? <span className="cell-sub" style={{ color: 'var(--red)' }}> · {r.reports} report{r.reports === 1 ? '' : 's'}</span> : null}{r.status_reason && <div className="cell-sub">{r.status_reason}</div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
/** Ad links: a WhatsApp link per item and ad, so you see which ad brought taps and orders. */
function Ads({ canManage }: { canManage: boolean }) {
  const q = useData<any>('/market/ads');
  const [make, setMake] = useState(false);
  const { copy } = useCopy();
  const total = useMemo(() => (q.data?.rows ?? []).reduce((t: { taps: number; orders: number }, r: any) => ({ taps: t.taps + r.taps, orders: t.orders + r.orders }), { taps: 0, orders: 0 }), [q.data]);
  return (
    <>
      <div className="panel-body row wrap" style={{ gap: 10, paddingBottom: 0 }}>
        <p className="small muted" style={{ margin: 0, flex: 1, minWidth: 240 }}>Use these as the button link in Facebook or Instagram ads. The buyer lands on the item in WhatsApp, and we count the taps and orders for each ad.{q.data?.rows.length ? <> In all: <b>{n0(total.taps)}</b> taps, <b>{n0(total.orders)}</b> orders.</> : null}</p>
        {canManage && <Button variant="primary" icon={Plus} onClick={() => setMake(true)}>New ad link</Button>}
      </div>
      {q.error ? <div className="panel-body"><ErrorBanner error={q.error} onRetry={q.reload} /></div>
        : !q.data ? <SkeletonRows rows={3} />
        : !q.data.rows.length ? <Empty icon={Link2} title="No ad links yet">Make one for the item you're advertising.</Empty>
        : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Ad</th><th>Item</th><th className="r">Taps</th><th className="r">Orders</th><th /></tr></thead>
            <tbody>{q.data.rows.map((r: any) => (
              <tr key={r.id}>
                <td className="cell-main">{r.name}<div className="cell-sub">made {ago(r.created_at)}</div></td>
                <td>{r.title}<div className="cell-sub">{r.code}</div></td>
                <td className="r num">{n0(r.taps)}</td>
                <td className="r num">{n0(r.orders)}{r.taps ? <span className="faint small"> · {pct(r.orders, r.taps)}%</span> : null}</td>
                <td className="r"><Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(r.url)}>Copy link</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      {make && <NewAd onClose={() => setMake(false)} onDone={q.reload} />}
    </>
  );
}

function NewAd({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  return (
    <Modal onClose={onClose} label="New ad link">
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { const r = await post<{ url: string }>('/market/ads', f); setMade(r.url); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="modal-head"><div className="mi gold"><TrendingUp /></div><div><h2>New ad link</h2><p>One link per item and ad, so each ad's results are counted on their own.</p></div></div>
        <div className="modal-body">
          {made ? (
            <div className="field"><label>Your link</label><div className="row" style={{ gap: 8 }}><input className="input" readOnly value={made} onFocus={(e) => e.target.select()} /><Button type="button" icon={Copy} onClick={() => copy(made)}>{copied ? 'Copied' : 'Copy'}</Button></div></div>
          ) : (<>
            <div className="field"><label htmlFor="ad-code">Item code</label><input id="ad-code" className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. nike-air-x7k2 (the end of its link)" required /></div>
            <div className="field"><label htmlFor="ad-name">Ad name</label><input id="ad-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. ig-nov" required /></div>
          </>)}
          {err && <ErrorBanner error={err} />}
        </div>
        <div className="modal-foot">
          <Button type="button" variant="ghost" onClick={onClose}>{made ? 'Done' : 'Cancel'}</Button>
          {!made && <Button type="submit" variant="primary" busy={busy} disabled={!f.code.trim() || !f.name.trim()}>Make link</Button>}
        </div>
      </form>
    </Modal>
  );
}
