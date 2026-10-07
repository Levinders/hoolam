import { AlertTriangle, ArrowUpRight, BellRing, Gauge, CircleCheck, Clock, Flag, Hourglass, Lock, MessageCircle, RotateCcw, Save, Truck } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { put } from '../../api';
import { useAuth } from '../../auth';
import { ago, money } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, ErrorBanner, Skeleton, Switch, useToast } from '../../ui';
import { SectionHead, useUnsaved } from '../Settings';

type Val = number | boolean | string;
export type Def = { key: string; group: string; label: string; help: string; type: 'number' | 'money' | 'percent' | 'hours' | 'boolean' | 'phone'; min?: number; max?: number };
interface SettingsData { currency: string; defs: Def[]; values: Record<string, Val>; defaults: Record<string, Val>; updated: Record<string, { at: string; by: string | null }>; history: any[] }

/** +234 801 234 5678, +1 555 138 0045, +229 01 90 00 00 05 */
export function phoneText(raw: string): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  const cc = /^[17]/.test(d) ? d.slice(0, 1) : /^(2[1-9]\d|3[578]\d|42\d|5[09]\d|6[7-9]\d|8[5-9]\d|9[6-9]\d)/.test(d) ? d.slice(0, 3) : d.slice(0, 2);
  const rest = d.slice(cc.length);
  const grouped = rest.length === 10 ? rest.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3') : rest.replace(/(\d{2})(?=\d)/g, '$1 ');
  return `+${cc} ${grouped}`;
}
export function showValue(d: Def | undefined, v: Val, currency = 'NGN'): string {
  if (!d) return String(v);
  if (d.type === 'boolean') return v ? 'On' : 'Off';
  if (d.type === 'money') return money(Number(v) * (currency === 'NGN' ? 100 : 1), currency);
  if (d.type === 'percent') return `${v}%`;
  if (d.type === 'hours') return `${v} hour${Number(v) === 1 ? '' : 's'}`;
  if (d.type === 'phone') return phoneText(String(v));
  return String(v);
}

/** Loads the settings, keeps an editable copy of the given keys, and saves them with a reason. */
function useDraft(keys: string[]) {
  const q = useData<SettingsData>('/settings');
  const [draft, setDraft] = useState<Record<string, Val>>({});
  useEffect(() => { if (q.data) setDraft(Object.fromEntries(keys.map((k) => [k, q.data!.values[k]!]))); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = useMemo(() => (q.data ? keys.filter((k) => draft[k] !== undefined && draft[k] !== q.data!.values[k]) : []), [draft, q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useUnsaved(changed.length > 0);
  return { ...q, draft, setDraft, changed, def: (k: string) => q.data?.defs.find((d) => d.key === k) };
}

type Draft = ReturnType<typeof useDraft>;

/** One page of values: rows on the left, an explainer on the right, a save bar when something changed. */
function ValuesPage({ title, lede, keys, aside, render, confirmExtra, applies = 'applies to new deals', stacked = [] }: {
  applies?: string; stacked?: string[]; title: string; lede: ReactNode; keys: string[]; aside?: (s: Draft) => ReactNode;
  render?: Partial<Record<string, (s: Draft, editable: boolean) => ReactNode>>; confirmExtra?: (s: Draft) => ReactNode;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const s = useDraft(keys);
  const [confirm, setConfirm] = useState(false);
  const editable = can('settings.update');
  if (s.error) return <ErrorBanner error={s.error} onRetry={s.reload} />;
  if (s.loading || !s.data) return <div className="stack"><Skeleton h={44} w={320} /><div className="settings-grid"><Skeleton h={320} /><Skeleton h={220} /></div></div>;
  const data = s.data;
  const invalid = s.changed.find((k) => { const d = s.def(k); const v = s.draft[k]; return d && d.type !== 'boolean' && d.type !== 'phone' && (v === '' || Number.isNaN(Number(v)) || (d.min != null && Number(v) < d.min) || (d.max != null && Number(v) > d.max)); });

  return (
    <>
      <SectionHead title={title} lede={lede} />
      {!editable && <div className="banner gold" style={{ marginBottom: 16 }}><Lock /><div>Only an owner can change settings. You can see them here.</div></div>}
      <div className={`settings-grid${aside ? '' : ' single'}`}>
        <section className="panel setting-list">
          {keys.map((k) => {
            const d = s.def(k)!;
            const v = s.draft[k] ?? data.values[k]!;
            const upd = data.updated[k];
            const isChanged = s.changed.includes(k);
            const custom = render?.[k];
            return (
              <div key={k} className={`setting-row${isChanged ? ' changed' : ''}${d.type === 'boolean' ? ' toggle' : ''}${stacked.includes(k) ? ' stacked' : ''}`}>
                <div className="sr-text">
                  <label htmlFor={`f-${k}`}>{d.label}</label>
                  <p>{d.help}</p>
                  <span className="sr-meta">{isChanged ? <>Was {showValue(d, data.values[k]!, data.currency)}</> : upd ? `Changed by ${upd.by ?? 'someone'} ${ago(upd.at)}` : `Default: ${showValue(d, data.defaults[k]!, data.currency)}`}</span>
                </div>
                <div className="sr-control">
                  {custom ? custom(s, editable) : d.type === 'boolean'
                    ? <Switch on={!!v} onChange={(x) => editable && s.setDraft({ ...s.draft, [k]: x })} label={d.label} />
                    : (
                      <div className={`affix${d.type === 'money' ? ' pre' : ' post'}`}>
                        {d.type === 'money' && <span>{data.currency === 'NGN' ? '₦' : 'CFA'}</span>}
                        <input id={`f-${k}`} className="input num" type="number" inputMode="decimal" disabled={!editable}
                          min={d.min} max={d.max} step={d.type === 'percent' ? 0.1 : 1}
                          value={String(v ?? '')} onChange={(e) => s.setDraft({ ...s.draft, [k]: e.target.value === '' ? '' : Number(e.target.value) })} />
                        {d.type === 'percent' && <span>%</span>}
                        {d.type === 'hours' && <span>hours</span>}
                      </div>
                    )}
                </div>
              </div>
            );
          })}
        </section>
        {aside && <aside className="stack">{aside(s)}</aside>}
      </div>

      <div className={`savebar${s.changed.length ? ' show' : ''}`} aria-hidden={!s.changed.length}>
        <div className="savebar-in">
          <span className="dot" />
          <span><b>{s.changed.length} unsaved change{s.changed.length === 1 ? '' : 's'}</b>{invalid ? <span className="savebar-err"> · {s.def(invalid)!.label} is out of range</span> : <span className="muted"> · {applies}</span>}</span>
          <span className="spacer" />
          <Button icon={RotateCcw} variant="ghost" onClick={() => s.setDraft(Object.fromEntries(keys.map((k) => [k, data.values[k]!])))} tabIndex={s.changed.length ? 0 : -1}>Discard</Button>
          <Button icon={Save} variant="primary" disabled={!!invalid} onClick={() => setConfirm(true)} tabIndex={s.changed.length ? 0 : -1}>Save changes</Button>
        </div>
      </div>

      {confirm && <ConfirmAction icon={Save} tone="gold" title={`Save ${s.changed.length} change${s.changed.length === 1 ? '' : 's'}?`} confirmLabel="Save changes"
        description="They apply from now on. Deals already running keep their fee and limits."
        extra={<>
          <div className="diff">{s.changed.map((k) => { const d = s.def(k)!; return <div key={k}><span>{d.label}</span><span><s>{showValue(d, data.values[k]!, data.currency)}</s> → <b>{showValue(d, s.draft[k]!, data.currency)}</b></span></div>; })}</div>
          {confirmExtra?.(s)}
        </>}
        reasonPlaceholder="e.g. Lower minimum fee for the pilot sellers"
        onClose={() => setConfirm(false)}
        onConfirm={async (reason) => {
          await put('/settings', { changes: Object.fromEntries(s.changed.map((k) => [k, s.draft[k]])), reason });
          toast({ kind: 'ok', title: 'Saved', body: 'In use from now on.' });
          s.reload();
        }} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function feeOf(price: number, d: Record<string, Val>) {
  const p = Number(d.fee_rate_percent), mn = Number(d.fee_min), mx = Number(d.fee_max), r = Number(d.fee_round_to) || 1;
  let f = (price * p) / 100; f = Math.min(mx, Math.max(mn, f)); return Math.round(f / r) * r;
}

export function FeesPage() {
  return <ValuesPage title="Fees" lede="What Hoolam charges on each deal. Whoever starts the deal pays the fee."
    keys={['fee_rate_percent', 'fee_min', 'fee_max', 'fee_round_to']}
    aside={(s) => <FeePreview s={s} />} />;
}
function FeePreview({ s }: { s: Draft }) {
  const [price, setPrice] = useState(25_000);
  const cur = s.data!.currency;
  const m = (n: number) => money(n * (cur === 'NGN' ? 100 : 1), cur);
  const fee = feeOf(price, s.draft);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Try it</h2><span className="right small muted">Updates as you type</span></div>
      <div className="panel-body stack" style={{ gap: 14 }}>
        <div className="affix pre big"><span>₦</span><input className="input num" type="number" inputMode="numeric" value={price || ''} aria-label="Item price" onChange={(e) => setPrice(Math.max(0, Number(e.target.value)))} /></div>
        <div className="fee-split">
          <div><span>Hoolam fee</span><b className="money">{price ? m(fee) : '—'}</b></div>
          <div><span>Buyer starts: buyer pays</span><b className="money">{price ? m(price + fee) : '—'}</b></div>
          <div><span>Seller starts: seller gets</span><b className="money">{price ? m(price - fee) : '—'}</b></div>
        </div>
        <div className="chips">{[5_000, 15_000, 50_000].map((p) => <button key={p} type="button" className={`chip-btn${p === price ? ' on' : ''}`} onClick={() => setPrice(p)}>{m(p)} → {m(feeOf(p, s.draft))}</button>)}</div>
        <p className="small muted">The website's fee calculator uses these same numbers.</p>
      </div>
    </section>
  );
}

export function LimitsPage() {
  return <ValuesPage title="Limits" lede="The most a single deal can be, before identity checks." keys={['max_deal']}
    aside={() => (
      <section className="panel"><div className="panel-body stack" style={{ gap: 10 }}>
        <div className="aside-ic"><Gauge /></div>
        <h3>One person needs more?</h3>
        <p className="small muted">Raise the limit for a single buyer or seller on their page in <Link to="/people">Buyers &amp; sellers</Link>. Everyone else keeps this one.</p>
        <p className="small muted">The website shows this limit next to the fee calculator.</p>
      </div></section>
    )} />;
}

export function TimingPage() {
  return <ValuesPage title="Timing" lede="When Hoolam reminds people, and when a deal comes to the team." keys={['seller_accept_hours', 'nudge_after_hours', 'flag_after_hours']}
    aside={(s) => {
      const h = (k: string) => `${s.draft[k] || '—'} h`;
      return (
        <section className="panel">
          <div className="panel-head"><h2>How a deal moves</h2></div>
          <div className="panel-body">
            <ol className="flowline">
              <li><span className="fl-ic"><Hourglass /></span><div><b>Buyer starts a deal</b><span>The seller has <em>{h('seller_accept_hours')}</em> to accept, then it closes.</span></div></li>
              <li><span className="fl-ic"><Truck /></span><div><b>Seller ships</b><span>The money stays held.</span></div></li>
              <li><span className="fl-ic gold"><BellRing /></span><div><b>After <em>{h('nudge_after_hours')}</em></b><span>We ask the buyer if it arrived.</span></div></li>
              <li><span className="fl-ic red"><Flag /></span><div><b>After <em>{h('flag_after_hours')}</em></b><span>Still no answer: it shows in Needs action.</span></div></li>
              <li><span className="fl-ic green"><CircleCheck /></span><div><b>Buyer is happy</b><span>The seller is paid.</span></div></li>
            </ol>
          </div>
        </section>
      );
    }} />;
}

export function WhatsAppPage() {
  return <ValuesPage title="WhatsApp" lede="The number people message, and what the bot offers them." keys={['whatsapp_number', 'alerts_enabled', 'forms_enabled']} applies="applies right away" stacked={['whatsapp_number']}
    render={{
      whatsapp_number: (s, editable) => {
        const v = String(s.draft.whatsapp_number ?? '');
        const ok = /^[1-9]\d{7,14}$/.test(v);
        return (
          <div className="phone-field">
            <div className="affix pre big"><span>+</span>
              <input id="f-whatsapp_number" className="input num" inputMode="numeric" autoComplete="off" disabled={!editable} value={v} placeholder="2348012345678"
                onChange={(e) => s.setDraft({ ...s.draft, whatsapp_number: e.target.value.replace(/\D/g, '').slice(0, 15) })} aria-describedby="wa-hint" />
            </div>
            <div id="wa-hint" className={`small ${v && !ok ? 'err-text' : 'muted'}`}>
              {!v ? 'Country code first, digits only.' : ok ? <>Shows as <b>{phoneText(v)}</b> · <a href={`https://wa.me/${v}`} target="_blank" rel="noopener">Open the chat <ArrowUpRight className="inline-ic" /></a></> : v.startsWith('0') ? 'Start with the country code (234 for Nigeria), not 0.' : 'That doesn\'t look like a full number yet.'}
            </div>
          </div>
        );
      },
    }}
    confirmExtra={(s) => s.changed.includes('whatsapp_number') && (
      <div className="banner gold small"><AlertTriangle /><div>Make sure this is the same number your WhatsApp app on Meta is connected to. If they differ, people will message a number Hoolam doesn't answer.</div></div>
    )}
    aside={() => (
      <section className="panel">
        <div className="panel-head"><h2>Where the number is used</h2></div>
        <div className="panel-body stack" style={{ gap: 12 }}>
          <ul className="uses">
            <li><MessageCircle />Every "Chat on WhatsApp" button on the website</li>
            <li><MessageCircle />Sellers' public pages and "Buy from" links</li>
            <li><MessageCircle />Payment and deal links sent to buyers and sellers</li>
          </ul>
          <div className="note"><Clock /><span>Changing it here updates links. It doesn't move your WhatsApp account: that's set on Meta, and on Render as <code>WHATSAPP_PHONE_NUMBER_ID</code>.</span></div>
        </div>
      </section>
    )} />;
}
