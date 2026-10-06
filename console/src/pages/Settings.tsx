import { History, Lock, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { put } from '../api';
import { useAuth } from '../auth';
import { ago, dateTime, money } from '../format';
import { useData } from '../hooks';
import { Button, ConfirmAction, ErrorBanner, Skeleton, Switch, useToast } from '../ui';

type Def = { key: string; group: string; label: string; help: string; type: 'number' | 'money' | 'percent' | 'hours' | 'boolean'; min?: number; max?: number };

export function Settings() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useData<any>('/settings');
  const [draft, setDraft] = useState<Record<string, number | boolean>>({});
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (data) setDraft(data.values); }, [data]);
  const editable = can('settings.update');
  const changed = useMemo(() => (data ? Object.keys(draft).filter((k) => draft[k] !== data.values[k]) : []), [draft, data]);
  if (error) return <div className="page"><ErrorBanner error={error} onRetry={reload} /></div>;
  if (loading || !data) return <div className="page"><Skeleton h={30} w={200} /><div className="grid side" style={{ marginTop: 20 }}><Skeleton h={420} /><Skeleton h={420} /></div></div>;
  const defs: Def[] = data.defs;
  const groups = [...new Set(defs.map((d) => d.group))];
  const show = (d: Def, v: number | boolean) => d.type === 'boolean' ? (v ? 'On' : 'Off') : d.type === 'money' ? money(Number(v) * 100, data.currency) : d.type === 'percent' ? `${v}%` : d.type === 'hours' ? `${v} hours` : String(v);
  // a live preview of the fee rules being edited (plain calculation: no hook after the early returns above)
  const example = (() => {
    const p = Number(draft.fee_rate_percent), mn = Number(draft.fee_min), mx = Number(draft.fee_max), r = Number(draft.fee_round_to) || 1;
    return [5_000, 15_000, 50_000].map((price) => { let f = (price * p) / 100; f = Math.min(mx, Math.max(mn, f)); f = Math.round(f / r) * r; return { price, fee: f }; });
  })();

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Settings</h1><p className="lede">Fees, limits and timings for the whole service. Changes apply to new deals only. A deal keeps the fee it started with.</p></div>
        {editable && (
          <div className="actions">
            <Button icon={RotateCcw} variant="ghost" disabled={!changed.length} onClick={() => setDraft(data.values)}>Discard</Button>
            <Button icon={Save} variant="primary" disabled={!changed.length} onClick={() => setConfirm(true)}>Save {changed.length ? `${changed.length} change${changed.length > 1 ? 's' : ''}` : 'changes'}</Button>
          </div>
        )}
      </div>
      {!editable && <div className="banner gold" style={{ marginBottom: 16 }}><Lock /><div>Only an owner can change settings. You can see them here.</div></div>}
      <div className="grid side">
        <div className="stack">
          {groups.map((g) => (
            <section className="panel" key={g}>
              <div className="panel-head"><h2>{g}</h2></div>
              <div>
                {defs.filter((d) => d.group === g).map((d) => {
                  const v = draft[d.key];
                  const isChanged = v !== data.values[d.key];
                  const upd = data.updated[d.key];
                  return (
                    <div key={d.key} className="row" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-2)', alignItems: 'flex-start', gap: 16, background: isChanged ? 'var(--gold-50)' : undefined, transition: 'background .2s' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <label htmlFor={d.key} style={{ fontWeight: 600 }}>{d.label}</label>
                        <div className="small muted">{d.help}</div>
                        <div className="small faint" style={{ marginTop: 2 }}>{upd ? `Last changed by ${upd.by ?? 'someone'} ${ago(upd.at)}` : `Default: ${show(d, data.defaults[d.key])}`}</div>
                      </div>
                      {d.type === 'boolean'
                        ? <Switch on={!!v} onChange={(x) => editable && setDraft({ ...draft, [d.key]: x })} label={d.label} />
                        : (
                          <div className="row" style={{ gap: 6, width: 190 }}>
                            {d.type === 'money' && <span className="muted">{data.currency === 'NGN' ? '₦' : 'CFA'}</span>}
                            <input id={d.key} className="input num" style={{ textAlign: 'right' }} type="number" disabled={!editable}
                              min={d.min} max={d.max} step={d.type === 'percent' ? 0.1 : 1}
                              value={String(v ?? '')} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value === '' ? ('' as any) : Number(e.target.value) })} />
                            {d.type === 'percent' && <span className="muted">%</span>}
                            {d.type === 'hours' && <span className="muted">hours</span>}
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
              {g === 'Fees' && (
                <div className="panel-body">
                  <div className="small muted" style={{ marginBottom: 8 }}>With these numbers, whoever starts the deal pays:</div>
                  <div className="row wrap" style={{ gap: 8 }}>{example.map((e) => <span key={e.price} className="pill teal plain">{money(e.price * 100)} item → {money(e.fee * 100)} fee</span>)}</div>
                </div>
              )}
            </section>
          ))}
        </div>
        <section className="panel">
          <div className="panel-head"><h2>Change history</h2><History className="faint" style={{ marginLeft: 'auto', width: 18 }} /></div>
          <div className="panel-body">
            {!data.history.length ? <p className="muted small">No changes yet. Everything is on its defaults.</p> : (
              <ol className="timeline">
                {data.history.map((h: any, i: number) => (
                  <li key={i}>
                    <span className="ic staff"><History /></span>
                    <div className="what">{h.actor}</div>
                    <div className="meta">{dateTime(h.at)}</div>
                    <div className="why">
                      {Object.entries(h.details?.changes ?? {}).map(([k, c]: [string, any]) => {
                        const d = defs.find((x) => x.key === k);
                        return <div key={k}>{d?.label ?? k}: {d ? show(d, c.from) : String(c.from)} → <b>{d ? show(d, c.to) : String(c.to)}</b></div>;
                      })}
                      {h.reason && <div className="muted" style={{ marginTop: 4 }}>“{h.reason}”</div>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
      {confirm && <ConfirmAction icon={Save} tone="gold" title="Save these changes?" confirmLabel="Save changes"
        description="They apply to new deals from now on. Deals already running keep their fee and limits."
        extra={<div className="why" style={{ background: 'var(--sunk)', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
          {changed.map((k) => { const d = defs.find((x) => x.key === k)!; return <div key={k}>{d.label}: {show(d, data.values[k])} → <b>{show(d, draft[k]!)}</b></div>; })}
        </div>}
        reasonPlaceholder="e.g. Lower minimum fee for the pilot sellers"
        onClose={() => setConfirm(false)}
        onConfirm={async (reason) => {
          const changes = Object.fromEntries(changed.map((k) => [k, draft[k]]));
          await put('/settings', { changes, reason });
          toast({ kind: 'ok', title: 'Settings saved', body: 'New deals use them from now.' });
          reload();
        }} />}
    </div>
  );
}
