import { Coins, Contact, Gauge, History, Image as ImageIcon, Lock, MessageCircle, Palette, ShieldCheck, Timer, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { Empty } from '../ui';
import { BrandPage, ImagesPage } from './settings/Images';
import { HistoryPage } from './settings/History';
import { ContactPage, FeesPage, LimitsPage, TimingPage, WhatsAppPage } from './settings/Values';

/**
 * Settings, split into small pages under one row of tabs. Owners and admins only.
 * "edit" is the permission needed to change things on that page; "ownerOnly" marks pages only an owner can change.
 */
export const SETTINGS_PAGES: { key: string; group: string; label: string; icon: LucideIcon; edit: string; ownerOnly?: boolean; el: () => ReactNode }[] = [
  { key: 'fees', group: 'Service', label: 'Fees', icon: Coins, edit: 'settings.core', ownerOnly: true, el: () => <FeesPage /> },
  { key: 'limits', group: 'Service', label: 'Limits', icon: Gauge, edit: 'settings.core', ownerOnly: true, el: () => <LimitsPage /> },
  { key: 'timing', group: 'Service', label: 'Timing', icon: Timer, edit: 'settings.update', el: () => <TimingPage /> },
  { key: 'whatsapp', group: 'Service', label: 'WhatsApp', icon: MessageCircle, edit: 'settings.update', el: () => <WhatsAppPage /> },
  { key: 'contact', group: 'Look', label: 'Contact', icon: Contact, edit: 'settings.update', el: () => <ContactPage /> },
  { key: 'brand', group: 'Look', label: 'Brand', icon: Palette, edit: 'brand.update', el: () => <BrandPage /> },
  { key: 'images', group: 'Look', label: 'Website images', icon: ImageIcon, edit: 'brand.update', el: () => <ImagesPage /> },
  { key: 'history', group: 'Records', label: 'History', icon: History, edit: 'settings.view', el: () => <HistoryPage /> },
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
  const { can } = useAuth();
  const nav = useNavigate();
  const dirty = useRef(false);
  const bar = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);

  // the sliding underline follows the open tab; on phones the row scrolls to keep it in view
  useLayoutEffect(() => {
    const place = () => {
      const el = bar.current?.querySelector<HTMLElement>('a.active');
      if (!el || !bar.current) return;
      setInk({ left: el.offsetLeft, width: el.offsetWidth });
      const b = bar.current;
      if (b.scrollWidth > b.clientWidth) b.scrollTo({ left: el.offsetLeft - (b.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
    };
    place();
    window.addEventListener('resize', place);
    document.fonts?.ready.then(place).catch(() => {});
    return () => window.removeEventListener('resize', place);
  }, [page]);

  if (!can('settings.view')) {
    return (
      <div className="page"><section className="panel" style={{ maxWidth: 560, margin: '40px auto' }}>
        <Empty icon={ShieldCheck} title="Settings are for owners and admins" action={<Link className="btn" to="/">Back to Needs action</Link>}>
          They change how Hoolam works for everyone. Ask an owner if something needs changing.
        </Empty>
      </section></div>
    );
  }
  const current = SETTINGS_PAGES.find((p) => p.key === page);
  if (!current) return <Navigate to="/settings/fees" replace />;

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
        <div className="tabs-wrap">
          <div className="stabs" ref={bar} role="tablist" aria-label="Settings sections">
            {SETTINGS_PAGES.map((p, i) => {
              const locked = !can(p.edit);
              const newGroup = i > 0 && SETTINGS_PAGES[i - 1]!.group !== p.group;
              return (
                <span key={p.key} className="tab-slot">
                  {newGroup && <span className="tab-sep" aria-hidden="true" />}
                  <NavLink to={`/settings/${p.key}`} role="tab" aria-selected={p.key === current.key} onClick={(e) => go(e, `/settings/${p.key}`)}
                    title={locked ? (p.ownerOnly ? 'Only an owner can change this. You can see it.' : 'View only') : undefined}>
                    <p.icon className="tab-ic" aria-hidden="true" />
                    <span>{p.label}</span>
                    {locked && <Lock className="tab-lock" aria-label="View only" />}
                  </NavLink>
                </span>
              );
            })}
            {ink && <span className="tab-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} aria-hidden="true" />}
          </div>
        </div>
        <div className="settings-main" key={current.key} role="tabpanel">{current.el()}</div>
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
