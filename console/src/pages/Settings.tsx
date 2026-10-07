import { Coins, Gauge, History, Image as ImageIcon, MessageCircle, Palette, Timer, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { BrandPage, ImagesPage } from './settings/Images';
import { HistoryPage } from './settings/History';
import { FeesPage, LimitsPage, TimingPage, WhatsAppPage } from './settings/Values';

/** Settings, split into small pages that each do one job. */
export const SETTINGS_PAGES: { key: string; group: string; label: string; sub: string; icon: LucideIcon; el: () => ReactNode }[] = [
  { key: 'fees', group: 'Service', label: 'Fees', sub: 'What Hoolam charges', icon: Coins, el: () => <FeesPage /> },
  { key: 'limits', group: 'Service', label: 'Limits', sub: 'How big a deal can be', icon: Gauge, el: () => <LimitsPage /> },
  { key: 'timing', group: 'Service', label: 'Timing', sub: 'Reminders and deadlines', icon: Timer, el: () => <TimingPage /> },
  { key: 'whatsapp', group: 'Service', label: 'WhatsApp', sub: 'Number, alerts and forms', icon: MessageCircle, el: () => <WhatsAppPage /> },
  { key: 'brand', group: 'Look', label: 'Brand', sub: 'Logo and logo icon', icon: Palette, el: () => <BrandPage /> },
  { key: 'images', group: 'Look', label: 'Website images', sub: 'Pictures on the website', icon: ImageIcon, el: () => <ImagesPage /> },
  { key: 'history', group: 'Records', label: 'Change history', sub: 'Who changed what', icon: History, el: () => <HistoryPage /> },
];

/** Pages with unsaved edits register here, so leaving them asks first. */
const DirtyCtx = createContext<{ current: boolean }>({ current: false });
export const useUnsaved = (dirty: boolean) => {
  const ref = useContext(DirtyCtx);
  useEffect(() => { ref.current = dirty; return () => { ref.current = false; }; }, [dirty, ref]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
};

export function Settings() {
  const { page } = useParams();
  const nav = useNavigate();
  const dirty = useRef(false);
  // on phones the section chips scroll sideways: keep the current one in view
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.subnav a.active');
    const bar = el?.closest<HTMLElement>('.subnav');
    if (el && bar && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: el.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft - 16, behavior: 'smooth' });
  }, [page]);
  const current = SETTINGS_PAGES.find((p) => p.key === page);
  if (!current) return <Navigate to="/settings/fees" replace />;
  const groups = [...new Set(SETTINGS_PAGES.map((p) => p.group))];
  const go = (e: React.MouseEvent, to: string) => {
    if (dirty.current && !window.confirm('You have changes that aren\'t saved. Leave without saving?')) { e.preventDefault(); return; }
    dirty.current = false;
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault(); nav(to);
  };
  return (
    <DirtyCtx.Provider value={dirty}>
      <div className="page settings-page">
        <div className="page-head">
          <div><h1>Settings</h1><p className="lede">How Hoolam works and how it looks. Every change is saved to the audit trail with your name and the time.</p></div>
        </div>
        <div className="settings-layout">
          <nav className="subnav" aria-label="Settings sections">
            {groups.map((g) => (
              <div className="subnav-group" key={g}>
                <div className="subnav-title">{g}</div>
                {SETTINGS_PAGES.filter((p) => p.group === g).map((p) => (
                  <NavLink key={p.key} to={`/settings/${p.key}`} onClick={(e) => go(e, `/settings/${p.key}`)}>
                    <span className="sn-ic"><p.icon aria-hidden="true" /></span>
                    <span className="sn-t"><b>{p.label}</b><span>{p.sub}</span></span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-main" key={current.key}>{current.el()}</div>
        </div>
      </div>
    </DirtyCtx.Provider>
  );
}

/** The top of each settings page. */
export function SectionHead({ title, lede, right }: { title: string; lede: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-head">
      <div><h2>{title}</h2><p className="muted">{lede}</p></div>
      {right && <div className="right">{right}</div>}
    </div>
  );
}
