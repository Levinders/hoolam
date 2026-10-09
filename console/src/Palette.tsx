import { ChartColumn, CornerDownLeft, Handshake, Inbox, Landmark, LifeBuoy, Scale, ScrollText, Search, Settings2, ShieldCheck, UserRound, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { money } from './format';
import { useDebounced } from './hooks';
import { Modal, StatusPill } from './ui';

type Item = { key: string; group: string; title: string; sub?: string; icon: typeof Inbox; to: string; status?: string; need?: string };

const PAGES: Item[] = [
  { key: 'p-home', group: 'Go to', title: 'Needs action', icon: Inbox, to: '/' },
  { key: 'p-deals', group: 'Go to', title: 'Orders', icon: Handshake, to: '/deals' },
  { key: 'p-disputes', group: 'Go to', title: 'Disputes', icon: Scale, to: '/disputes' },
  { key: 'p-money', group: 'Go to', title: 'Money', icon: Landmark, to: '/money' },
  { key: 'p-people', group: 'Go to', title: 'Buyers & sellers', icon: Users, to: '/people' },
  { key: 'p-support', group: 'Go to', title: 'Support', icon: LifeBuoy, to: '/support' },
  { key: 'p-insights', group: 'Go to', title: 'Insights', icon: ChartColumn, to: '/insights' },
  { key: 'p-settings', group: 'Go to', title: 'Settings', icon: Settings2, to: '/settings', need: 'settings.view' },
  ...[['fees', 'Fees'], ['limits', 'Limits'], ['timing', 'Timing'], ['whatsapp', 'WhatsApp number'], ['brand', 'Brand and logo'], ['images', 'Website images'], ['history', 'Settings history']]
    .map(([k, t]) => ({ key: `p-s-${k}`, group: 'Settings', title: t!, icon: Settings2, to: `/settings/${k}`, need: 'settings.view' })),
  { key: 'p-team', group: 'Go to', title: 'Team', icon: ShieldCheck, to: '/team' },
  { key: 'p-audit', group: 'Go to', title: 'Audit trail', icon: ScrollText, to: '/audit', need: 'audit.view' },
];

/** ⌘K: jump to a deal by code, a person by name or phone, or any page. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const { can } = useAuth();
  const dq = useDebounced(q, 160);
  useEffect(() => {
    if (dq.trim().length < 2) { setFound([]); return; }
    let alive = true;
    api<{ deals: any[]; people: any[] }>(`/search?q=${encodeURIComponent(dq.trim())}`).then((r) => {
      if (!alive) return;
      setFound([
        ...r.deals.map((d) => ({ key: `d-${d.code}`, group: 'Orders', title: `${d.code}  ${d.item}`, sub: money(d.buyer_pays_minor, d.currency), icon: Handshake, to: `/deals/${d.code}`, status: d.status })),
        ...r.people.map((p) => ({ key: `u-${p.id}`, group: 'People', title: p.business_name || p.display_name || p.phone, sub: p.phone, icon: UserRound, to: `/people/${p.id}` })),
      ]);
    }).catch(() => {});
    return () => { alive = false; };
  }, [dq]);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const pages = PAGES.filter((p) => (!p.need || can(p.need)) && (t ? p.title.toLowerCase().includes(t) : p.group === 'Go to'));
    return [...found, ...pages];
  }, [found, q, can]);
  useEffect(() => setSel(0), [items.length]);
  const go = (i: Item | undefined) => { if (i) { nav(i.to); onClose(); } };
  let lastGroup = '';
  return (
    <Modal onClose={onClose} label="Search">
      <div className="palette" style={{ boxShadow: 'none', animation: 'none' }}>
        <div className="palette-input">
          <Search aria-hidden="true" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order code, item, name or phone"
            aria-label="Search"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              if (e.key === 'Enter') { e.preventDefault(); go(items[sel]); }
            }} />
        </div>
        <div className="palette-list" role="listbox">
          {items.length === 0 && <div className="empty" style={{ padding: 24 }}>Nothing matches “{q}”.</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{(lastGroup = it.group)}</div> : null;
            const Icon = it.icon;
            return (
              <div key={it.key}>
                {head}
                <div role="option" aria-selected={i === sel} className={`palette-item${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
                  <span className="pi"><Icon /></span>
                  <div style={{ flex: 1, minWidth: 0 }}><div className="cell-main" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</div>{it.sub && <div className="cell-sub">{it.sub}</div>}</div>
                  {it.status && <StatusPill status={it.status} />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><span>↑ ↓ to move</span><span><CornerDownLeft style={{ width: 12, height: 12, verticalAlign: -2 }} /> to open</span><span>Esc to close</span></div>
      </div>
    </Modal>
  );
}
