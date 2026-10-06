import { Check, ChevronLeft, ChevronRight, LoaderCircle, ScrollText, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { initials, PAYOUT, STATUS, type Tone } from '../format';

// ---------------------------------------------------------------------------------------------
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#0E5C63" />
      <path d="M32 12l17 6.5V32c0 11-7.4 17.8-17 21-9.6-3.2-17-10-17-21V18.5z" fill="#C9992E" />
      <path d="M24 33l6 6 11-12" stroke="#FAFAF7" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'danger solid' | 'ghost'; size?: 'sm' | 'lg'; icon?: LucideIcon; busy?: boolean };
export function Button({ variant, size, icon: Icon, busy, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button className={['btn', variant, size, className].filter(Boolean).join(' ')} disabled={disabled || busy} {...rest}>
      {busy ? <LoaderCircle className="spin" /> : Icon ? <Icon /> : null}
      {children}
    </button>
  );
}

export function Pill({ tone = 'grey', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`pill ${tone}${plain ? ' plain' : ''}`}>{children}</span>;
}
export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'grey' as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}
export function PayoutPill({ status }: { status: string }) {
  const s = PAYOUT[status] ?? { label: status, tone: 'grey' as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}
export function Avatar({ name, gold }: { name?: string | null; gold?: boolean }) {
  return <span className={`avatar${gold ? ' gold' : ''}`} aria-hidden="true">{initials(name)}</span>;
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skel" style={{ height: h, width: w, ...style }} />;
}
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row" style={{ gap: 14 }}>
          <Skeleton h={34} w={34} style={{ borderRadius: 10 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Skeleton h={12} w={`${40 + ((i * 17) % 35)}%`} />
            <Skeleton h={10} w={`${25 + ((i * 23) % 40)}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ei"><Icon /></div>
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="banner red" role="alert">
      <TriangleAlert />
      <div style={{ flex: 1 }}>{error}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; n?: number }[] }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}{o.n != null && <span className="n">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return total ? <div className="pager">{total} {total === 1 ? 'result' : 'results'}</div> : null;
  const last = Math.ceil(total / pageSize);
  return (
    <div className="pager">
      <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
      <span className="spacer" />
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft /></button>
      <button className="btn sm" disabled={page >= last} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight /></button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Toasts
type Toast = { id: number; title: string; body?: string; kind: 'ok' | 'error'; out?: boolean };
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((x) => x.map((y) => (y.id === id ? { ...y, out: true } : y))), t.kind === 'error' ? 6500 : 3800);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.kind === 'error' ? 6800 : 4100);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}${t.out ? ' out' : ''}`}>
            <span className="ti">{t.kind === 'error' ? <X /> : <Check />}</span>
            <div><b>{t.title}</b>{t.body && <span className="small">{t.body}</span>}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// Modal
export function Modal({ onClose, children, wide, label }: { onClose: () => void; children: ReactNode; wide?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('textarea, input, select, button.primary, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

/**
 * The confirm step for anything that changes money or people: says exactly what will happen,
 * asks for a reason (it goes in the audit trail), and shows the server's answer if it refuses.
 */
export function ConfirmAction(props: {
  title: string; description: ReactNode; confirmLabel: string; icon: LucideIcon; tone?: 'danger' | 'gold' | 'teal';
  needReason?: boolean; reasonPlaceholder?: string; extra?: ReactNode; extraValid?: boolean;
  onConfirm: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needReason = props.needReason !== false;
  const ok = (!needReason || reason.trim().length >= 4) && props.extraValid !== false;
  const Icon = props.icon;
  const submit = async () => {
    if (!ok) return;
    setBusy(true); setErr(null);
    try { await props.onConfirm(reason.trim()); props.onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={props.onClose} label={props.title}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="modal-head">
          <div className={`mi ${props.tone === 'danger' ? 'danger' : props.tone === 'gold' ? 'gold' : ''}`}><Icon /></div>
          <div><h2>{props.title}</h2><p>{props.description}</p></div>
        </div>
        <div className="modal-body">
          {props.extra}
          {needReason && (
            <div className="field">
              <label htmlFor="reason">Reason</label>
              <textarea id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={props.reasonPlaceholder ?? 'What happened, and why this is the right call'} rows={3} />
            </div>
          )}
          <div className="audit-note"><ScrollText />Saved to the audit trail with your name and the time.</div>
          {err && <ErrorBanner error={err} />}
        </div>
        <div className="modal-foot">
          <Button type="button" variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant={props.tone === 'danger' ? 'danger solid' : 'primary'} busy={busy} disabled={!ok}>{props.confirmLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Charts (hand-drawn SVG so they match the brand exactly)
export function AreaChart({ data, value, label, format }: { data: { day: string }[]; value: (d: any) => number; label?: string; format: (n: number) => string }) {
  const W = 640, H = 220, P = { l: 52, r: 12, t: 12, b: 26 };
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const vals = data.map(value);
  const max = Math.max(1, ...vals);
  const nice = niceMax(max);
  const x = (i: number) => P.l + (i * (W - P.l - P.r)) / Math.max(1, data.length - 1);
  const y = (v: number) => P.t + (1 - v / nice) * (H - P.t - P.b);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(vals.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
  const ticks = [0, nice / 2, nice];
  const labelEvery = Math.ceil(data.length / 6);
  return (
    <div ref={wrap} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(data.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (data.length - 1)))));
        }}>
        <defs>
          <linearGradient id="hoolam-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0E5C63" stopOpacity=".18" />
            <stop offset="100%" stopColor="#0E5C63" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={P.l - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => i % labelEvery === 0 && (
          <text key={d.day} className="axis" x={x(i)} y={H - 6} textAnchor="middle">{shortDay(d.day)}</text>
        ))}
        <path className="area" d={area} />
        <path className="line" d={line} />
        {hover != null && <>
          <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="#C9992E" strokeDasharray="3 3" />
          <circle cx={x(hover)} cy={y(vals[hover]!)} r="4.5" fill="#fff" stroke="#0E5C63" strokeWidth="2.25" />
        </>}
      </svg>
      {hover != null && wrap.current && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(vals[hover]!) / H) * 100}%` }}>
          <b>{format(vals[hover]!)}</b> · {shortDay(data[hover]!.day)}
        </div>
      )}
    </div>
  );
}

export function BarChart({ data, value, format, label }: { data: { day: string }[]; value: (d: any) => number; format: (n: number) => string; label?: string }) {
  const W = 640, H = 180, P = { l: 40, r: 8, t: 10, b: 24 };
  const [hover, setHover] = useState<number | null>(null);
  const vals = data.map(value);
  const nice = niceMax(Math.max(1, ...vals));
  const bw = (W - P.l - P.r) / data.length;
  const y = (v: number) => P.t + (1 - v / nice) * (H - P.t - P.b);
  const labelEvery = Math.ceil(data.length / 6);
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg className="chart" style={{ height: 180 }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {[0, nice].map((t) => (
          <g key={t}>
            <line className="grid-line" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={P.l - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {vals.map((v, i) => (
          <rect key={i} className={`bar${hover === i ? ' hot' : ''}`} x={P.l + i * bw + bw * 0.18} width={bw * 0.64} y={y(v)} height={Math.max(0, H - P.b - y(v))} rx={Math.min(4, bw * 0.2)}
            onMouseEnter={() => setHover(i)} />
        ))}
        {data.map((d, i) => i % labelEvery === 0 && <text key={d.day} className="axis" x={P.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">{shortDay(d.day)}</text>)}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${((P.l + hover * bw + bw / 2) / W) * 100}%`, top: `${(y(vals[hover]!) / H) * 100}%` }}>
          <b>{format(vals[hover]!)}</b> · {shortDay(data[hover]!.day)}
        </div>
      )}
    </div>
  );
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function shortDay(day: string) {
  return new Date(day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Copy-to-clipboard with a tick for feedback. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  }, []);
  return useMemo(() => ({ copied, copy }), [copied, copy]);
}
