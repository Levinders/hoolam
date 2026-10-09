import { ArrowDownRight, ArrowUpRight, ChartColumn, Minus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hours, money, moneyShort, pct } from '../format';
import { useData } from '../hooks';
import { AreaChart, BarChart, Empty, ErrorBanner, Seg, Skeleton, Switch } from '../ui';

export function Insights() {
  const [days, setDays] = useState('30');
  const [test, setTest] = useState(true);
  const { data, error, loading, reload } = useData<any>(`/insights?days=${days}&includeTest=${test ? 1 : 0}`);
  const cur = data?.currency ?? 'NGN';

  const delta = (now: number, prev: number) => {
    if (!prev && !now) return <span className="d flat"><Minus />No change</span>;
    if (!prev) return <span className="d up"><ArrowUpRight />New this period</span>;
    const p = Math.round(((now - prev) / prev) * 100);
    return p === 0 ? <span className="d flat"><Minus />Same as before</span>
      : <span className={`d ${p > 0 ? 'up' : 'down'}`}>{p > 0 ? <ArrowUpRight /> : <ArrowDownRight />}{Math.abs(p)}% vs previous {days} days</span>;
  };
  const kpi = (label: string, value: string, now: number, prev: number) => (
    <div className="kpi"><div className="k">{label}</div><div className="v">{value}</div>{delta(now, prev)}</div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Insights</h1><p className="lede">How Hoolam is doing: money moving through, where orders stall, and who your best sellers are.</p></div>
        <div className="actions">
          <label className="check"><Switch on={test} onChange={setTest} label="Include test orders" />Include test orders</label>
          <Seg value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        </div>
      </div>
      {error ? <ErrorBanner error={error} onRetry={reload} /> : loading && !data ? (
        <div className="stack"><div className="kpis">{[1, 2, 3, 4].map((i) => <Skeleton key={i} h={96} />)}</div><Skeleton h={300} /></div>
      ) : (
        <div className="stack">
          <div className="kpis">
            {kpi('Money traded', money(data.kpis.gmv, cur), data.kpis.gmv, data.previous.gmv)}
            {kpi('Fees earned', money(data.kpis.fees, cur), data.kpis.fees, data.previous.fees)}
            {kpi('Orders completed', String(data.kpis.completed), data.kpis.completed, data.previous.completed)}
            {kpi('Sellers with paid orders', String(data.kpis.sellers), data.kpis.sellers, data.previous.sellers)}
          </div>

          <div className="grid two">
            <section className="panel">
              <div className="panel-head"><h2>Money traded per day</h2><span className="muted small" style={{ marginLeft: 'auto' }}>Paid into Hoolam</span></div>
              <div className="panel-body"><AreaChart data={data.series} value={(d) => d.gmv} format={(n) => moneyShort(n, cur)} label="Money traded per day" /></div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Orders paid per day</h2><span className="muted small" style={{ marginLeft: 'auto' }}>{data.kpis.created} started in total</span></div>
              <div className="panel-body"><BarChart data={data.series} value={(d) => d.paid} format={(n) => String(Math.round(n))} label="Orders paid per day" /></div>
            </section>
          </div>

          <div className="grid side">
            <section className="panel">
              <div className="panel-head"><h2>Where orders stall</h2><span className="muted small" style={{ marginLeft: 'auto' }}>Orders started in the last {days} days</span></div>
              <div className="panel-body">
                {!data.funnel.created ? <Empty icon={ChartColumn} title="No orders in this period" /> : (
                  <div className="funnel">
                    {[['Started', data.funnel.created], ['Both sides in', data.funnel.matched], ['Paid', data.funnel.paid], ['Shipped', data.funnel.shipped], ['Completed', data.funnel.completed]].map(([label, n], i, arr) => (
                      <div className="funnel-row" key={label as string}>
                        <span>{label}</span>
                        <div className="funnel-bar"><i style={{ width: `${Math.max(2, pct(n as number, data.funnel.created))}%`, animationDelay: `${i * 70}ms` }} /></div>
                        <span className="num" style={{ textAlign: 'right' }}><b>{n as number}</b> <span className="muted">{i ? `${pct(n as number, arr[i - 1]![1] as number)}%` : ''}</span></span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="small muted" style={{ marginTop: 12 }}>The percentage is how many made it from the step above. The biggest drop is where to look first.</p>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Typical times</h2></div>
              <div className="panel-body">
                <dl className="kv">
                  <dt>Started → paid</dt><dd><b>{hours(data.timing.toPay)}</b></dd>
                  <dt>Paid → shipped</dt><dd><b>{hours(data.timing.toShip)}</b></dd>
                  <dt>Shipped → happy</dt><dd><b>{hours(data.timing.toConfirm)}</b></dd>
                </dl>
                <hr className="sep" />
                <dl className="kv">
                  <dt>Disputes</dt><dd>{data.disputes.opened} opened · {pct(data.disputes.opened, Math.max(1, data.kpis.paid))}% of paid orders</dd>
                  <dt>Outcomes</dt><dd>{data.disputes.refunded} refunded · {data.disputes.released} seller paid</dd>
                  <dt>Buyers happy</dt><dd>{data.ratings.rated ? `${pct(data.ratings.happy, data.ratings.rated)}% of ${data.ratings.rated} ratings` : 'No ratings yet'}</dd>
                  <dt>Repeat buyers</dt><dd>{data.repeatBuyers}</dd>
                  <dt>Who starts orders</dt><dd>{(() => { const s = data.startedBy.SELLER ?? 0, b = data.startedBy.BUYER ?? 0; return `${s} by seller${s === 1 ? '' : 's'} · ${b} by buyer${b === 1 ? '' : 's'}`; })()}</dd>
                </dl>
              </div>
            </section>
          </div>

          <section className="panel">
            <div className="panel-head"><h2>Top sellers</h2><span className="muted small" style={{ marginLeft: 'auto' }}>By completed orders, last {days} days</span></div>
            {!data.topSellers.length ? <Empty icon={ChartColumn} title="No completed orders yet" /> : (
              <div className="table-wrap"><table className="t"><thead><tr><th>Seller</th><th className="r">Completed orders</th><th className="r">Money traded</th><th className="r">Buyers happy</th></tr></thead>
                <tbody>{data.topSellers.map((s: any) => (
                  <tr key={s.id}><td><Link to={`/people/${s.id}`} className="cell-main">{s.name}</Link></td><td className="r num">{s.deals}</td><td className="r money">{money(s.gmv, cur)}</td><td className="r">{s.rated ? `${pct(s.happy, s.rated)}%` : <span className="faint">—</span>}</td></tr>
                ))}</tbody></table></div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
