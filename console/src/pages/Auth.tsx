import { KeyRound, Lock, Smartphone } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, post } from '../api';
import { useAuth } from '../auth';
import { useBrand } from '../brand';
import { Button, ErrorBanner, Logo, useCopy } from '../ui';

function AuthLayout({ children }: { children: ReactNode }) {
  const { brand } = useBrand();
  return (
    <div className="auth">
      <div className="auth-side">
        <div className="row" style={{ color: '#fff' }}><Logo /><b style={{ font: '600 17px Poppins' }}>Hoolam Console</b></div>
        <h1>Every naira, accounted for.</h1>
        <p>Money waits in the middle until buyers are happy. This is where the team keeps it that way, with a trail of who did what and when.</p>
      </div>
      <div className="auth-form"><div className="auth-card">{brand.logo && <img className="auth-logo" src={brand.logo} alt="Hoolam" />}{children}</div></div>
    </div>
  );
}

function CodeStep({ title, lead, onSubmit, children }: { title: string; lead: string; onSubmit: (code: string) => Promise<void>; children?: ReactNode }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) return;
    setBusy(true); setErr(null);
    try { await onSubmit(code); } catch (x) { setErr((x as Error).message); setCode(''); } finally { setBusy(false); }
  };
  useEffect(() => { if (code.length === 6) submit(); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
      <div><h2>{title}</h2><p className="muted" style={{ marginTop: 4 }}>{lead}</p></div>
      {children}
      <div className="field">
        <label htmlFor="code">6-digit code</label>
        <input id="code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6}
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      </div>
      {err && <ErrorBanner error={err} />}
      <Button variant="primary" size="lg" busy={busy} disabled={code.length !== 6} icon={KeyRound}>Verify</Button>
    </form>
  );
}

function Enrollment({ secret, qr, ticket, onDone }: { secret: string; qr: string; ticket: string; onDone: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <CodeStep title="Set up two-step sign-in" lead="Scan this with Google Authenticator, Microsoft Authenticator or any authenticator app, then type the 6-digit code it shows."
      onSubmit={async (code) => { await post('/auth/enroll', { ticket, code }); onDone(); }}>
      <div className="qr">
        <img src={qr} alt="QR code for your authenticator app" />
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">Can't scan? Enter this key in the app:</span>
          <span className="secret">{secret}</span>
          <button type="button" className="btn sm" onClick={() => copy(secret)}>{copied ? 'Copied' : 'Copy key'}</button>
        </div>
      </div>
    </CodeStep>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { setTicket((await post<{ ticket: string }>('/auth/login', { email, password })).ticket); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      {ticket ? (
        <CodeStep title="Enter your code" lead="Open your authenticator app and type the 6-digit code for Hoolam Console."
          onSubmit={async (code) => { await post('/auth/code', { ticket, code }); await refresh(); }}>
          <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTicket(null)}>Use a different account</button>
        </CodeStep>
      ) : (
        <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
          <div><h2>Sign in</h2><p className="muted" style={{ marginTop: 4 }}>Staff only. You'll need your authenticator app.</p></div>
          <div className="field"><label htmlFor="email">Work email</label><input id="email" className="input" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {err && <ErrorBanner error={err} />}
          <Button variant="primary" size="lg" busy={busy} icon={Lock}>Continue</Button>
          <p className="small muted">New to the team? Use the invite link the owner sent you.</p>
        </form>
      )}
    </AuthLayout>
  );
}

export function Setup() {
  const { refresh } = useAuth();
  const [f, setF] = useState({ setupToken: '', name: '', email: '', password: '' });
  const [enroll, setEnroll] = useState<{ ticket: string; secret: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { setEnroll(await post('/auth/setup', f)); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      {enroll ? <Enrollment {...enroll} onDone={refresh} /> : (
        <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
          <div><h2>Set up the console</h2><p className="muted" style={{ marginTop: 4 }}>You'll be the owner. You can invite your team afterwards.</p></div>
          <div className="field">
            <label htmlFor="tok">Setup key</label>
            <input id="tok" className="input" type="password" value={f.setupToken} onChange={set('setupToken')} required autoFocus />
            <span className="hint">Your ADMIN_TOKEN, in Render → Environment. It proves you own this server.</span>
          </div>
          <div className="field"><label htmlFor="nm">Your name</label><input id="nm" className="input" value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label htmlFor="em">Work email</label><input id="em" className="input" type="email" value={f.email} onChange={set('email')} required /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /><span className="hint">At least 10 characters, with letters and a number.</span></div>
          {err && <ErrorBanner error={err} />}
          <Button variant="primary" size="lg" busy={busy} icon={Smartphone}>Continue to two-step sign-in</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function AcceptInvite() {
  const { token } = useParams();
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ name: string; email: string; role: string } | null>(null);
  const [password, setPassword] = useState('');
  const [enroll, setEnroll] = useState<{ ticket: string; secret: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/auth/invite/${token}`).then(setInfo).catch((e) => setErr(e.message)); }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { setEnroll(await post(`/auth/invite/${token}`, { password })); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      {enroll ? <Enrollment {...enroll} onDone={async () => { await refresh(); nav('/', { replace: true }); }} /> : !info ? (
        err ? <ErrorBanner error={err} /> : <p className="muted">Checking your invite…</p>
      ) : (
        <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
          <div><h2>Welcome, {info.name.split(' ')[0]}</h2><p className="muted" style={{ marginTop: 4 }}>You're joining Hoolam Console as <b>{info.role.charAt(0) + info.role.slice(1).toLowerCase()}</b>, signing in as {info.email}.</p></div>
          <div className="field"><label htmlFor="pw">Choose a password</label><input id="pw" className="input" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required /><span className="hint">At least 10 characters, with letters and a number.</span></div>
          {err && <ErrorBanner error={err} />}
          <Button variant="primary" size="lg" busy={busy} icon={Smartphone}>Continue to two-step sign-in</Button>
        </form>
      )}
    </AuthLayout>
  );
}
