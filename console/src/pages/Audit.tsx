import { ChevronDown, ChevronRight, ScrollText, Search } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTIONS, ago, dateTime } from '../format';
import { useData, useDebounced } from '../hooks';
import { Empty, ErrorBanner, Pager, SkeletonRows, Switch } from '../ui';

const GROUPS = [
  { value: '', label: 'Every action' }, { value: 'deal.', label: 'Deals' }, { value: 'payout.', label: 'Payouts' }, { value: 'settings.', label: 'Settings' },
  { value: 'user.', label: 'People' }, { value: 'support.', label: 'Support' }, { value: 'staff.', label: 'Team' }, { value: 'money.', label: 'Exports' }, { value: 'auth.', label: 'Sign-ins' },
];

export function Audit() {
  const [f, setF] = useState({ staff: '', action: '', q: '', from: '', to: '', hideSignIns: true });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const dq = useDebounced(f.q, 300);
  const p = new URLSearchParams({ page: String(page) });
  if (f.staff) p.set('staff', f.staff);
  if (f.action) p.set('action', f.action);
  if (dq) p.set('q', dq);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.hideSignIns && f.action !== 'auth.') p.set('hideSignIns', '1');
  const { data, error, loading, reload } = useData<any>(`/audit?${p}`);
  const set = (k: keyof typeof f, v: string | boolean) => { setF({ ...f, [k]: v }); setPage(1); };
  const target = (r: any) => r.target_type === 'deal' ? <Link to={`/deals/${r.target_id}`}>{r.target_id}</Link>
    : r.target_type === 'user' ? <Link to={`/people/${r.target_id}`}>Person</Link>
    : r.target_type === 'support' ? <Link to={`/support?open=${r.target_id}`}>Support #{r.target_id}</Link>
    : r.target_type === 'payout' ? <span className="mono">{r.target_id}</span>
    : r.target_type === 'settings' ? 'Settings' : r.target_type === 'staff' ? 'Team' : r.target_type ?? '—';
  return (
    <div className="page">
      <div className="page-head"><div><h1>Audit trail</h1><p className="lede">Every action anyone took in the console, with who, when and why. Entries can't be edited or deleted, by anyone.</p></div></div>
      <section className="panel">
        <div className="toolbar">
          <div className="input-icon"><Search aria-hidden="true" /><input className="input" placeholder="Search reasons, names, details" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search the audit trail" /></div>
          <select className="select" style={{ width: 170 }} value={f.staff} onChange={(e) => set('staff', e.target.value)} aria-label="Person">
            <option value="">Everyone</option>{data?.staff?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="select" style={{ width: 150 }} value={f.action} onChange={(e) => set('action', e.target.value)} aria-label="Kind of action">
            {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
          <input type="date" className="input" style={{ width: 150 }} value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="From date" />
          <input type="date" className="input" style={{ width: 150 }} value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="To date" />
          <label className="check"><Switch on={f.hideSignIns} onChange={(v) => set('hideSignIns', v)} label="Hide sign-ins" />Hide sign-ins</label>
        </div>
        {error ? <div className="panel-body"><ErrorBanner error={error} onRetry={reload} /></div> : loading && !data ? <SkeletonRows rows={10} /> : !data.rows.length ? <Empty icon={ScrollText} title="Nothing matches" /> : (
          <>
            <div className="table-wrap"><table className="t">
              <thead><tr><th style={{ width: 28 }}></th><th>When</th><th>Who</th><th>What</th><th>On</th><th>Why</th></tr></thead>
              <tbody>{data.rows.map((r: any) => (
                <Fragment key={r.id}>
                  <tr className="link" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <td className="faint">{open === r.id ? <ChevronDown style={{ width: 15 }} /> : <ChevronRight style={{ width: 15 }} />}</td>
                    <td className="nowrap" title={dateTime(r.at)}><div>{dateTime(r.at)}</div><div className="cell-sub">{ago(r.at)}</div></td>
                    <td><div className="cell-main">{r.actor}</div><div className="cell-sub">{r.role ? r.role.charAt(0) + r.role.slice(1).toLowerCase() : 'System'}</div></td>
                    <td>{ACTIONS[r.action] ?? r.action}{r.details?.ok === false && <span className="pill red plain" style={{ marginLeft: 6, height: 20 }}>Refused</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>{target(r)}</td>
                    <td style={{ maxWidth: 320 }}><div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.reason ?? <span className="faint">—</span>}</div></td>
                  </tr>
                  {open === r.id && (
                    <tr><td></td><td colSpan={5} style={{ background: '#FCFCFA' }}>
                      <dl className="kv" style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
                        <dt>Exact time</dt><dd>{new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)} UTC</dd>
                        <dt>Action code</dt><dd className="mono">{r.action}</dd>
                        {r.reason && <><dt>Reason</dt><dd>{r.reason}</dd></>}
                        {r.ip && <><dt>From IP</dt><dd className="mono">{r.ip}</dd></>}
                        <dt>Details</dt><dd><pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.details, null, 2)}</pre></dd>
                      </dl>
                    </td></tr>
                  )}
                </Fragment>
              ))}</tbody>
            </table></div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </section>
    </div>
  );
}
