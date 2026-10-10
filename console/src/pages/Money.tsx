import { CircleCheck, Download, KeyRound, Landmark, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { ago, dateTime, money } from '../format';
import { useData } from '../hooks';
import { Button, ConfirmAction, Empty, ErrorBanner, Pager, PayoutPill, Seg, SkeletonRows, useToast } from '../ui';
import { MoneyStrip } from './Home';

const ACCOUNTS: Record<string, string> = {
  'held:deal': 'Held for buyers (in the middle)', 'payable:seller': 'Owed to sellers', 'payable:buyer': 'Owed back to buyers', 'payable:courier': 'Owed to riders and drivers', 'revenue:fees': 'Fees earned (Hoolam and transaction fees)',
};

export function Money() {
  const { can } = useAuth();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [filter, setFilter] = useState(sp.get('payout') ? 'action' : 'all');
  const [page, setPage] = useState(1);
  const statusParam = filter === 'action' ? 'NEEDS_AUTHORIZATION,FAILED,REVERSED' : filter === 'sending' ? 'CREATED,SUBMITTED' : filter === 'paid' ? 'SUCCESS' : '';
  const summary = useData<any>('/money');
  const payouts = useData<any>(`/payouts?page=${page}${statusParam ? `&status=${statusParam}` : ''}`);
  const [otpFor, setOtpFor] = useState<any>(null);
  const [retryFor, setRetryFor] = useState<any>(null);
  const [otp, setOtp] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), to: today });
  const cur = summary.data?.currency ?? 'NGN';
  const p = summary.data?.payouts ?? {};
  const needs = (p.NEEDS_AUTHORIZATION?.count ?? 0) + (p.FAILED?.count ?? 0) + (p.REVERSED?.count ?? 0);
  const refresh = () => { summary.reload(); payouts.reload(); };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Money</h1><p className="lede">Where every naira is right now, payouts on the way, and a check that the books balance.</p></div>
      </div>
      <div className="stack">
        <MoneyStrip />
        <div className="grid side">
          <section className="panel">
            <div className="panel-head">
              <h2>Payouts and refunds</h2>
              <div className="right">
                <Seg value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[
                  { value: 'all', label: 'All' }, { value: 'action', label: 'Needs you', n: needs }, { value: 'sending', label: 'Sending' }, { value: 'paid', label: 'Paid' },
                ]} />
              </div>
            </div>
            {payouts.error ? <div className="panel-body"><ErrorBanner error={payouts.error} onRetry={payouts.reload} /></div>
              : payouts.loading && !payouts.data ? <SkeletonRows rows={6} />
              : !payouts.data.rows.length ? <Empty icon={Landmark} title={filter === 'action' ? 'No payouts need you' : 'No payouts yet'}>Payouts start when a buyer is happy or a refund is approved.</Empty>
              : (
                <>
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>Order</th><th>To</th><th>Status</th><th className="r">Amount</th><th>Updated</th><th></th></tr></thead>
                      <tbody>
                        {payouts.data.rows.map((r: any) => (
                          <tr key={r.reference} style={sp.get('payout') === r.reference ? { background: 'var(--gold-50)' } : undefined}>
                            <td><Link to={`/deals/${r.code}`} className="cell-main">{r.code}</Link><div className="cell-sub mono">{r.reference}</div></td>
                            <td>{r.account_name}<div className="cell-sub">{r.kind === 'REFUND' ? 'Refund · ' : r.kind === 'DELIVERY' ? 'Delivery fee · ' : ''}{r.bank_name} ••••{r.last4}</div></td>
                            <td><PayoutPill status={r.status} />{r.provider_message && <div className="cell-sub" style={{ maxWidth: 220 }}>{r.provider_message}</div>}</td>
                            <td className="r money">{money(r.amount_minor, r.currency)}</td>
                            <td className="muted nowrap" title={dateTime(r.updated_at)}>{ago(r.updated_at)}</td>
                            <td className="r nowrap">
                              {r.status === 'NEEDS_AUTHORIZATION' && can('payout.authorize') && <Button size="sm" variant="primary" icon={KeyRound} onClick={() => { setOtp(''); setOtpFor(r); }}>Approve</Button>}
                              {['FAILED', 'REVERSED'].includes(r.status) && can('payout.retry') && <Button size="sm" icon={RefreshCw} onClick={() => setRetryFor(r)}>Retry</Button>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={payouts.data.page} pageSize={payouts.data.pageSize} total={payouts.data.total} onPage={setPage} />
                </>
              )}
          </section>

          <div className="stack">
            <section className="panel">
              <div className="panel-head"><h2>Books check</h2></div>
              <div className="panel-body">
                {summary.data && (summary.data.reconciled
                  ? <div className="banner teal"><CircleCheck /><div><b>Balanced.</b> Every naira in has a matching naira out or held. Checked {ago(new Date())}.</div></div>
                  : <div className="banner red"><TriangleAlert /><div><b>Not balanced.</b> Tell the developer straight away.</div></div>)}
                <table className="t" style={{ marginTop: 12 }}>
                  <tbody>
                    {(summary.data?.balances ?? []).filter((b: any) => !b.account.startsWith('cash:')).map((b: any) => (
                      <tr key={b.account}><td>{ACCOUNTS[b.account] ?? b.account}</td><td className="r money">{money(Math.abs(b.balance), cur)}</td></tr>
                    ))}
                    <tr><td><b>Cash at the payment provider</b></td><td className="r money"><b>{money(summary.data?.cash ?? 0, cur)}</b></td></tr>
                  </tbody>
                </table>
                <p className="small muted" style={{ marginTop: 10 }}>Cash at the provider should equal everything above added together. Compare it with your Monnify balance each day.</p>
              </div>
            </section>
            {can('money.export') && (
              <section className="panel">
                <div className="panel-head"><h2>Export for your accountant</h2></div>
                <div className="panel-body stack" style={{ gap: 12 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label htmlFor="from">From</label><input id="from" type="date" className="input" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
                    <div className="field" style={{ flex: 1 }}><label htmlFor="to">To</label><input id="to" type="date" className="input" value={range.to} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
                  </div>
                  <a className="btn" href={`/console/api/money/export.csv?from=${range.from}&to=${range.to}`} download><Download />Download orders (CSV)</a>
                  <p className="small muted">Every order with its price, fee, what the buyer paid and what the seller received. The download is recorded in the audit trail.</p>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {otpFor && <ConfirmAction icon={KeyRound} tone="gold" title={`Approve ${money(otpFor.amount_minor, otpFor.currency)} to ${otpFor.account_name}`} confirmLabel="Approve payout" needReason={false}
        description="Monnify emailed a one-time code to approve this transfer. Enter it here."
        extra={<div className="field"><label htmlFor="otp">OTP from Monnify</label><input id="otp" className="input code-input" inputMode="numeric" autoFocus value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} /></div>}
        extraValid={otp.length >= 4}
        onClose={() => setOtpFor(null)}
        onConfirm={async () => { await post(`/payouts/${encodeURIComponent(otpFor.reference)}/authorize`, { otp }); toast({ kind: 'ok', title: 'Payout approved' }); refresh(); }} />}
      {retryFor && <ConfirmAction icon={RefreshCw} title="Retry this payout?" confirmLabel="Retry payout"
        description={<>Sends {money(retryFor.amount_minor, retryFor.currency)} to {retryFor.account_name} again. Hoolam checks it never pays twice.</>}
        reasonPlaceholder="e.g. Seller fixed their bank details" onClose={() => setRetryFor(null)}
        onConfirm={async (reason) => { await post(`/payouts/${encodeURIComponent(retryFor.reference)}/retry`, { reason }); toast({ kind: 'ok', title: 'Payout sent again' }); refresh(); }} />}
    </div>
  );
}
