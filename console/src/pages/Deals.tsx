import { Handshake, Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ago, dateTime, money } from '../format';
import { useData, useDebounced } from '../hooks';
import { Empty, ErrorBanner, Pager, Seg, SkeletonRows, StatusPill, Switch } from '../ui';
import { useEffect, useState } from 'react';

const GROUPS: Record<string, string[]> = {
  all: [],
  waiting: ['AWAITING_SELLER', 'AWAITING_BUYER', 'AWAITING_PAYMENT'],
  held: ['FUNDED', 'SHIPPED', 'RELEASING', 'PAYOUT_PENDING', 'REFUNDING'],
  problems: ['DISPUTED'],
  done: ['COMPLETED'],
  closed: ['REFUNDED', 'CANCELLED', 'EXPIRED'],
};

export function Deals() {
  const [sp, setSp] = useSearchParams();
  const group = (sp.get('group') ?? 'all') as keyof typeof GROUPS;
  const page = Number(sp.get('page') ?? 1);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 300);
  const hideTest = sp.get('test') === 'hide';
  const startedBy = sp.get('by') ?? '';
  const nav = useNavigate();
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  useEffect(() => { if ((sp.get('q') ?? '') !== dq) set('q', dq || null); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = new URLSearchParams();
  if (GROUPS[group]?.length) params.set('status', GROUPS[group]!.join(','));
  if (dq) params.set('q', dq);
  if (hideTest) params.set('test', 'hide');
  if (startedBy) params.set('started_by', startedBy);
  params.set('page', String(page));
  const { data, error, loading, reload } = useData<any>(`/deals?${params}`);
  const sc: Record<string, number> = data?.statusCounts ?? {};
  const count = (g: string) => (g === 'all' ? Object.values(sc).reduce((a, b) => a + b, 0) : GROUPS[g]!.reduce((a, s) => a + (sc[s] ?? 0), 0));

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Orders</h1><p className="lede">Every order, where its money is, and who is waiting on whom.</p></div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <div className="input-icon"><Search aria-hidden="true" /><input className="input" placeholder="Code, item, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" /></div>
          <Seg value={group} onChange={(v) => set('group', v === 'all' ? null : v)} options={[
            { value: 'all', label: 'All', n: count('all') }, { value: 'waiting', label: 'Waiting', n: count('waiting') }, { value: 'held', label: 'Money held', n: count('held') },
            { value: 'problems', label: 'Problems', n: count('problems') }, { value: 'done', label: 'Completed', n: count('done') }, { value: 'closed', label: 'Closed', n: count('closed') },
          ]} />
          <span className="spacer" />
          <select className="select" style={{ width: 160 }} value={startedBy} onChange={(e) => set('by', e.target.value || null)} aria-label="Who started the order">
            <option value="">Started by anyone</option><option value="seller">Started by seller</option><option value="buyer">Started by buyer</option>
          </select>
          <label className="check"><Switch on={hideTest} onChange={(v) => set('test', v ? 'hide' : null)} label="Hide test orders" />Hide test orders</label>
        </div>
        {error ? <div className="panel-body"><ErrorBanner error={error} onRetry={reload} /></div>
          : loading && !data ? <SkeletonRows rows={8} />
          : !data?.rows.length ? <Empty icon={Handshake} title={dq ? `No orders match “${dq}”` : 'No orders here yet'}>{dq ? 'Try an order code like HL-7K2QF, a phone number or a name.' : 'Orders appear the moment someone starts one on WhatsApp.'}</Empty>
          : (
            <>
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Order</th><th>Status</th><th>Buyer</th><th>Seller</th><th className="r">Buyer pays</th><th>Fee paid by</th><th className="r">Updated</th></tr></thead>
                  <tbody>
                    {data.rows.map((d: any) => (
                      <tr key={d.code} className="link" onClick={() => nav(`/deals/${d.code}`)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/deals/${d.code}`); }}>
                        <td>
                          <div className="cell-main">{d.code} {d.is_test && <span className="tag test">Test</span>}</div>
                          <div className="cell-sub" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.item}</div>
                        </td>
                        <td><StatusPill status={d.status} /></td>
                        <td>{d.buyer_name ? <><div>{d.buyer_name.split(' ')[0]}</div><div className="cell-sub">{d.buyer_phone}</div></> : <span className="faint">Not yet</span>}</td>
                        <td>{d.seller_name ? <><div>{d.seller_name.split(' ')[0]}</div><div className="cell-sub">{d.seller_phone}</div></> : <span className="faint">Not yet</span>}</td>
                        <td className="r money">{money(d.buyer_pays_minor, d.currency)}</td>
                        <td className="muted">{d.fee_payer === 'SELLER' ? 'Seller' : 'Buyer'}</td>
                        <td className="r muted nowrap" title={dateTime(d.updated_at)}>{ago(d.updated_at)}</td>
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
