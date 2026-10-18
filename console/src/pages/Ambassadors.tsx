import { ArrowUpRight, Check, ChevronLeft, ChevronRight, CirclePause, Copy, ExternalLink, Hand, ImageOff, Link2, Megaphone, Pencil, Percent, Play, Plus, Settings2, ShieldAlert, UserPlus, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { ACTIONS, ago, dateOnly, dateTime, money, phone } from '../format';
import { useData } from '../hooks';
import { Avatar, Button, ConfirmAction, Empty, ErrorBanner, Modal, Pill, Seg, Skeleton, SkeletonRows, useCopy, useToast } from '../ui';

/**
 * Ambassadors (main menu): applications to review, the ambassadors, earnings held for a look, and monthly payouts.
 * One ambassador's page: their month (every naira), their people, their share and term, and the controls.
 * Settings live in Settings → Features → Ambassadors.
 */
type Labels = { knows: Record<string, string>; channels: Record<string, string>; reach: Record<string, string> };
type Tab = 'applications' | 'ambassadors' | 'held' | 'payouts';
const STATUS_TONE: Record<string, 'green' | 'gold' | 'grey' | 'teal'> = { ACTIVE: 'green', PAUSED: 'gold', ENDED: 'grey', SETUP: 'teal' };
const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', PAUSED: 'Paused', ENDED: 'Ended', SETUP: 'Setting up' };
const monthLabel = (k: string) => new Date(`${k}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function AmbassadorsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'applications';
  const q = useData<any>('/ambassadors');
  const [invite, setInvite] = useState(false);
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  if (q.error) return <div className="page"><ErrorBanner error={q.error} onRetry={q.reload} /></div>;
  if (!q.data) return <div className="page"><Skeleton h={30} w={260} /><div className="kpis" style={{ marginTop: 20 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={86} />)}</div><Skeleton h={320} style={{ marginTop: 16 }} /></div>;
  const d = q.data;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Ambassadors</h1><p className="lede">People you approve bring new sellers and buyers, and earn {d.cfg.sellerPct}% / {d.cfg.buyerPct}% of what Hoolam makes on their orders{d.cfg.bonusMinor ? `, plus ${money(d.cfg.bonusMinor)} per new seller after ${d.cfg.bonusOrders} orders` : ''}.</p></div>
        <div className="actions">
          <Link className="btn" to="/settings/features"><Settings2 />Settings</Link>
          {d.canReview && <Button icon={UserPlus} variant="primary" onClick={() => setInvite(true)}>Invite someone</Button>}
        </div>
      </div>
      {!d.on && <div className="banner gold" style={{ marginBottom: 16 }}><Megaphone /><div><b>The programme is off.</b> Nobody sees it in WhatsApp or on the website. You can still review applications and invite people. Turn it on in <Link to="/settings/features">Settings → Features</Link>.</div></div>}
      <div className="kpis amb-kpis">
        <div className="kpi"><div className="k">Active ambassadors</div><div className="v">{d.stats.active}</div></div>
        <div className="kpi"><div className="k">People they brought</div><div className="v">{d.stats.people}</div></div>
        <div className="kpi"><div className="k">Earned this month</div><div className="v money">{money(d.stats.monthMinor)}</div></div>
        <div className="kpi"><div className="k">Payouts to send</div><div className="v money">{money(d.stats.dueMinor)}</div></div>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="toolbar">
          <Seg value={tab} onChange={setTab} options={[
            { value: 'applications', label: 'Applications', n: d.stats.pending || undefined },
            { value: 'ambassadors', label: 'Ambassadors', n: d.ambassadors.length || undefined },
            { value: 'held', label: 'On hold', n: d.stats.held || undefined },
            { value: 'payouts', label: 'Payouts', n: d.payouts.length || undefined },
          ]} />
        </div>
        {tab === 'applications' && <Applications canReview={d.canReview} labels={d.labels} onChange={q.reload} />}
        {tab === 'ambassadors' && <List rows={d.ambassadors} />}
        {tab === 'held' && <Held rows={d.held} canManage={d.canManage} onChange={q.reload} />}
        {tab === 'payouts' && <Payouts canManage={d.canManage} onChange={q.reload} />}
      </section>
      {invite && <Invite onClose={() => setInvite(false)} onDone={q.reload} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function Applications({ canReview, labels, onChange }: { canReview: boolean; labels: Labels; onChange: () => void }) {
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'DECLINED'>('PENDING');
  const q = useData<any>(`/ambassadors/applications?status=${status}`);
  const toast = useToast();
  const [decline, setDecline] = useState<any>(null);
  const [approving, setApproving] = useState<number | null>(null);
  const approve = async (a: any) => {
    setApproving(a.id);
    try {
      await post(`/ambassadors/applications/${a.id}/approve`, {});
      toast({ kind: 'ok', title: `${a.name.split(' ')[0]} approved`, body: 'They got a WhatsApp message to finish setting up.' });
      q.reload(); onChange();
    } catch (e) { toast({ kind: 'error', title: 'Not approved', body: (e as Error).message }); } finally { setApproving(null); }
  };
  return (
    <>
      <div className="panel-body" style={{ paddingBottom: 0 }}>
        <Seg value={status} onChange={setStatus} options={[{ value: 'PENDING', label: 'Waiting' }, { value: 'APPROVED', label: 'Approved' }, { value: 'DECLINED', label: 'Declined' }]} />
      </div>
      {q.error ? <div className="panel-body"><ErrorBanner error={q.error} onRetry={q.reload} /></div>
        : !q.data ? <SkeletonRows rows={4} />
        : !q.data.rows.length ? <Empty icon={Megaphone} title={status === 'PENDING' ? 'No applications waiting' : 'Nothing here yet'}>{status === 'PENDING' ? 'New applications from the website and WhatsApp show here. We promise a reply within 24 hours.' : null}</Empty>
        : (
          <ul className="amb-apps">
            {q.data.rows.map((a: any) => (
              <li key={a.id} className="amb-app">
                <div className="amb-app-top">
                  <Avatar name={a.name} gold={a.completedOrders > 0} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cell-main">{a.name}{a.userId && <Link to={`/people/${a.userId}`} className="amb-link" title="Their Hoolam record"><ArrowUpRight /></Link>}</div>
                    <div className="cell-sub">{phone(a.phone)}{a.email ? ` · ${a.email}` : ''} · {[a.community, a.city, a.state].filter(Boolean).join(', ')}</div>
                  </div>
                  <span className="cell-sub nowrap" title={dateTime(a.createdAt)}>{a.source === 'whatsapp' ? 'WhatsApp' : a.source === 'invite' ? 'Invited' : 'Website'} · {ago(a.createdAt)}</span>
                </div>
                <dl className="amb-facts">
                  <div><dt>Knows well</dt><dd>{a.knows.map((k: string) => <span key={k} className={`tag${k === 'vendors' ? ' gold' : ''}`}>{labels.knows[k] ?? k}</span>)}</dd></div>
                  <div><dt>Will share on</dt><dd>{a.channels.map((k: string) => <span key={k} className="tag">{labels.channels[k] ?? k}</span>)}</dd></div>
                  <div><dt>Reach</dt><dd>{labels.reach[a.reach] ?? a.reach ?? '—'}{a.handle ? <span className="muted"> · {a.handle}</span> : null}</dd></div>
                  <div><dt>Sells online</dt><dd>{a.sellsOnline == null ? '—' : a.sellsOnline ? 'Yes' : 'No'}</dd></div>
                  <div><dt>On Hoolam</dt><dd>{a.completedOrders ? `${a.completedOrders} completed order${a.completedOrders === 1 ? '' : 's'}` : <span className="muted">No orders yet</span>}</dd></div>
                </dl>
                {a.why && <p className="amb-why">“{a.why}”</p>}
                {a.status !== 'PENDING' && <p className="cell-sub">{a.status === 'APPROVED' ? 'Approved' : 'Declined'} by {a.decidedBy ?? 'the team'} {ago(a.decidedAt)}{a.note ? ` · ${a.note}` : ''}</p>}
                {a.status === 'PENDING' && canReview && (
                  <div className="row" style={{ gap: 8, marginTop: 10 }}>
                    <Button variant="primary" icon={Check} busy={approving === a.id} onClick={() => approve(a)}>Approve</Button>
                    <Button variant="ghost" icon={X} onClick={() => setDecline(a)}>Decline</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {decline && <ConfirmAction icon={X} tone="danger" title={`Decline ${decline.name.split(' ')[0]}?`} confirmLabel="Decline"
        description="They get a kind WhatsApp message saying we can't take their application right now. Your reason stays with the team."
        reasonPlaceholder="e.g. We don't cover their area yet"
        onClose={() => setDecline(null)}
        onConfirm={async (reason) => { await post(`/ambassadors/applications/${decline.id}/decline`, { reason }); toast({ kind: 'ok', title: 'Declined' }); q.reload(); onChange(); }} />}
    </>
  );
}

function Invite({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', city: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  return (
    <Modal onClose={onClose} label="Invite an ambassador">
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { const r = await post<{ userId: string }>('/ambassadors/invite', f); toast({ kind: 'ok', title: `${f.name.split(' ')[0]} invited`, body: 'They got a WhatsApp message to set up.' }); onDone(); onClose(); nav(`/ambassadors/${r.userId}`); }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="modal-head"><div className="mi"><UserPlus /></div><div><h2>Invite someone</h2><p>They skip the application. Hoolam messages them on WhatsApp to check their ID, add a payout account, and choose a term and a link name.</p></div></div>
        <div className="modal-body">
          <div className="field"><label htmlFor="iv-name">Name</label><input id="iv-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Tobi Adeyemi" required /></div>
          <div className="field"><label htmlFor="iv-phone">WhatsApp number</label><input id="iv-phone" className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="08031234567" required /></div>
          <div className="field"><label htmlFor="iv-city">Campus, market or city <span className="faint">(optional)</span></label><input id="iv-city" className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder="UNILAG" /><p className="small muted" style={{ marginTop: 6 }}>Shown on their link, like “Tobi · UNILAG”.</p></div>
          {err && <ErrorBanner error={err} />}
          <p className="small muted">If they haven't messaged Hoolam in the last 24 hours, the invite goes as a pre-approved WhatsApp message once Meta has approved it.</p>
        </div>
        <div className="modal-foot"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon={Plus} busy={busy} disabled={f.name.trim().length < 2 || f.phone.replace(/\D/g, '').length < 10}>Invite</Button></div>
      </form>
    </Modal>
  );
}

function List({ rows }: { rows: any[] }) {
  const nav = useNavigate();
  if (!rows.length) return <Empty icon={Megaphone} title="No ambassadors yet">Approve an application, or invite someone.</Empty>;
  return (
    <div className="table-wrap"><table className="t">
      <thead><tr><th>Ambassador</th><th>Status</th><th>Term</th><th className="r">Sellers</th><th className="r">Buyers</th><th className="r">This month</th><th className="r">All time</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.userId} className="link" tabIndex={0} onClick={() => nav(`/ambassadors/${r.userId}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/ambassadors/${r.userId}`); }}>
          <td><div className="row"><Avatar name={r.name} gold={r.status === 'ACTIVE'} /><div><div className="cell-main">{r.name ?? phone(r.phone)}{r.customPct && <span className="tag gold" style={{ marginLeft: 6 }}>Custom share</span>}{r.held > 0 && <span className="tag" style={{ marginLeft: 6 }}>{r.held} on hold</span>}</div><div className="cell-sub">{r.slug ? `hoolam.com/a/${r.slug}` : 'No link yet'}{r.area ? ` · ${r.area}` : ''}</div></div></div></td>
          <td><Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill></td>
          <td className="muted">{r.term ? `${r.term} months` : '—'}{r.termEnds && r.status !== 'ENDED' ? <div className="cell-sub">renews {dateOnly(r.termEnds)}</div> : null}</td>
          <td className="r num">{r.sellers}</td><td className="r num">{r.buyers}</td>
          <td className="r money">{money(r.monthMinor)}</td><td className="r money">{money(r.totalMinor)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Held({ rows, canManage, onChange }: { rows: any[]; canManage: boolean; onChange: () => void }) {
  const [open, setOpen] = useState<{ row: any; approve: boolean } | null>(null);
  const toast = useToast();
  if (!rows.length) return <Empty icon={ShieldAlert} title="Nothing on hold">Earnings that look wrong (an ambassador's own order, the same ID or bank account) wait here for a decision.</Empty>;
  return (
    <>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Ambassador</th><th>Order</th><th>Why it's on hold</th><th className="r">Amount</th>{canManage && <th />}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><Link className="cell-main" to={`/ambassadors/${r.userId}`}>{r.ambassador}</Link><div className="cell-sub">{r.kind === 'BONUS' ? 'Seller bonus' : 'Share'} · {r.side === 'SELLER' ? 'seller' : 'buyer'} {r.person}</div></td>
            <td><Link to={`/deals/${r.code}`} className="mono">{r.code}</Link><div className="cell-sub">{ago(r.at)}</div></td>
            <td>{r.reason}</td>
            <td className="r money">{money(r.amountMinor)}</td>
            {canManage && <td className="r nowrap"><Button size="sm" icon={Check} onClick={() => setOpen({ row: r, approve: true })}>Approve</Button> <Button size="sm" variant="ghost" icon={X} onClick={() => setOpen({ row: r, approve: false })}>Cancel</Button></td>}
          </tr>
        ))}</tbody>
      </table></div>
      {open && <ConfirmAction icon={open.approve ? Check : X} tone={open.approve ? 'teal' : 'danger'} title={open.approve ? `Count ${money(open.row.amountMinor)} for ${open.row.ambassador}?` : `Cancel ${money(open.row.amountMinor)}?`}
        confirmLabel={open.approve ? 'Approve' : 'Cancel earning'}
        description={open.approve ? 'It counts in their earnings and goes in the next payout.' : 'It won\'t count or be paid. They see it as cancelled after review.'}
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => { await post(`/ambassadors/earnings/${open.row.id}/${open.approve ? 'approve' : 'void'}`, { reason }); toast({ kind: 'ok', title: open.approve ? 'Approved' : 'Cancelled' }); onChange(); }} />}
    </>
  );
}

function Payouts({ canManage, onChange }: { canManage: boolean; onChange: () => void }) {
  const [status, setStatus] = useState<'DUE' | 'PAID'>('DUE');
  const q = useData<any>(`/ambassadors/payouts?status=${status}`);
  const [pay, setPay] = useState<any>(null);
  return (
    <>
      <div className="panel-body" style={{ paddingBottom: 0 }}>
        <Seg value={status} onChange={setStatus} options={[{ value: 'DUE', label: 'To send' }, { value: 'PAID', label: 'Paid' }]} />
        {status === 'DUE' && <p className="small muted" style={{ marginTop: 10 }}>Made on the payout day for the month before (from the minimum), and straight away when someone ends. For now, transfer from Hoolam's bank and mark each as paid. Once Monnify is live, they'll go out by themselves.</p>}
      </div>
      {q.error ? <div className="panel-body"><ErrorBanner error={q.error} onRetry={q.reload} /></div>
        : !q.data ? <SkeletonRows rows={3} />
        : !q.data.rows.length ? <Empty icon={Wallet} title={status === 'DUE' ? 'Nothing to send' : 'No payouts yet'} />
        : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Ambassador</th><th>For</th><th>Pay to</th><th className="r">Amount</th><th /></tr></thead>
            <tbody>{q.data.rows.map((p: any) => (
              <tr key={p.id}>
                <td><Link className="cell-main" to={`/ambassadors/${p.userId}`}>{p.name}</Link><div className="cell-sub">{phone(p.phone)}</div></td>
                <td>{monthLabel(p.month)}{p.final && <span className="tag" style={{ marginLeft: 6 }}>Final</span>}</td>
                <td>{p.bank ? <BankCell bank={p.bank} /> : <span className="muted">No account yet</span>}</td>
                <td className="r money">{money(p.amountMinor)}</td>
                <td className="r nowrap">{p.status === 'PAID'
                  ? <span className="cell-sub">Paid {dateOnly(p.paidAt)}{p.reference ? ` · ${p.reference}` : ''}{p.paidBy ? ` · ${p.paidBy}` : ''}</span>
                  : canManage && <Button size="sm" variant="primary" icon={Check} onClick={() => setPay(p)} disabled={!p.bank}>Mark as paid</Button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      {pay && <MarkPaid p={pay} onClose={() => setPay(null)} onDone={() => { q.reload(); onChange(); }} />}
    </>
  );
}

function BankCell({ bank }: { bank: { name: string; number: string; accountName: string } }) {
  const { copied, copy } = useCopy();
  return (
    <div>
      <div className="row" style={{ gap: 6 }}><span className="mono">{bank.number}</span><button type="button" className="icon-btn sm" aria-label="Copy account number" onClick={() => copy(bank.number)}>{copied ? <Check /> : <Copy />}</button></div>
      <div className="cell-sub">{bank.name} · {bank.accountName}</div>
    </div>
  );
}

function MarkPaid({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Modal onClose={onClose} label="Mark as paid">
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await post(`/ambassadors/payouts/${p.id}/paid`, { reference: ref }); toast({ kind: 'ok', title: 'Marked as paid', body: `${p.name.split(' ')[0]} got a WhatsApp message with the reference.` }); onDone(); onClose(); }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="modal-head"><div className="mi gold"><Wallet /></div><div><h2>Mark {money(p.amountMinor)} as paid?</h2><p>Only after the transfer has gone. {p.name.split(' ')[0]} is told on WhatsApp, with the reference.</p></div></div>
        <div className="modal-body">
          {p.bank && <div className="diff"><div><span>Account</span><b>{p.bank.accountName}</b></div><div><span>Bank</span><b>{p.bank.name} · {p.bank.number}</b></div><div><span>For</span><b>{monthLabel(p.month)}{p.final ? ' (final)' : ''}</b></div></div>}
          <div className="field"><label htmlFor="ref">Transfer reference</label><input id="ref" className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="From your bank's receipt" required /></div>
          {err && <ErrorBanner error={err} />}
        </div>
        <div className="modal-foot"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon={Check} busy={busy} disabled={ref.trim().length < 3}>Mark as paid</Button></div>
      </form>
    </Modal>
  );
}

// =============================================================================================
// One ambassador
// =============================================================================================
export function AmbassadorPage() {
  const { id = '' } = useParams();
  const [month, setMonth] = useState('');
  const q = useData<any>(`/ambassadors/${id}${month ? `?m=${month}` : ''}`);
  const toast = useToast();
  const [open, setOpen] = useState<null | 'pause' | 'resume' | 'end' | 'share' | 'name' | 'photo'>(null);
  const [share, setShare] = useState({ seller: '', buyer: '' });
  const [name, setName] = useState('');
  const [tab, setTab] = useState<'sellers' | 'buyers'>('sellers');
  const { copied, copy } = useCopy();
  if (q.error) return <div className="page"><ErrorBanner error={q.error} onRetry={q.reload} /></div>;
  if (!q.data) return <div className="page"><Skeleton h={30} w={300} /><div className="grid side" style={{ marginTop: 20 }}><Skeleton h={360} /><Skeleton h={300} /></div></div>;
  const d = q.data;
  const idx = d.months.indexOf(d.month);
  const s = d.summary;
  const people = tab === 'sellers' ? d.people.sellers : d.people.buyers;
  const max = Math.max(1, ...d.chart.map((c: any) => c.amountMinor));
  const app = d.application;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/ambassadors">Ambassadors</Link><ChevronRight aria-hidden="true" /><span>{d.name}</span></nav>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          {d.photo ? <a className="person-photo" href={`/console/api/ambassadors/${id}/photo`} target="_blank" rel="noreferrer"><img src={`/console/api/ambassadors/${id}/photo?v=${d.photoVersion}`} alt={d.name} /></a> : <Avatar name={d.name} gold />}
          <div>
            <h1>{d.name}</h1>
            <p className="lede"><Pill tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Pill> {phone(d.phone)}{d.area ? ` · ${d.area}` : ''}{d.activatedAt ? ` · since ${dateOnly(d.activatedAt)}` : ''} · <Link to={`/people/${d.userId}`}>Hoolam record</Link></p>
          </div>
        </div>
        <div className="actions">
          {d.link && <a className="btn" href={d.link} target="_blank" rel="noreferrer"><ExternalLink />Their link</a>}
          {d.canManage && d.status === 'ACTIVE' && <Button icon={CirclePause} onClick={() => setOpen('pause')}>Pause</Button>}
          {d.canManage && d.status === 'PAUSED' && <Button icon={Play} variant="primary" onClick={() => setOpen('resume')}>Resume</Button>}
          {d.canManage && d.status !== 'ENDED' && <Button icon={Hand} variant="danger" onClick={() => setOpen('end')}>End</Button>}
        </div>
      </div>
      {d.status === 'PAUSED' && <div className="banner gold" style={{ marginBottom: 16 }}><CirclePause /><div><b>Paused.</b> New orders from their people don't earn. Reason: {d.endReason ?? '—'}</div></div>}
      {d.status === 'ENDED' && <div className="banner" style={{ marginBottom: 16 }}><Hand /><div><b>Ended {dateOnly(d.endedAt)}.</b> {d.endReason ?? ''} Anything they were owed went into a final payout.</div></div>}
      {d.status === 'SETUP' && <div className="banner teal" style={{ marginBottom: 16 }}><Megaphone /><div><b>Setting up.</b> Approved; they're finishing in WhatsApp (ID check, payout account, term, link name).</div></div>}

      <div className="grid side">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Earnings</h2>
              <div className="right amb-month">
                <button className="icon-btn sm" aria-label="Earlier month" disabled={!d.months[idx + 1]} onClick={() => setMonth(d.months[idx + 1])}><ChevronLeft /></button>
                <select className="select" value={d.month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">{d.months.map((k: string) => <option key={k} value={k}>{monthLabel(k)}</option>)}</select>
                <button className="icon-btn sm" aria-label="Later month" disabled={idx <= 0} onClick={() => setMonth(d.months[idx - 1])}><ChevronRight /></button>
              </div>
            </div>
            <div className="panel-body amb-sum">
              <div><span>Earned</span><b className="money">{money(s.earned)}</b></div>
              <div><span>From sellers</span><b className="money">{money(s.fromSellers)}</b></div>
              <div><span>From buyers</span><b className="money">{money(s.fromBuyers)}</b></div>
              <div><span>Bonuses</span><b className="money">{money(s.bonuses)}</b></div>
              {s.held > 0 && <div><span>On hold</span><b className="money">{money(s.held)}</b></div>}
            </div>
            <div className="amb-chart" role="group" aria-label="Last 12 months">
              {d.chart.map((c: any) => {
                const ok = d.months.includes(c.month);
                return <button key={c.month} className={c.month === d.month ? 'on' : ''} disabled={!ok} onClick={() => ok && setMonth(c.month)} title={`${monthLabel(c.month)}: ${money(c.amountMinor)}`}><i style={{ height: `${Math.max(3, Math.round((100 * c.amountMinor) / max))}%` }} /><span>{monthLabel(c.month).slice(0, 3)}</span></button>;
              })}
            </div>
            {!d.lines.length ? <Empty icon={Wallet} title={`No earnings in ${d.monthLabel}`} /> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>When</th><th>From</th><th>Order</th><th>How</th><th className="r">Amount</th></tr></thead>
                <tbody>{d.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td className="muted nowrap">{dateOnly(l.at)}</td>
                    <td>{l.who}<div className="cell-sub">{l.side === 'SELLER' ? 'Seller' : 'Buyer'}</div></td>
                    <td><Link to={`/deals/${l.code}`} className="mono">{l.code}</Link></td>
                    <td>{l.kind === 'BONUS' ? `${d.bonus.orders}-order seller bonus` : `${l.percent}% of ${money(l.revenueMinor)}`}{l.status === 'HELD' && <div className="cell-sub">On hold: {l.holdReason}</div>}{l.status === 'VOID' && <div className="cell-sub">Cancelled after review</div>}</td>
                    <td className="r money">{money(l.amountMinor)}{l.paid ? <div className="cell-sub">Paid</div> : null}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Their people</h2><span className="right small muted">{d.taps} link tap{d.taps === 1 ? '' : 's'}</span></div>
            <div className="panel-body" style={{ paddingBottom: 0 }}><Seg value={tab} onChange={setTab} options={[{ value: 'sellers', label: 'Sellers', n: d.people.sellers.length }, { value: 'buyers', label: 'Buyers', n: d.people.buyers.length }]} /></div>
            {!people.length ? <Empty icon={Megaphone} title={`No ${tab} yet`} /> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>{tab === 'sellers' ? 'Seller' : 'Buyer'}</th><th className="r">Orders</th><th>Active</th>{tab === 'sellers' && <th>Bonus</th>}<th>Joined</th></tr></thead>
                <tbody>{people.map((p: any) => (
                  <tr key={p.id}>
                    <td><Link to={`/people/${p.id}`} className="cell-main">{p.name}</Link></td>
                    <td className="r num">{p.orders}</td>
                    <td>{p.active ? <Pill tone="green" plain>Active</Pill> : <span className="muted">Not lately</span>}</td>
                    {tab === 'sellers' && <td>{p.bonus ? <Pill tone="gold" plain>Earned</Pill> : <span className="muted">{p.toBonus} to go</span>}</td>}
                    <td className="muted">{dateOnly(p.joinedAt)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Link, share and term</h2></div>
            <div className="panel-body stack" style={{ gap: 14 }}>
              <div className="kv-row"><span>Link</span>{d.link ? <span className="row" style={{ gap: 6 }}><b className="mono">{d.linkText}</b><button className="icon-btn sm" aria-label="Copy link" onClick={() => copy(d.link)}>{copied ? <Check /> : <Copy />}</button></span> : <span className="muted">Not chosen yet</span>}
                {d.canManage && d.slug && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => { setName(d.slug); setOpen('name'); }}>Change</Button>}</div>
              <div className="kv-row"><span>Share</span><b>{d.pct.seller}% sellers · {d.pct.buyer}% buyers</b>{(d.pct.customSeller != null || d.pct.customBuyer != null) && <span className="tag gold">Custom</span>}
                {d.canManage && <Button size="sm" variant="ghost" icon={Percent} onClick={() => { setShare({ seller: d.pct.customSeller != null ? String(d.pct.customSeller) : '', buyer: d.pct.customBuyer != null ? String(d.pct.customBuyer) : '' }); setOpen('share'); }}>Set</Button>}</div>
              <div className="kv-row"><span>Term</span><b>{d.term ? `${d.term} months` : '—'}</b>{d.termEnds && d.status !== 'ENDED' && <span className="muted small">renews {dateOnly(d.termEnds)}{d.nextTerm ? `, then ${d.nextTerm} months` : ''}</span>}</div>
              <div className="kv-row"><span>Payout account</span>{d.bank ? <b>{d.bank.name} ••••{d.bank.last4}</b> : <span className="muted">Not added</span>}</div>
              <div className="kv-row"><span>Photo</span>{d.photo ? <><b>Added</b>{d.canReview && <Button size="sm" variant="ghost" icon={ImageOff} onClick={() => setOpen('photo')}>Remove</Button>}</> : <span className="muted">None</span>}</div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Money</h2></div>
            <div className="panel-body amb-sum two">
              <div><span>Paid so far</span><b className="money">{money(d.totals.paidMinor)}</b></div>
              <div><span>Owed</span><b className="money">{money(d.totals.owedMinor)}</b></div>
              <div><span>All time</span><b className="money">{money(d.totals.allTimeMinor)}</b></div>
              <div><span>On the way</span><b className="money">{money(d.totals.pendingMinor)}</b></div>
            </div>
            {d.payouts.length > 0 && <ul className="amb-payouts">{d.payouts.map((p: any) => <li key={p.id}><span>{monthLabel(p.month)}{p.final ? ' (final)' : ''}</span><b className="money">{money(p.amountMinor)}</b><Pill tone={p.status === 'PAID' ? 'green' : 'teal'} plain>{p.status === 'PAID' ? 'Paid' : 'Due'}</Pill></li>)}</ul>}
          </section>
          {app && (
            <section className="panel">
              <div className="panel-head"><h2>Their application</h2><span className="right small muted">{app.source === 'invite' ? 'Invited' : app.source === 'whatsapp' ? 'WhatsApp' : 'Website'} · {dateOnly(app.createdAt)}</span></div>
              <dl className="panel-body amb-facts">
                <div><dt>Where</dt><dd>{[app.community, app.city, app.state].filter(Boolean).join(', ') || '—'}</dd></div>
                {app.knows?.length > 0 && <div><dt>Knows well</dt><dd>{app.knows.map((k: string) => <span key={k} className="tag">{d.labels.knows[k] ?? k}</span>)}</dd></div>}
                {app.channels?.length > 0 && <div><dt>Shares on</dt><dd>{app.channels.map((k: string) => <span key={k} className="tag">{d.labels.channels[k] ?? k}</span>)}</dd></div>}
                {app.reach && <div><dt>Reach</dt><dd>{d.labels.reach[app.reach] ?? app.reach}{app.handle ? ` · ${app.handle}` : ''}</dd></div>}
                {app.why && <div><dt>Why</dt><dd>“{app.why}”</dd></div>}
              </dl>
            </section>
          )}
          {d.trail.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>History</h2></div>
              <ul className="amb-trail panel-body">{d.trail.map((t: any, i: number) => <li key={i}><b>{ACTIONS[t.action] ?? t.action.replace(/^ambassador\./, '').replace(/\./g, ' ')}</b><span className="cell-sub">{t.actor} · {ago(t.at)}{t.reason ? ` · ${t.reason}` : ''}</span></li>)}</ul>
            </section>
          )}
        </div>
      </div>

      {open === 'pause' && <ConfirmAction icon={CirclePause} tone="gold" title={`Pause ${d.firstName}?`} confirmLabel="Pause" description="New orders from their people stop earning until you resume. What they earned is still paid. They get a WhatsApp message with your reason." onClose={() => setOpen(null)} onConfirm={async (reason) => { await post(`/ambassadors/${id}/pause`, { reason }); toast({ kind: 'ok', title: 'Paused' }); q.reload(); }} />}
      {open === 'resume' && <ConfirmAction icon={Play} title={`Resume ${d.firstName}?`} confirmLabel="Resume" needReason={false} description="Orders from their people earn again from now." onClose={() => setOpen(null)} onConfirm={async () => { await post(`/ambassadors/${id}/resume`, {}); toast({ kind: 'ok', title: 'Active again' }); q.reload(); }} />}
      {open === 'end' && <ConfirmAction icon={Hand} tone="danger" title={`End ${d.firstName}'s term?`} confirmLabel="End now" description="They stop earning now. Everything they're owed goes into a final payout, whatever the amount. Their link stops naming them. Their people stay on Hoolam." onClose={() => setOpen(null)} onConfirm={async (reason) => { await post(`/ambassadors/${id}/end`, { reason }); toast({ kind: 'ok', title: 'Ended', body: 'A final payout is waiting in Payouts.' }); q.reload(); }} />}
      {open === 'photo' && <ConfirmAction icon={ImageOff} tone="danger" title="Remove their photo?" confirmLabel="Remove photo" description="Their link shows their initial instead, and they get a WhatsApp message asking for a clear photo of their face." onClose={() => setOpen(null)} onConfirm={async (reason) => { await api(`/ambassadors/${id}/photo`, { method: 'DELETE', body: { reason } }); toast({ kind: 'ok', title: 'Photo removed' }); q.reload(); }} />}
      {open === 'share' && <ConfirmAction icon={Percent} tone="gold" title={`${d.firstName}'s share`} confirmLabel="Save share"
        description={`Leave a box empty to use the default from Settings → Features (${d.defaults.seller}% on sellers, ${d.defaults.buyer}% on buyers). It applies to orders completed from now on.`}
        extra={<div className="grid two"><div className="field"><label htmlFor="sp">On sellers (%)</label><input id="sp" className="input num" type="number" min={0} max={50} step={0.5} value={share.seller} onChange={(e) => setShare({ ...share, seller: e.target.value })} placeholder="Default" /></div>
          <div className="field"><label htmlFor="bp">On buyers (%)</label><input id="bp" className="input num" type="number" min={0} max={50} step={0.5} value={share.buyer} onChange={(e) => setShare({ ...share, buyer: e.target.value })} placeholder="Default" /></div></div>}
        reasonPlaceholder="e.g. 25 active sellers in two months"
        onClose={() => setOpen(null)} onConfirm={async (reason) => { await post(`/ambassadors/${id}/share`, { seller: share.seller, buyer: share.buyer, reason }); toast({ kind: 'ok', title: 'Share saved' }); q.reload(); }} />}
      {open === 'name' && <ConfirmAction icon={Link2} tone="gold" title="Change their link name?" confirmLabel="Change name"
        description="The old name stays theirs and keeps working: it moves people to the new one. Nobody else can ever take either."
        extra={<div className="field"><label htmlFor="nm">New name</label><div className="link-prefix"><span>hoolam.com/a/</span><input id="nm" className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></div></div>}
        onClose={() => setOpen(null)} onConfirm={async (reason) => { await post(`/ambassadors/${id}/name`, { name, reason }); toast({ kind: 'ok', title: 'Link name changed', body: 'The website updates in about 2 minutes.' }); q.reload(); }} />}
    </div>
  );
}

