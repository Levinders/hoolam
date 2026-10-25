import { AlertTriangle, ArrowUpRight, BarChart3, Megaphone, BadgeCheck, UserRound, Clapperboard, Eye, AtSign, BellRing, Building2, ChevronDown, Mail, Phone, Gauge, CircleCheck, Clock, Flag, Hourglass, KeyRound, Lock, MessageCircle, RotateCcw, Save, Truck } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { post, put } from '../../api';
import { useAuth } from '../../auth';
import { ago, money } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, ErrorBanner, Pill, Skeleton, Switch, useToast } from '../../ui';
import { SectionHead, useUnsaved } from '../Settings';
import { ChatMediaPanel } from './ChatMedia';
import { SellerVideos } from './SellerVideos';

type Band = { upTo: number | null; fee: number };
type Val = number | boolean | string | Band[];
export type Def = { key: string; group: string; label: string; help: string; type: 'number' | 'money' | 'percent' | 'hours' | 'minutes' | 'boolean' | 'phone' | 'email' | 'social' | 'bands'; min?: number; max?: number; core?: boolean; optional?: boolean; social?: string };
interface SettingsData { currency: string; defs: Def[]; values: Record<string, Val>; defaults: Record<string, Val>; updated: Record<string, { at: string; by: string | null }>; history: any[] }

/** Nigerian numbers the way people write them (07034577787); others +1 555 138 0045. */
export function phoneText(raw: string): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (/^234\d{10}$/.test(d)) return '0' + d.slice(3);
  if (/^0\d{10}$/.test(d)) return d;
  const cc = /^[17]/.test(d) ? d.slice(0, 1) : /^(2[1-9]\d|3[578]\d|42\d|5[09]\d|6[7-9]\d|8[5-9]\d|9[6-9]\d)/.test(d) ? d.slice(0, 3) : d.slice(0, 2);
  const rest = d.slice(cc.length);
  const grouped = rest.length === 10 ? rest.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3') : rest.replace(/(\d{2})(?=\d)/g, '$1 ');
  return `+${cc} ${grouped}`;
}
/** 30 → "30 minutes", 1440 → "24 hours", 90 → "1 h 30 min" */
export function minutesText(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 60) return `${n} minute${n === 1 ? '' : 's'}`;
  const h = Math.floor(n / 60), m = n % 60;
  if (m) return `${h} h ${m} min`;
  return h % 24 === 0 && h >= 48 ? `${h / 24} days` : `${h} hour${h === 1 ? '' : 's'}`;
}
const MINUTE_PICKS = [30, 120, 720, 1440, 2880];

export function showValue(d: Def | undefined, v: Val, currency = 'NGN'): string {
  if (!d) return String(v);
  if (v === '' || v == null) return 'Not set';
  if (d.type === 'boolean') return v ? 'On' : 'Off';
  if (d.type === 'money') return money(Number(v) * (currency === 'NGN' ? 100 : 1), currency);
  if (d.type === 'percent') return `${v}%`;
  if (d.type === 'hours') return `${v} hour${Number(v) === 1 ? '' : 's'}`;
  if (d.type === 'minutes') return minutesText(Number(v));
  if (d.type === 'phone') return phoneText(String(v));
  if (d.type === 'bands') { const m = (n: number) => money(n * (currency === 'NGN' ? 100 : 1), currency); return (v as Band[]).map((b) => m(b.fee)).join(' / '); }
  return String(v);
}

/** Loads the settings, keeps an editable copy of the given keys, and saves them with a reason. */
function useDraft(keys: string[]) {
  const q = useData<SettingsData>('/settings');
  const [draft, setDraft] = useState<Record<string, Val>>({});
  useEffect(() => { if (q.data) setDraft(Object.fromEntries(keys.map((k) => [k, q.data!.values[k]!]))); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = useMemo(() => (q.data ? keys.filter((k) => draft[k] !== undefined && JSON.stringify(draft[k]) !== JSON.stringify(q.data!.values[k])) : []), [draft, q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useUnsaved(changed.length > 0);
  return { ...q, draft, setDraft, changed, def: (k: string) => q.data?.defs.find((d) => d.key === k) };
}

type Draft = ReturnType<typeof useDraft>;

/** One setting: its label, help and "changed by" line on the left, the control on the right. */
function SettingRow({ s, k, editable, custom, stacked }: { s: Draft; k: string; editable: boolean; custom?: (s: Draft, editable: boolean) => ReactNode; stacked?: boolean }) {
  const data = s.data!;
  const d = s.def(k)!;
  const v = s.draft[k] ?? data.values[k]!;
  const upd = data.updated[k];
  const isChanged = s.changed.includes(k);
  return (
    <div className={`setting-row${isChanged ? ' changed' : ''}${d.type === 'boolean' ? ' toggle' : ''}${stacked ? ' stacked' : ''}`}>
      <div className="sr-text">
        <label htmlFor={`f-${k}`}>{d.label}{!editable && <span className="owner-tag"><Lock />Owner</span>}</label>
        <p>{d.help}</p>
        <span className="sr-meta">{isChanged ? <>Was {showValue(d, data.values[k]!, data.currency)}</> : upd ? `Changed by ${upd.by ?? 'someone'} ${ago(upd.at)}` : `Default: ${showValue(d, data.defaults[k]!, data.currency)}`}</span>
      </div>
      <div className="sr-control">
        {custom ? custom(s, editable) : d.type === 'boolean'
          ? <Switch on={!!v} onChange={(x) => editable && s.setDraft({ ...s.draft, [k]: x })} label={d.label} />
          : d.type === 'email' || d.type === 'social' ? (
            <input id={`f-${k}`} className="input" style={{ width: "100%", maxWidth: 440 }} type={d.type === "email" ? "email" : "text"} inputMode={d.type === 'email' ? 'email' : 'url'} autoComplete="off" spellCheck={false}
              disabled={!editable} value={String(v ?? '')} placeholder={d.type === 'email' ? 'hello@hoolam.com' : d.social === 'linkedin' ? 'linkedin.com/company/…' : '@username or link'}
              onChange={(e) => s.setDraft({ ...s.draft, [k]: e.target.value })} />
          ) : (
            <div className={`affix${d.type === 'money' ? ' pre' : ' post'}`}>
              {d.type === 'money' && <span>{data.currency === 'NGN' ? '₦' : 'CFA'}</span>}
              <input id={`f-${k}`} className="input num" type="number" inputMode="decimal" disabled={!editable}
                min={d.min} max={d.max} step={d.type === 'percent' ? 0.1 : 1}
                value={String(v ?? '')} onChange={(e) => s.setDraft({ ...s.draft, [k]: e.target.value === '' ? '' : Number(e.target.value) })} />
              {d.type === 'percent' && <span>%</span>}
              {d.type === 'hours' && <span>hours</span>}
              {d.type === 'minutes' && <span>minutes</span>}
            </div>
          )}
          {d.type === 'minutes' && (
            <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
              {MINUTE_PICKS.map((n) => (
                <button key={n} type="button" className={`chip-btn${Number(v) === n ? ' on' : ''}`} disabled={!editable} onClick={() => s.setDraft({ ...s.draft, [k]: n })}>{minutesText(n)}</button>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

/** The bar that appears when something changed, and the confirm step (with a reason for the audit trail). */
function SaveBar({ s, keys, applies, confirmExtra }: { s: Draft; keys: string[]; applies: string; confirmExtra?: (s: Draft) => ReactNode }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const data = s.data!;
  const invalid = s.changed.find((k) => {
    const d = s.def(k); const v = s.draft[k];
    if (d?.type === 'bands') return !!bandsError(v as Band[]);
    return d && !['boolean', 'phone', 'email', 'social'].includes(d.type) && (v === '' || Number.isNaN(Number(v)) || (d.min != null && Number(v) < d.min) || (d.max != null && Number(v) > d.max));
  });
  return (
    <>
      <div className={`savebar${s.changed.length ? ' show' : ''}`} aria-hidden={!s.changed.length}>
        <div className="savebar-in">
          <span className="dot" />
          <span><b>{s.changed.length} unsaved change{s.changed.length === 1 ? '' : 's'}</b>{invalid ? <span className="savebar-err"> · {s.def(invalid)!.type === 'bands' ? `${s.def(invalid)!.label}: ${bandsError(s.draft[invalid] as Band[])}` : `${s.def(invalid)!.label} is out of range`}</span> : <span className="muted"> · {applies}</span>}</span>
          <span className="spacer" />
          <Button icon={RotateCcw} variant="ghost" onClick={() => s.setDraft(Object.fromEntries(keys.map((k) => [k, data.values[k]!])))} tabIndex={s.changed.length ? 0 : -1}>Discard</Button>
          <Button icon={Save} variant="primary" disabled={!!invalid} onClick={() => setConfirm(true)} tabIndex={s.changed.length ? 0 : -1}>Save changes</Button>
        </div>
      </div>
      {confirm && <ConfirmAction icon={Save} tone="gold" title={`Save ${s.changed.length} change${s.changed.length === 1 ? '' : 's'}?`} confirmLabel="Save changes"
        description="They apply from now on. Orders already running keep their fee and limits."
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

/** One page of values: rows on the left, an explainer on the right, a save bar when something changed. */
function ValuesPage({ title, lede, keys, aside, render, confirmExtra, applies = 'applies to new orders', stacked = [], after }: {
  applies?: string; stacked?: string[]; after?: ReactNode; title: string; lede: ReactNode; keys: string[]; aside?: (s: Draft) => ReactNode;
  render?: Partial<Record<string, (s: Draft, editable: boolean) => ReactNode>>; confirmExtra?: (s: Draft) => ReactNode;
}) {
  const { can } = useAuth();
  const s = useDraft(keys);
  const canEdit = (d?: Def) => can(d?.core ? 'settings.core' : 'settings.update');
  if (s.error) return <ErrorBanner error={s.error} onRetry={s.reload} />;
  if (s.loading || !s.data) return <div className="stack"><Skeleton h={44} w={320} /><div className="settings-grid"><Skeleton h={320} /><Skeleton h={220} /></div></div>;
  const lockedKeys = keys.filter((k) => !canEdit(s.def(k)));
  const lockedCore = lockedKeys.some((k) => s.def(k)?.core);

  return (
    <>
      <SectionHead title={title} lede={lede} />
      {lockedKeys.length > 0 && <div className="banner gold lock-banner"><Lock /><div>{lockedCore
        ? <><b>Owner only.</b> {lockedKeys.length === keys.length ? 'You can view these, but only an owner can change fees, limits and Hoolam\'s WhatsApp number.' : 'Items marked Owner are view only for you. Only an owner can change fees, limits and Hoolam\'s WhatsApp number.'}</>
        : 'You can see these settings, but your role can\'t change them.'}</div></div>}
      <div className={`settings-grid${aside ? '' : ' single'}`}>
        <section className="panel setting-list">
          {keys.map((k) => <SettingRow key={k} s={s} k={k} editable={canEdit(s.def(k))} custom={render?.[k]} stacked={stacked.includes(k)} />)}
        </section>
        {aside && <aside className="stack">{aside(s)}</aside>}
      </div>
      {after}
      <SaveBar s={s} keys={keys} applies={applies} confirmExtra={confirmExtra} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function feeOf(price: number, d: Record<string, Val>) {
  const p = Number(d.fee_rate_percent), mn = Number(d.fee_min), mx = Number(d.fee_max), r = Number(d.fee_round_to) || 1;
  let f = (price * p) / 100; f = Math.min(mx, Math.max(mn, f)); return Math.round(f / r) * r;
}

/** What's wrong with a band table, or null. Same rules as the server. */
function bandsError(b: Band[]): string | null {
  if (!Array.isArray(b) || !b.length) return 'add at least one band';
  let last = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    if (!Number.isFinite(x.fee) || x.fee < 0) return `band ${i + 1} needs a fee`;
    if (i === b.length - 1) break;
    if (x.upTo == null || !Number.isFinite(x.upTo) || x.upTo <= last) return `band ${i + 1}: "up to" must be bigger than the band before`;
    last = x.upTo;
  }
  return null;
}
const bandFee = (b: Band[], price: number) => { for (const x of b) if (x.upTo == null || price <= x.upTo) return x.fee; return b.at(-1)?.fee ?? 0; };

/** A band table that folds away under its heading: "up to" and the fee for each band; the last band is everything above. */
function BandsField({ s, k, editable }: { s: Draft; k: string; editable: boolean }) {
  const cur = s.data!.currency;
  const sym = cur === 'NGN' ? '₦' : 'CFA';
  const bands = (s.draft[k] as Band[]) ?? [];
  const m = (n: number) => money(n * (cur === 'NGN' ? 100 : 1), cur);
  const set = (i: number, patch: Partial<Band>) => s.setDraft({ ...s.draft, [k]: bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const num = (v: string) => (v === '' ? NaN : Number(v));
  return (
    <details className="bands" open={s.changed.includes(k) || undefined}>
      <summary><span>{bands.map((b) => m(b.fee)).join(' / ')}</span><ChevronDown className="bands-arrow" /></summary>
      <table className="bands-table">
        <thead><tr><th>Order total</th><th>Fee</th></tr></thead>
        <tbody>
          {bands.map((b, i) => {
            const from = i === 0 ? 0 : (bands[i - 1]!.upTo ?? 0) + 1;
            const last = i === bands.length - 1;
            return (
              <tr key={i}>
                <td>{last
                  ? <span className="muted">Above {m(bands[i - 1]?.upTo ?? 0)}</span>
                  : <label className="band-upto"><span className="muted small">{i === 0 ? 'Up to' : `${m(from)} to`}</span>
                      <span className="affix pre"><span>{sym}</span><input className="input num" type="number" inputMode="numeric" min={0} disabled={!editable}
                        aria-label={`Band ${i + 1}: up to`} value={Number.isFinite(b.upTo as number) ? String(b.upTo) : ''} onChange={(e) => set(i, { upTo: num(e.target.value) })} /></span></label>}
                </td>
                <td><span className="affix pre"><span>{sym}</span><input className="input num" type="number" inputMode="numeric" min={0} disabled={!editable}
                  aria-label={`Band ${i + 1}: fee`} value={Number.isFinite(b.fee) ? String(b.fee) : ''} onChange={(e) => set(i, { fee: num(e.target.value) })} /></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

export function FeesPage() {
  return <ValuesPage title="Fees" lede="Whoever starts the order pays Hoolam's fee. The other side pays a flat transaction fee, and only they see it."
    keys={['fee_rate_percent', 'fee_min', 'fee_max', 'fee_round_to', 'seller_txn_fee', 'buyer_txn_fee']}
    stacked={['seller_txn_fee', 'buyer_txn_fee']}
    render={{
      seller_txn_fee: (s, editable) => <BandsField s={s} k="seller_txn_fee" editable={editable} />,
      buyer_txn_fee: (s, editable) => <BandsField s={s} k="buyer_txn_fee" editable={editable} />,
    }}
    aside={(s) => <FeePreview s={s} />} />;
}
function FeePreview({ s }: { s: Draft }) {
  const [price, setPrice] = useState(25_000);
  const cur = s.data!.currency;
  const m = (n: number) => money(n * (cur === 'NGN' ? 100 : 1), cur);
  const fee = feeOf(price, s.draft);
  const sTxn = bandFee((s.draft.seller_txn_fee as Band[]) ?? [], price), bTxn = bandFee((s.draft.buyer_txn_fee as Band[]) ?? [], price);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Try it</h2><span className="right small muted">Updates as you type</span></div>
      <div className="panel-body stack" style={{ gap: 14 }}>
        <div className="affix pre big"><span>₦</span><input className="input num" type="number" inputMode="numeric" value={price || ''} aria-label="Item price" onChange={(e) => setPrice(Math.max(0, Number(e.target.value)))} /></div>
        <div className="fee-split">
          <div><span>Hoolam fee</span><b className="money">{price ? m(fee) : '—'}</b></div>
          <div><span>Buyer starts: buyer pays</span><b className="money">{price ? m(price + fee) : '—'}</b></div>
          <div><span>Buyer starts: seller gets</span><b className="money">{price ? m(price - sTxn) : '—'}</b></div>
          <div><span>Seller starts: buyer pays</span><b className="money">{price ? m(price + bTxn) : '—'}</b></div>
          <div><span>Seller starts: seller gets</span><b className="money">{price ? m(price - fee) : '—'}</b></div>
        </div>
        <div className="chips">{[5_000, 15_000, 50_000].map((p) => <button key={p} type="button" className={`chip-btn${p === price ? ' on' : ''}`} onClick={() => setPrice(p)}>{m(p)} → {m(feeOf(p, s.draft))}</button>)}</div>
        <p className="small muted">The website's fee calculator uses these same numbers.</p>
      </div>
    </section>
  );
}

export function LimitsPage() {
  return <ValuesPage title="Limits" lede="The most a single order can be without an ID check and once verified, and how many wrong handover codes a seller can enter." keys={['max_deal', 'max_deal_verified', 'handover_code_tries']}
    aside={() => (
      <section className="panel"><div className="panel-body stack" style={{ gap: 10 }}>
        <div className="aside-ic"><Gauge /></div>
        <h3>One person needs more?</h3>
        <p className="small muted">Raise the limit for a single buyer or seller on their page in <Link to="/people">Buyers &amp; sellers</Link>. Everyone else keeps this one.</p>
        <p className="small muted">Above the limit without ID, the person checks their BVN or NIN once in the chat, then carries on. People waiting for a rep are in <Link to="/people?kind=review">Needs review</Link>.</p>
        <p className="small muted">The website shows the limit without ID next to the fee calculator.</p>
      </div></section>
    )} />;
}

export function TimingPage() {
  return <ValuesPage title="Timing" lede="When Hoolam reminds people, and when an order comes to the team." keys={['seller_accept_hours', 'unpaid_close_hours', 'dispatch_remind_hours', 'auto_release_minutes', 'nudge_after_hours', 'flag_after_hours', 'rep_reply_minutes', 'problem_reply_hours']}
    aside={(s) => {
      const h = (k: string) => `${s.draft[k] || '—'} h`;
      return (
        <section className="panel">
          <div className="panel-head"><h2>How an order moves</h2></div>
          <div className="panel-body">
            <ol className="flowline">
              <li><span className="fl-ic"><Hourglass /></span><div><b>Someone starts an order</b><span>The other side has <em>{h('seller_accept_hours')}</em> to accept (the seller for a buyer's order, the buyer for a seller's), then it closes.</span></div></li>
              <li><span className="fl-ic"><Truck /></span><div><b>Buyer pays, seller dispatches</b><span>Not dispatched after <em>{h('dispatch_remind_hours')}</em>? We remind the seller.</span></div></li>
              <li><span className="fl-ic gold"><KeyRound /></span><div><b>Handover code entered</b><span>The rider is paid. The buyer checks the item.</span></div></li>
              <li><span className="fl-ic green"><CircleCheck /></span><div><b>Buyer is happy, or <em>{minutesText(Number(s.draft.auto_release_minutes))}</em> pass</b><span>The seller is paid. A problem freezes the money instead.</span></div></li>
              <li><span className="fl-ic red"><Flag /></span><div><b>No code, no answer</b><span>We ask the buyer after <em>{h('nudge_after_hours')}</em>; Needs action after <em>{h('flag_after_hours')}</em>.</span></div></li>
            </ol>
          </div>
        </section>
      );
    }} />;
}

/** What people type (0803…) → what's stored (2348…). Anything else is kept as typed, digits only. */
const storePhone = (typed: string) => { const d = typed.replace(/\D/g, '').slice(0, 15); return /^0\d{10}$/.test(d) ? '234' + d.slice(1) : d; };
/** What's stored → what the field shows (0803… for Nigerian numbers). */
const showPhone = (stored: string) => (/^234\d{10}$/.test(stored) ? '0' + stored.slice(3) : stored);

function PhoneField({ s, k, editable, emptyHint }: { s: Draft; k: string; editable: boolean; emptyHint: string }) {
  const v = String(s.draft[k] ?? '');
  const ok = /^[1-9]\d{7,14}$/.test(v);
  return (
    <div className="phone-field">
      <input id={`f-${k}`} className="input num" style={{ maxWidth: 240 }} inputMode="numeric" autoComplete="off" disabled={!editable} value={showPhone(v)} placeholder="07034577787"
        onChange={(e) => s.setDraft({ ...s.draft, [k]: storePhone(e.target.value) })} aria-describedby={`${k}-hint`} />
      <div id={`${k}-hint`} className={`small ${v && !ok ? 'err-text' : 'muted'}`}>
        {!v ? emptyHint : ok ? <>Shows as <b>{phoneText(v)}</b></> : 'That doesn\'t look like a full number yet. For example 07034577787.'}
      </div>
    </div>
  );
}

const SOCIAL_KEYS = ['company_instagram', 'company_tiktok', 'company_facebook', 'company_x', 'company_youtube', 'company_linkedin'];

export function ContactPage() {
  return <ValuesPage title="Contact & socials" lede="How people reach Hoolam. These show in the footer of the website and on every legal page."
    keys={['contact_email', 'contact_phone', ...SOCIAL_KEYS]} applies="the website refreshes in about a minute" stacked={['contact_email', 'contact_phone', ...SOCIAL_KEYS]}
    render={{ contact_phone: (s, editable) => <PhoneField s={s} k="contact_phone" editable={editable} emptyHint="Empty: the footer shows Hoolam's WhatsApp number." /> }}
    aside={(s) => {
      const filled = SOCIAL_KEYS.filter((k) => String(s.draft[k] ?? '').trim());
      const phone = String(s.draft.contact_phone || s.data!.values.whatsapp_number || '');
      return (
        <section className="panel">
          <div className="panel-head"><h2>In the footer</h2></div>
          <div className="panel-body stack" style={{ gap: 10 }}>
            <ul className="uses">
              <li><Building2 />HOOLAM DIGITAL PLATFORM LTD · RC 9919417<br />8, Delta Bakery Road, Woji, Rivers State</li>
              <li><Phone />{phone ? phoneText(phone) : 'No number yet'}{!s.draft.contact_phone && phone ? ' (WhatsApp)' : ''}</li>
              <li><Mail />{String(s.draft.contact_email || '—')}</li>
              {filled.map((k) => <li key={k}><AtSign />{s.def(k)!.label}: {String(s.draft[k])}</li>)}
            </ul>
            <p className="small muted">The company name, RC number and address come from the CAC registration and are fixed in the website. Socials left empty don't show.</p>
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
            <input id="f-whatsapp_number" className="input num" style={{ maxWidth: 240 }} inputMode="numeric" autoComplete="off" disabled={!editable} value={showPhone(v)} placeholder="07034577787"
              onChange={(e) => s.setDraft({ ...s.draft, whatsapp_number: storePhone(e.target.value) })} aria-describedby="wa-hint" />
            <div id="wa-hint" className={`small ${v && !ok ? 'err-text' : 'muted'}`}>
              {!v ? 'For example 07034577787.' : ok ? <>Shows as <b>{phoneText(v)}</b> · <a href={`https://wa.me/${v}`} target="_blank" rel="noopener">Open the chat <ArrowUpRight className="inline-ic" /></a></> : 'That doesn\'t look like a full number yet. For example 07034577787.'}
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
            <li><MessageCircle />Payment and order links sent to buyers and sellers</li>
          </ul>
          <div className="note"><Clock /><span>Changing it here updates links. It doesn't move your WhatsApp account: that's set on Meta, and on Render as <code>WHATSAPP_PHONE_NUMBER_ID</code>.</span></div>
        </div>
      </section>
    )} after={<><FormsPanel /><ChatMediaPanel /><TemplatesPanel /></>} />;
}

// ---------------------------------------------------------------------------------------------

interface FormRow { key: string; label: string; state: 'ready' | 'resting' | 'failed' | 'off'; name: string | null; mode: 'draft' | 'published' | null; reason: string | null; at: string | null; retryAt: string | null; backup: boolean }
const FORM_TONE: Record<FormRow['state'], 'green' | 'gold' | 'red' | 'grey'> = { ready: 'green', resting: 'gold', failed: 'red', off: 'grey' };
const FORM_WORD: Record<FormRow['state'], string> = { ready: 'Ready', resting: 'Resting', failed: 'Failed', off: 'Not set up' };

/** Each WhatsApp form: being sent (and as draft or published, as Meta says), resting after a refusal, or why not. */
function FormsPanel() {
  const q = useData<{ connected: boolean; formsOn: boolean; forms: FormRow[] }>('/whatsapp/forms');
  const [busy, setBusy] = useState(false);
  const { can } = useAuth();
  const toast = useToast();
  if (!q.data) return null;
  const rows = q.data.forms;
  const ready = rows.filter((r) => r.state === 'ready').length;
  const retry = async () => {
    setBusy(true);
    try { await post('/whatsapp/forms/retry'); q.reload(); toast({ kind: 'ok', title: 'Checked the forms with Meta' }); } finally { setBusy(false); }
  };
  return (
    <section className="panel tpl-panel">
      <div className="panel-head">
        <h2>WhatsApp forms</h2>
        <span className="right"><span className="small muted">{ready} of {rows.length} ready</span>
          {can('settings.update') && q.data.connected && <Button size="sm" variant="ghost" icon={RotateCcw} busy={busy} onClick={retry}>Try again now</Button>}</span>
      </div>
      <div className="panel-body stack" style={{ gap: 12 }}>
        <p className="small muted">Each form is sent the way Meta has it, draft or published. If WhatsApp refuses one, only that form rests for 30 minutes and is then tried again; meanwhile the chat asks the same questions, so nobody gets stuck. New forms are published on Meta when the server starts; if Meta won't publish one yet, it's sent as a draft and its card says why.</p>
        {!q.data.formsOn && <div className="banner gold small"><AlertTriangle /><div>The <b>WhatsApp forms</b> switch above is off, so everyone answers in the chat.</div></div>}
        <ul className="tpl-list">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="tpl-top"><b>{r.label}</b><Pill tone={FORM_TONE[r.state]}>{r.state === 'ready' && r.mode ? `Ready · ${r.mode}` : FORM_WORD[r.state]}</Pill></div>
              {r.reason && <p className="tpl-body">{r.state === 'resting' ? 'WhatsApp refused it: ' : ''}{r.reason}</p>}
              <p className="small muted" style={{ margin: 0 }}>
                {r.state === 'resting' && r.retryAt ? <>Tried again at {new Date(r.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. </> : null}
                {r.name ? <code>{r.name}</code> : null}{r.backup ? ' · backup version' : ''}{r.at ? ` · since ${ago(r.at)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

interface TemplateRow { name: string; label: string; body: string; buttons: string[]; status: string | null }
const TPL_TONE: Record<string, 'green' | 'gold' | 'red' | 'grey'> = { APPROVED: 'green', PENDING: 'gold', IN_APPEAL: 'gold', REJECTED: 'red', PAUSED: 'red', DISABLED: 'red' };

/** The messages Hoolam may start when someone hasn't written in 24 hours, and whether Meta has approved each. */
function TemplatesPanel() {
  const q = useData<{ connected: boolean; templates: TemplateRow[] }>('/whatsapp/templates');
  const [busy, setBusy] = useState(false);
  const { can } = useAuth();
  if (!q.data) return null;
  const rows = q.data.templates;
  const approved = rows.filter((r) => r.status === 'APPROVED').length;
  const refresh = async () => { setBusy(true); try { await post('/whatsapp/templates/refresh'); q.reload(); } finally { setBusy(false); } };
  return (
    <section className="panel tpl-panel">
      <div className="panel-head">
        <h2>Messages Hoolam starts</h2>
        <span className="right"><span className="small muted">{approved} of {rows.length} approved</span>
          {can('settings.update') && q.data.connected && <Button size="sm" variant="ghost" icon={RotateCcw} busy={busy} onClick={refresh}>Check Meta</Button>}</span>
      </div>
      <div className="panel-body stack" style={{ gap: 12 }}>
        <p className="small muted">WhatsApp only lets Hoolam message someone who hasn't written in the last 24 hours with a message Meta approved in advance. The server submits these on start and uses each one as soon as it's approved; until then those updates wait in Needs action. They also need a payment method on the WhatsApp account in Meta. Shown with example details.</p>
        {!q.data.connected && <div className="banner gold small"><AlertTriangle /><div>Not connected to Meta yet: set <code>WHATSAPP_WABA_ID</code> on Render (and turn off dry run) so the server can submit them.</div></div>}
        <ul className="tpl-list">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="tpl-top"><b>{r.label}</b><Pill tone={TPL_TONE[r.status ?? ''] ?? 'grey'}>{r.status ? r.status.toLowerCase().replace(/_/g, ' ') : 'not submitted'}</Pill></div>
              <p className="tpl-body">{r.body}</p>
              {r.buttons.length > 0 && <div className="tpl-btns">{r.buttons.map((b) => <span key={b}>{b}</span>)}</div>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

/** The ambassador programme's settings, in the order and groups they show under its card. */
const AMB_GROUPS: { title: string; help: string; keys: string[] }[] = [
  { title: 'Earnings', help: 'What ambassadors earn. Changes apply to orders completed from now on. You can set a different share for one ambassador on their page.', keys: ['amb_seller_pct', 'amb_buyer_pct', 'amb_seller_bonus', 'amb_bonus_orders'] },
  { title: 'Payouts', help: 'When and from how much we pay them.', keys: ['amb_payout_day', 'amb_payout_min'] },
  { title: 'Terms', help: 'The terms they can choose. It rolls over by itself; whatever the term, their share can grow with what they bring.', keys: ['amb_term_3', 'amb_term_6', 'amb_term_12', 'amb_notice_days'] },
  { title: 'Joining', help: 'Where people can apply, and who sees "Become an ambassador" in WhatsApp.', keys: ['amb_apply_web', 'amb_apply_whatsapp', 'amb_menu_after'] },
];

/**
 * Settings → Features: things the owner turns on when they're ready. Each is a compact card with its switch;
 * a feature's own settings (and anything else about it) sit under it, folded away until opened.
 * Counting and the like keep running while a feature is off.
 */
export function FeaturesPage() {
  const { can } = useAuth();
  const keys = ['feature_seller_stats', 'feature_ambassadors', ...AMB_GROUPS.flatMap((g) => g.keys), 'feature_site_numbers', ...SITE_NUMBERS.map((x) => x.key), 'feature_about_founder', 'feature_seller_video'];
  const s = useDraft(keys);
  if (s.error) return <ErrorBanner error={s.error} onRetry={s.reload} />;
  if (s.loading || !s.data) return <div className="stack"><Skeleton h={44} w={320} /><Skeleton h={120} /><Skeleton h={120} /></div>;
  const editable = can('settings.core');
  const on = (k: string) => !!(s.draft[k] ?? s.data!.values[k]);
  return (
    <>
      <SectionHead title="Features" lede="Turn new things on when you're ready for people to see them." />
      {!editable && <div className="banner gold lock-banner"><Lock /><div><b>Owner only.</b> You can see these, but only an owner can turn features on or off and change their settings.</div></div>}
      <div className="features">
        <FeatureCard s={s} k="feature_seller_stats" icon={BarChart3} title="Seller page stats" editable={editable}
          line="Page views and Buy taps on sellers' public pages, for sellers and (from 50 views) for buyers."
          more="Details" open={on('feature_seller_stats')}>
          <div className="feature-more-body stack" style={{ gap: 10 }}>
            <p className="small muted">Views of sellers' public pages and taps on their <b>Buy</b> button are always counted, on our own server: daily totals only, never who the visitor was.</p>
            <p className="small muted"><b>On:</b> sellers see their last 30 days under <b>My page</b> in WhatsApp. Buyers see a seller's page views on their public page and trust card once the page has <b>50</b> or more. <b>Off:</b> nobody sees the numbers; turn it on any time and the full history shows.</p>
            <TopSellerPages />
          </div>
        </FeatureCard>
        <FeatureCard s={s} k="feature_ambassadors" icon={Megaphone} title="Ambassadors" editable={editable}
          line="People you approve bring new sellers and buyers, and earn a share of what Hoolam makes on their orders."
          more="Settings" open={on('feature_ambassadors')}
          link={<Link className="btn sm ghost" to="/ambassadors">Manage ambassadors<ArrowUpRight /></Link>}>
          <div className="feature-groups">
            {AMB_GROUPS.map((g) => (
              <div key={g.title} className="feature-group">
                <div className="fg-head"><h3>{g.title}</h3><p>{g.help}</p></div>
                <div className="setting-list">{g.keys.map((k) => <SettingRow key={k} s={s} k={k} editable={editable} />)}</div>
              </div>
            ))}
          </div>
        </FeatureCard>
        <FeatureCard s={s} k="feature_seller_video" icon={Clapperboard} title="Seller videos" editable={editable}
          line="Sellers send a short video in WhatsApp; once you approve it, buyers see and hear them on their page."
          more="Videos" open={on('feature_seller_video')}>
          <SellerVideos />
        </FeatureCard>
        <FeatureCard s={s} k="feature_about_founder" icon={UserRound} title="Who's behind Hoolam on About" editable={editable}
          line="Your photo, name, a one-line promise and your voice note on the About page."
          more="What it needs" open={on('feature_about_founder')}>
          <div className="feature-more-body stack" style={{ gap: 8 }}>
            <p className="small muted">Upload your photo in <Link to="/settings/brand">Brand → Your photo</Link> (until then your initial shows) and the voice note <b>Website: why I built Hoolam</b> in <Link to="/settings/whatsapp">WhatsApp → Chat pictures and voice</Link> (the play button shows once it's there). The website updates within a few minutes.</p>
          </div>
        </FeatureCard>
        <FeatureCard s={s} k="feature_site_numbers" icon={BadgeCheck} title="Live numbers on the website" editable={editable}
          line="Real counts from your orders, like “orders completed safely”. Each one shows only once it reaches its minimum."
          more="Numbers" open={on('feature_site_numbers')}>
          <SiteNumbers s={s} editable={editable} />
        </FeatureCard>
      </div>
      <SaveBar s={s} keys={keys} applies="applies right away" />
    </>
  );
}

/** The website's live numbers: each with its count today, its minimum, and whether the website shows it now. */
const SITE_NUMBERS: { key: string; count: 'completed' | 'started' | 'refunded' | 'ambPaid'; label: string; where: string; isMoney?: boolean }[] = [
  { key: 'site_min_completed', count: 'completed', label: 'Orders completed safely', where: 'Home and About' },
  { key: 'site_min_started', count: 'started', label: 'Orders started', where: 'Home' },
  { key: 'site_min_refunded', count: 'refunded', label: 'Buyers refunded in full', where: 'Home and About' },
  { key: 'site_min_amb_paid', count: 'ambPaid', label: 'Paid to ambassadors', where: 'Ambassadors page', isMoney: true },
];
function SiteNumbers({ s, editable }: { s: Draft; editable: boolean }) {
  const q = useData<{ counts: Record<string, number>; shown: Record<string, number | null> }>('/site-numbers');
  const fmt = (n: number, isMoney?: boolean) => isMoney ? money(n * 100) : n.toLocaleString('en-NG');
  return (
    <div className="feature-more-body stack" style={{ gap: 12 }}>
      <p className="small muted">Counted from real orders; test orders never count. A number below its minimum stays hidden, so a young business never shows a small number. The website checks for new counts every few minutes.</p>
      <ul className="sn-list">
        {SITE_NUMBERS.map((x) => {
          const n = q.data?.counts[x.count] ?? null;
          const min = Number(s.draft[x.key] ?? s.data!.values[x.key] ?? 0);
          const showing = n !== null && n > 0 && n >= min;
          return (
            <li key={x.key} className={showing ? 'on' : ''}>
              <div className="sn-top"><b>{x.label}</b><span className={`pill plain ${showing ? 'green' : 'grey'}`}>{showing ? 'Showing' : 'Hidden'}</span></div>
              <div className="sn-now"><span className="sn-n">{n === null ? '…' : fmt(n, x.isMoney)}</span><span className="small muted">now · {x.where}</span></div>
              {n !== null && !showing && <div className="sn-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (n / Math.max(1, min)) * 100)}%` }} /></div>}
              <span className="small muted">{showing ? 'Visitors see it.' : n === null ? '' : `Shows from ${fmt(min, x.isMoney)}${n > 0 ? `: ${fmt(Math.max(0, min - n), x.isMoney)} to go` : ''}.`}</span>
            </li>
          );
        })}
      </ul>
      <div className="feature-group">
        <div className="fg-head"><h3>When each one shows</h3><p>Pick numbers you'd be proud to show.</p></div>
        <div className="setting-list">{SITE_NUMBERS.map((x) => <SettingRow key={x.key} s={s} k={x.key} editable={editable} />)}</div>
      </div>
    </div>
  );
}

/** A feature: icon, name, one line and its switch; once on, its settings fold out under "Settings" (closed to start). */
function FeatureCard({ s, k, icon: Icon, title, line, editable, more, open, link, children }: {
  s: Draft; k: string; icon: typeof BarChart3; title: string; line: string; editable: boolean; more: string; open: boolean; link?: ReactNode; children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const v = !!(s.draft[k] ?? s.data!.values[k]);
  const changed = s.changed.includes(k);
  const upd = s.data!.updated[k];
  return (
    <section className={`panel feature${v ? ' on' : ''}${changed ? ' changed' : ''}`}>
      <div className="feature-head">
        <div className="feature-ic"><Icon /></div>
        <div className="feature-text">
          <h2>{title}{v ? <span className="pill green plain">On</span> : <span className="pill grey plain">Off</span>}</h2>
          <p>{line}</p>
          <span className="sr-meta">{changed ? <>Was {s.data!.values[k] ? 'on' : 'off'}: save to apply</> : upd ? `Changed by ${upd.by ?? 'someone'} ${ago(upd.at)}` : v ? 'On from the start' : 'Off until you turn it on'}</span>
        </div>
        <Switch on={v} onChange={(x) => editable && s.setDraft({ ...s.draft, [k]: x })} label={title} />
      </div>
      {open && (
        <div className="feature-foot">
          <button type="button" className="feature-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}><ChevronDown className={shown ? 'up' : ''} />{more}</button>
          {link}
        </div>
      )}
      {open && shown && <div className="feature-more">{children}</div>}
    </section>
  );
}

const compact = (n: number) => n < 1000 ? String(n) : n < 1_000_000 ? `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k` : `${(Math.floor(n / 100_000) / 10).toFixed(1).replace(/\.0$/, '')}m`;

/** The most-viewed sellers' public pages, last 30 days. */
function TopSellerPages() {
  const q = useData<{ rows: { userId: string; name: string; slug: string | null; isPublic: boolean; views30: number; buys30: number }[]; shown: boolean }>('/seller-pages/top');
  if (!q.data) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Most-viewed seller pages</h2><span className="right small muted">Last 30 days</span></div>
      {!q.data.rows.length ? <div className="panel-body"><p className="small muted">No views yet. Pages start counting as soon as sellers share their link.</p></div> : (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Seller</th><th className="r">Views</th><th className="r">Tapped Buy</th></tr></thead>
          <tbody>{q.data.rows.map((r) => (
            <tr key={r.userId}>
              <td><Link to={`/people/${r.userId}`}>{r.name}</Link>{r.slug && <div className="cell-sub">/s/{r.slug}{!r.isPublic && ' · hidden now'}</div>}</td>
              <td className="r"><span className="row" style={{ gap: 5, justifyContent: 'flex-end' }}><Eye style={{ width: 14, height: 14 }} className="faint" />{compact(r.views30)}</span></td>
              <td className="r">{compact(r.buys30)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function SecurityPage() {
  return <ValuesPage title="Security" lede="How the team signs in to the console." keys={['two_step_login']} applies="applies from the next sign-in"
    confirmExtra={(s) => s.draft.two_step_login === true
      ? <p className="small">From the next sign-in, everyone needs the 6-digit code from their authenticator app. Anyone without one is shown a QR code to set it up after their password. People already signed in stay signed in.</p>
      : <p className="small">From the next sign-in, the email and password are enough. Everyone's authenticator stays set up for when you turn this back on. People already signed in stay signed in.</p>}
    aside={(s) => (
      <section className="panel"><div className="panel-body stack" style={{ gap: 10 }}>
        <div className="aside-ic"><KeyRound /></div>
        <h3>{s.draft.two_step_login ? 'Email, password and a code' : 'Email and password'}</h3>
        {s.draft.two_step_login
          ? <p className="small muted">The code changes every 30 seconds in Google Authenticator, Microsoft Authenticator or any authenticator app, so a stolen password alone can't get in.</p>
          : <p className="small muted">Quicker for the team, but anyone with a teammate's password can sign in. Turn the code on before more people join, or if a password may have leaked.</p>}
        <p className="small muted">Either way: 5 wrong passwords lock the account for a while, sessions end after 12 idle hours, and every sign-in is in the <Link to="/audit">audit trail</Link>. Lost a password or phone? <Link to="/team">Team</Link> → Reset login sends a new invite link.</p>
      </div></section>
    )} />;
}
