import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { BrandProvider } from './brand';
import { Shell } from './Shell';
import { Logo, ToastProvider } from './ui';
import { Login, Setup, AcceptInvite } from './pages/Auth';
import { Home } from './pages/Home';
import { Deals } from './pages/Deals';
import { Deal } from './pages/Deal';
import { Disputes } from './pages/Disputes';
import { Money } from './pages/Money';
import { People, Person } from './pages/People';
import { openSupport } from './support/hub';
import { Insights } from './pages/Insights';
import { Settings } from './pages/Settings';
import { Team } from './pages/Team';
import { Audit } from './pages/Audit';

/** Old links to /support (Needs action, the audit trail): open the support widget instead, on the page underneath. */
function OpenSupport() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  useEffect(() => {
    const live = Number(sp.get('live')) || null;
    const wa = Number(sp.get('open')) || null;
    openSupport(live ? 'live' : 'whatsapp', live ?? wa ?? null);
    if (window.history.length > 1) nav(-1); else nav('/', { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Gate() {
  const { loading, setupNeeded, me } = useAuth();
  if (loading) return <div className="boot" aria-label="Loading"><Logo size={44} /></div>;
  return (
    <Routes>
      <Route path="/invite/:token" element={<AcceptInvite />} />
      {setupNeeded ? <Route path="*" element={<Setup />} /> : !me ? <Route path="*" element={<Login />} /> : (
        <Route path="*" element={
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/deals" element={<Deals />} />
              <Route path="/deals/:code" element={<Deal />} />
              <Route path="/disputes" element={<Disputes />} />
              <Route path="/money" element={<Money />} />
              <Route path="/people" element={<People />} />
              <Route path="/people/:id" element={<Person />} />
              <Route path="/support" element={<OpenSupport />} />
              <Route path="/insights" element={<Insights />} />
              <Route path="/settings" element={<Navigate to="/settings/fees" replace />} />
              <Route path="/settings/:page" element={<Settings />} />
              <Route path="/team" element={<Team />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        } />
      )}
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter basename="/console">
      <BrandProvider>
        <AuthProvider>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </AuthProvider>
      </BrandProvider>
    </BrowserRouter>
  );
}
