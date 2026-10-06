import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Shell } from './Shell';
import { Logo, ToastProvider } from './ui';
import { Login, Setup, AcceptInvite } from './pages/Auth';
import { Home } from './pages/Home';
import { Deals } from './pages/Deals';
import { Deal } from './pages/Deal';
import { Disputes } from './pages/Disputes';
import { Money } from './pages/Money';
import { People, Person } from './pages/People';
import { Support } from './pages/Support';
import { Insights } from './pages/Insights';
import { Settings } from './pages/Settings';
import { Team } from './pages/Team';
import { Audit } from './pages/Audit';

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
              <Route path="/support" element={<Support />} />
              <Route path="/insights" element={<Insights />} />
              <Route path="/settings" element={<Settings />} />
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
      <AuthProvider>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
