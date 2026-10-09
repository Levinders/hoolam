import { useBrand } from './brand';
import { ChartColumn, Handshake, Inbox, Landmark, LifeBuoy, LogOut, Menu, ScrollText, Search, Settings2, ShieldCheck, Scale, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { useData, usePoll } from './hooks';
import { CommandPalette } from './Palette';
import { Avatar, Logo } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  const { me, signOut, can } = useAuth();
  const { brand } = useBrand();
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const counts = useData<{ counts: { inbox: number; disputes: number; support: number } }>('/inbox');
  usePoll(() => counts.reload(), 30_000);
  useEffect(() => { setMenu(false); counts.reload(); /* refresh counts after navigation */ }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if (e.key === '/' && !/input|textarea|select/i.test((e.target as HTMLElement).tagName)) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const c = counts.data?.counts;
  const item = (to: string, label: string, Icon: typeof Inbox, n?: number, quiet?: boolean) => (
    <NavLink to={to} end={to === '/'}>
      <Icon aria-hidden="true" />{label}
      {!!n && <span className={`count${quiet ? ' quiet' : ''}`} aria-label={`${n} waiting`}>{n}</span>}
    </NavLink>
  );
  return (
    <div className="shell">
      <aside className={`sidebar${menu ? ' open' : ''}`} aria-label="Main navigation">
        {brand.logo && !brand.mark
          ? <div className="brand"><span className="brand-plate"><img src={brand.logo} alt="Hoolam" /></span><span className="brand-sub">Console</span></div>
          : <div className="brand"><Logo /><div><b>Hoolam</b><span>Console</span></div></div>}
        <nav className="nav">
          {item('/', 'Needs action', Inbox, c?.inbox)}
          <div className="nav-group">Orders</div>
          {item('/deals', 'Orders', Handshake)}
          {item('/disputes', 'Disputes', Scale, c?.disputes)}
          {item('/money', 'Money', Landmark)}
          <div className="nav-group">People</div>
          {item('/people', 'Buyers & sellers', Users)}
          {item('/support', 'Support', LifeBuoy, c?.support, true)}
          <div className="nav-group">Business</div>
          {item('/insights', 'Insights', ChartColumn)}
          {can('settings.view') && item('/settings', 'Settings', Settings2)}
          {item('/team', 'Team', ShieldCheck)}
          {can('audit.view') && item('/audit', 'Audit trail', ScrollText)}
        </nav>
        <div className="me">
          <Avatar name={me?.name} gold />
          <div className="who"><b>{me?.name}</b><span>{me?.roleName}</span></div>
          <button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out"><LogOut /></button>
        </div>
      </aside>
      {menu && <div className="scrim" style={{ zIndex: 25, padding: 0 }} onClick={() => setMenu(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setMenu(true)}><Menu /></button>
          <button className="search-trigger" onClick={() => setPalette(true)}>
            <Search aria-hidden="true" /><span>Search orders, people, codes…</span><span className="kbd">⌘K</span>
          </button>
        </header>
        <main key={loc.pathname.split('/')[1]}>{children}</main>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
