import { Scale } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ago, dateTime, money } from '../format';
import { useData } from '../hooks';
import { Empty, ErrorBanner, Pill, Seg, SkeletonRows } from '../ui';

export function Disputes() {
  const [state, setState] = useState<'open' | 'resolved'>('open');
  const { data, error, loading, reload } = useData<any>(`/disputes?state=${state}`);
  const nav = useNavigate();
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Disputes</h1><p className="lede">When a buyer taps “Problem”, the money freezes and the case lands here. Oldest first: every hour counts for both sides.</p></div>
        <div className="actions"><Seg value={state} onChange={setState} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }]} /></div>
      </div>
      <section className="panel">
        {error ? <div className="panel-body"><ErrorBanner error={error} onRetry={reload} /></div>
          : loading ? <SkeletonRows rows={5} />
          : !data.rows.length ? <Empty icon={Scale} title={state === 'open' ? 'No open disputes' : 'No resolved disputes yet'}>{state === 'open' ? 'Good news. When a buyer reports a problem, it shows up here straight away.' : 'Decisions you make on disputes are kept here.'}</Empty>
          : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Deal</th><th>What the buyer said</th><th>People</th><th className="r">Frozen</th><th>{state === 'open' ? 'Open for' : 'Outcome'}</th></tr></thead>
                <tbody>
                  {data.rows.map((r: any) => (
                    <tr key={r.id} className="link" tabIndex={0} onClick={() => nav(`/deals/${r.code}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/deals/${r.code}`); }}>
                      <td><div className="cell-main">{r.code}</div><div className="cell-sub">{r.item}</div></td>
                      <td style={{ maxWidth: 360 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.reason ? `“${r.reason}”` : <span className="faint">No details yet</span>}</div>{r.photos > 0 && <div className="cell-sub">{r.photos} photo{r.photos > 1 ? 's' : ''} on file</div>}</td>
                      <td><div>{r.buyer_name?.split(' ')[0] ?? 'Buyer'} <span className="faint">bought from</span> {r.seller_name?.split(' ')[0] ?? 'Seller'}</div></td>
                      <td className="r money">{money(r.buyer_pays_minor, r.currency)}</td>
                      <td>{state === 'open'
                        ? <span title={dateTime(r.created_at)}><Pill tone={(Date.now() - +new Date(r.created_at)) / 3600000 > 48 ? 'red' : 'gold'} plain>{ago(r.created_at).replace(' ago', '')}</Pill></span>
                        : <><Pill tone={r.status === 'RESOLVED_REFUND' ? 'gold' : 'teal'} plain>{r.status === 'RESOLVED_REFUND' ? 'Buyer refunded' : 'Seller paid'}</Pill><div className="cell-sub">{dateTime(r.resolved_at)}</div></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  );
}
