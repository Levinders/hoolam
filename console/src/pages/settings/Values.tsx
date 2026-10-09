import { AlertTriangle, ArrowUpRight, AtSign, BellRing, Building2, Mail, Phone, Gauge, CircleCheck, Clock, Flag, Hourglass, Lock, MessageCircle, RotateCcw, Save, Truck } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { post, put } from '../../api';
import { useAuth } from '../../auth';
import { ago, money } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, ErrorBanner, Pill, Skeleton, Switch, useToast } from '../../ui';
import { SectionHead, useUnsaved } from '../Settings';

type Val = number | boolean | string;
export type Def = { key: string; group: string; label: string; help: string; type: 'number' | 'money' | 'percent' | 'hours' | 'boolean' | 'phone' | 'email' | 'social'; min?: number; max?: number; core?: boolean; optional?: boolean; social?: string };
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
  if (v === '' || v == null) return 'Not set';
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
function ValuesPage({ title, lede, keys, aside, render, confirmExtra, applies = 'applies to new deals', stacked = [], after }: {
  applies?: string; stacked?: string[]; after?: ReactNode; title: string; lede: ReactNode; keys: string[]; aside?: (s: Draft) => ReactNode;
  render?: Partial<Record<string, (s: Draft, editable: boolean) => ReactNode>>; confirmExtra?: (s: Draft) => ReactNode;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const s = useDraft(keys);
  const [confirm, setConfirm] = useState(false);
  const canEdit = (d?: Def) => can(d?.core ? 'settings.core' : 'settings.update');
  if (s.error) return <ErrorBanner error={s.error} onRetry={s.reload} />;
  if (s.loading || !s.data) return <div className="stack"><Skeleton h={44} w={320} /><div className="settings-grid"><Skeleton h={320} /><Skeleton h={220} /></div></div>;
  const data = s.data;
  const lockedKeys = keys.filter((k) => !canEdit(s.def(k)));
  const lockedCore = lockedKeys.some((k) => s.def(k)?.core);
  const invalid = s.changed.find((k) => { const d = s.def(k); const v = s.draft[k]; return d && !['boolean', 'phone', 'email', 'social'].includes(d.type) && (v === '' || Number.isNaN(Number(v)) || (d.min != null && Number(v) < d.min) || (d.max != null && Number(v) > d.max)); });

  return (
    <>
      <SectionHead title={title} lede={lede} />
      {lockedKeys.length > 0 && <div className="banner gold lock-banner"><Lock /><div>{lockedCore
        ? <><b>Owner only.</b> {lockedKeys.length === keys.length ? 'You can view these, but only an owner can change fees, limits and Hoolam\'s WhatsApp number.' : 'Items marked Owner are view only for you. Only an owner can change fees, limits and Hoolam\'s WhatsApp number.'}</>
        : 'You can see these settings, but your role can\'t change them.'}</div></div>}
      <div className={`settings-grid${aside ? '' : ' single'}`}>
        <section className="panel setting-list">
          {keys.map((k) => {
            const d = s.def(k)!;
            const v = s.draft[k] ?? data.values[k]!;
            const upd = data.updated[k];
            const isChanged = s.changed.includes(k);
            const custom = render?.[k];
            const editable = canEdit(d);
            return (
              <div key={k} className={`setting-row${isChanged ? ' changed' : ''}${d.type === 'boolean' ? ' toggle' : ''}${stacked.includes(k) ? ' stacked' : ''}`}>
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
                      </div>
                    )}
                </div>
              </div>
            );
          })}
        </section>
        {aside && <aside className="stack">{aside(s)}</aside>}
      </div>
      {after}

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

function PhoneField({ s, k, editable, emptyHint }: { s: Draft; k: string; editable: boolean; emptyHint: string }) {
  const v = String(s.draft[k] ?? '');
  const ok = /^[1-9]\d{7,14}$/.test(v);
  return (
    <div className="phone-field">
      <div className="affix pre big"><span>+</span>
        <input id={`f-${k}`} className="input num" inputMode="numeric" autoComplete="off" disabled={!editable} value={v} placeholder="2348012345678"
          onChange={(e) => s.setDraft({ ...s.draft, [k]: e.target.value.replace(/\D/g, '').slice(0, 15) })} aria-describedby={`${k}-hint`} />
      </div>
      <div id={`${k}-hint`} className={`small ${v && !ok ? 'err-text' : 'muted'}`}>
        {!v ? emptyHint : ok ? <>Shows as <b>{phoneText(v)}</b></> : v.startsWith('0') ? 'Start with the country code (234 for Nigeria), not 0.' : 'That doesn\'t look like a full number yet.'}
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
    )} after={<TemplatesPanel />} />;
}

// ---------------------------------------------------------------------------------------------

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
