import { BadgeCheck, CalendarClock, Check, CircleCheck, Hourglass, KeyRound, LifeBuoy, Scale, ShieldAlert, ThumbsDown, TriangleAlert, Wallet, Banknote, HandCoins, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { ago, dateTime, money } from '../format';
import { useData, usePoll } from '../hooks';
import { ConfirmAction, ErrorBanner, Seg, Skeleton, SkeletonRows, useToast } from '../ui';

type Item = { key: string; kind: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string; at: string; link: string; cta: string; dismissible?: boolean };

const ICONS: Record<string, LucideIcon> = {
  dispute: Scale, payout: KeyRound, payment: TriangleAlert, support: LifeBuoy, overdue: Hourglass, rating: ThumbsDown, expiring: CalendarClock, template: ShieldAlert, system: ShieldAlert,
};

export function MoneyStrip() {
  const m = useData<any>('/money');
  if (m.error) return null;
  const d = m.data;
  const cell = (cls: string, Icon: LucideIcon, label: string, value: number | undefined, sub: string) => (
    <div className={cls}>
      <div className="label"><Icon aria-hidden="true" />{label}</div>
      <div className="value">{d ? money(value, d.currency) : <Skeleton h={28} w={120} style={{ opacity: .25 }} />}</div>
      <div className="sub">{sub}</div>
    </div>
  );
  return (
    <section className="money-strip" aria-label="Where the money is right now">
      {cell('held', Wallet, 'Held for buyers right now', d?.held, 'Waiting until buyers are happy')}
      {cell('', HandCoins, 'Owed to sellers', d?.owedSellers, 'Released, payout on the way')}
      {cell('', Banknote, 'Owed back to buyers', d?.owedBuyers, 'Refunds and over-payments')}
      {cell('', BadgeCheck, 'Fees earned, 30 days', d?.fees30, d ? `${money(d.feesTotal, d.currency)} all time` : '')}
    </section>
  );
}

export function Home() {
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [leaving, setLeaving] = useState<string | null>(null);
  const [dismiss, setDismiss] = useState<Item | null>(null);
  const inbox = useData<{ items: Item[] }>('/inbox');
  usePoll(() => inbox.reload(), 30_000);
  const items = inbox.data?.items ?? [];
  const shown = filter === 'all' ? items : items.filter((i) => i.severity === filter);
  const n = (s: string) => items.filter((i) => i.severity === s).length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting}, {me?.name.split(' ')[0]}</h1>
          <p className="lede">{inbox.loading ? 'Checking what needs you…' : items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} a person. Most urgent first.` : 'Nothing needs a person right now.'}</p>
        </div>
      </div>
      <div className="stack">
        <MoneyStrip />
        <section className="panel" aria-label="Needs action">
          <div className="panel-head">
            <h2>Needs action</h2>
            <div className="right">
              <Seg value={filter} onChange={setFilter} options={[
                { value: 'all', label: 'All', n: items.length }, { value: 'high', label: 'Urgent', n: n('high') },
                { value: 'medium', label: 'Soon', n: n('medium') }, { value: 'low', label: 'When you can', n: n('low') },
              ]} />
            </div>
          </div>
          {inbox.error ? <div className="panel-body"><ErrorBanner error={inbox.error} onRetry={() => inbox.reload()} /></div>
            : inbox.loading ? <SkeletonRows rows={5} />
            : shown.length === 0 ? (
              <div className="clear-state">
                <div className="ok"><CircleCheck /></div>
                <h2>All clear</h2>
                <p className="muted" style={{ marginTop: 4 }}>{filter === 'all' ? 'Disputes, payouts, support and problems will show up here the moment they happen.' : 'Nothing at this level.'}</p>
              </div>
            ) : (
              <div>
                {shown.map((it) => {
                  const Icon = ICONS[it.kind] ?? TriangleAlert;
                  return (
                    <div key={it.key} className={`inbox-item${leaving === it.key ? ' leaving' : ''}`}>
                      <div className={`sev ${it.severity}`} aria-label={it.severity === 'high' ? 'Urgent' : it.severity === 'medium' ? 'Soon' : 'When you can'}><Icon /></div>
                      <div className="body">
                        <Link to={it.link} className="title" style={{ color: 'var(--ink)' }}>{String(it.title).split(/(HL-[A-Z0-9]{5})/).map((part: string, i: number) => i % 2 ? <span key={i} className="nowrap">{part}</span> : part)}</Link>
                        <div className="detail">{it.detail}</div>
                      </div>
                      <div className="when" title={dateTime(it.at)}>{ago(it.at)}</div>
                      <div className="acts">
                        {it.dismissible && <button className="btn sm ghost" onClick={() => setDismiss(it)}><Check />Handled</button>}
                        <button className="btn sm primary" onClick={() => nav(it.link)}>{it.cta}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </section>
      </div>
      {dismiss && (
        <ConfirmAction title="Mark as handled" icon={Check} confirmLabel="Mark as handled" needReason={false}
          description={<>“{dismiss.title}” leaves the list for everyone.</>}
          extra={<div className="field"><label htmlFor="note">Note (optional)</label><input id="note" className="input" placeholder="e.g. Called the seller, sorted" onChange={(e) => ((dismiss as any).note = e.target.value)} /></div>}
          onClose={() => setDismiss(null)}
          onConfirm={async () => {
            await post('/inbox/dismiss', { key: dismiss.key, reason: (dismiss as any).note });
            setLeaving(dismiss.key);
            toast({ kind: 'ok', title: 'Marked as handled' });
            setTimeout(() => { setLeaving(null); inbox.reload(); }, 300);
          }} />
      )}
    </div>
  );
}
