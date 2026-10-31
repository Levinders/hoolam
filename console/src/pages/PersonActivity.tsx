import { ChevronDown, Compass, FileText, Hand, History, MessageSquare, Package, Send, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ACTIONS, ago, dateOnly, sourceText, STATUS } from '../format';
import { Button, Empty, ErrorBanner, Seg, SkeletonRows } from '../ui';

/**
 * A person's activity: what they did in the chat (taps, messages, forms), their orders' steps, what Hoolam sent them
 * and whether they read it, and the team's actions. Newest first, by day, each line opens for the details.
 */
type Filter = 'all' | 'taps' | 'messages' | 'forms' | 'orders' | 'sent' | 'team';
type Item = { id: string; at: string; kind: 'tap' | 'message' | 'form' | 'screen' | 'order' | 'sent' | 'team' | 'source'; title: string; detail: Record<string, any> };
type Page = { items: Item[]; more: boolean; next: string | null; summary: { firstSeen: string; lastActive: string | null; today: number; week: number; tapsWeek: number } | null };

const ICON: Record<Item['kind'], LucideIcon> = { tap: Hand, screen: Smartphone, message: MessageSquare, form: FileText, order: Package, sent: Send, team: ShieldCheck, source: Compass };
const TZ = 'Africa/Lagos';
const time = (at: string) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayKey = (at: string) => new Date(at).toLocaleDateString('en-CA', { timeZone: TZ });
function dayLabel(key: string) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: key.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' });
}
const SENT_STATUS: Record<string, string> = { READ: 'Read', DELIVERED: 'Delivered', SENT: 'Sent', FAILED: 'Not delivered', NEEDS_TEMPLATE: 'Waiting (24-hour rule)', DRY_RUN: 'Test' };

/** WhatsApp's own formatting (*bold*, _italic_, ~strike~) as it looks in the chat. */
const plain = (t: string) => t.replace(/[*_~]([^*_~\n]+)[*_~]/g, '$1');
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return <>{parts.map((p, i) => /^\*.+\*$/.test(p) ? <b key={i}>{p.slice(1, -1)}</b> : /^_.+_$/.test(p) ? <i key={i}>{p.slice(1, -1)}</i> : /^~.+~$/.test(p) ? <s key={i}>{p.slice(1, -1)}</s> : p)}</>;
}

function title(i: Item): string {
  if (i.kind === 'source') return `Source: ${sourceText(i.title, i.detail)}`;
  if (i.kind === 'order') return `${i.detail.code} · ${i.detail.to === 'STARTED' ? `Order started by ${i.detail.by}` : STATUS[i.detail.to]?.label ?? i.detail.to}`;
  if (i.kind === 'team') return `${i.detail.by}: ${ACTIONS[i.title] ?? i.title.replace(/[._]/g, ' ')}`;
  if (i.kind === 'sent') return `Hoolam: ${plain(i.title)}`;
  return plain(i.title);
}

export function PersonActivity({ id }: { id: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const load = async (before: string | null) => {
    setBusy(true); setError(null);
    try {
      const p = await api<Page>(`/people/${id}/activity?filter=${filter}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      setPages((x) => (before ? [...x, p] : [p]));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { setPages([]); load(null); }, [id, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = pages.flatMap((p) => p.items);
  const summary = pages[0]?.summary ?? null;
  const last = pages.at(-1);
  const days: [string, Item[]][] = [];
  for (const i of items) { const k = dayKey(i.at); const d = days.at(-1); if (d && d[0] === k) d[1].push(i); else days.push([k, [i]]); }
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <section className="panel">
      {summary && (
        <div className="act-sum">
          <div><span>Last active</span><b>{summary.lastActive ? ago(summary.lastActive) : 'Not yet'}</b></div>
          <div><span>Today</span><b>{summary.today}</b></div>
          <div><span>This week</span><b>{summary.week}</b></div>
          <div><span>On Hoolam since</span><b>{dateOnly(summary.firstSeen)}</b></div>
        </div>
      )}
      <div className="toolbar mk-tabs">
        <Seg value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'taps', label: 'Taps' }, { value: 'messages', label: 'Messages' }, { value: 'forms', label: 'Forms' },
          { value: 'orders', label: 'Orders' }, { value: 'sent', label: 'Hoolam sent' }, { value: 'team', label: 'Team' },
        ]} />
      </div>
      {error ? <div className="panel-body"><ErrorBanner error={error} onRetry={() => load(null)} /></div>
        : !pages.length ? <SkeletonRows rows={6} />
        : !items.length ? <Empty icon={History} title="Nothing here yet">What they tap, send and fill in on WhatsApp shows here as it happens.</Empty>
        : (
          <div className="act">
            {days.map(([k, list]) => (
              <div key={k} className="act-day">
                <h3>{dayLabel(k)}</h3>
                <ol>
                  {list.map((i) => {
                    const Icon = ICON[i.kind];
                    const d = i.detail ?? {};
                    const answers = d.answers && typeof d.answers === 'object' ? Object.entries(d.answers as Record<string, unknown>) : [];
                    const has = !!(d.text || d.place || d.note || d.reason || answers.length || d.code || d.listing || d.item || d.status);
                    const isOpen = open.has(i.id);
                    return (
                      <li key={i.id} className={`act-row k-${i.kind}${isOpen ? ' open' : ''}`}>
                        <button type="button" className="act-line" onClick={() => has && toggle(i.id)} aria-expanded={has ? isOpen : undefined} disabled={!has}>
                          <time dateTime={i.at} title={new Date(i.at).toLocaleString('en-GB', { timeZone: TZ })}>{time(i.at)}</time>
                          <span className="act-ic"><Icon /></span>
                          <span className="act-t">{title(i)}{i.kind === 'sent' && d.status && <em className={`act-st ${String(d.status).toLowerCase()}`}>{SENT_STATUS[d.status] ?? d.status}</em>}</span>
                          {has && <ChevronDown className="act-chev" />}
                        </button>
                        {isOpen && (
                          <div className="act-more">
                            {d.text && <p className="act-text"><Rich text={String(d.text)} /></p>}
                            {d.place && <p className="act-text">📍 {d.place}</p>}
                            {d.buttons?.length ? <p className="small muted">Buttons: {d.buttons.join(' · ')}</p> : null}
                            {answers.length > 0 && <dl className="act-kv">{answers.map(([k2, v]) => <div key={k2}><dt>{k2.replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></div>)}</dl>}
                            {i.kind === 'order' && <p className="small muted">{d.item} · as {d.role}{d.from ? ` · from ${STATUS[d.from]?.label ?? d.from}` : ''}{d.by && d.to !== 'STARTED' ? ` · by ${d.by}` : ''}{d.note ? ` · ${d.note}` : ''}</p>}
                            {d.reason && <p className="small">Reason: {d.reason}</p>}
                            {d.note && i.kind !== 'order' && <p className="small muted">{d.note}</p>}
                            <div className="row" style={{ gap: 8 }}>
                              {d.code && <Link className="btn sm ghost" to={`/deals/${d.code}`}><Package />{d.code}</Link>}
                              {d.listing && <Link className="btn sm ghost" to={`/market?tab=items`}>Market item #{d.listing}</Link>}
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
            {last?.more && last.next && <div className="panel-body" style={{ textAlign: 'center' }}><Button busy={busy} onClick={() => load(last.next)}>Show older</Button></div>}
          </div>
        )}
      <p className="act-note small muted">ID numbers, dates of birth and handover codes are never kept. Account and phone numbers show only their last 4 digits. Kept for 12 months.</p>
    </section>
  );
}
