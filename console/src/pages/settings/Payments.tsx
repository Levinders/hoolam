import { AlertTriangle, Check, CircleCheck, CircleDashed, CircleX, Copy, FlaskConical, KeyRound, Landmark, Lock, PlugZap, Webhook } from 'lucide-react';
import { useState } from 'react';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { ago } from '../../format';
import { useData } from '../../hooks';
import { Button, ErrorBanner, Skeleton, Switch, useCopy } from '../../ui';
import { SectionHead } from '../Settings';

interface Connection {
  provider: 'monnify' | 'fake'; sandbox: boolean; baseUrl: string | null;
  configured: { apiKey: boolean; secretKey: boolean; contractCode: boolean; wallet: boolean };
  signatureRequired: boolean; selfDeals: boolean; webhookUrl: string; lastWebhookAt: string | null;
}
interface Step { key: string; ok: boolean | null; title: string; detail: string }

const KEYS: { key: keyof Connection['configured']; env: string; label: string }[] = [
  { key: 'apiKey', env: 'MONNIFY_API_KEY', label: 'API key' },
  { key: 'secretKey', env: 'MONNIFY_SECRET_KEY', label: 'Secret key' },
  { key: 'contractCode', env: 'MONNIFY_CONTRACT_CODE', label: 'Contract code' },
  { key: 'wallet', env: 'MONNIFY_WALLET_ACCOUNT', label: 'Wallet account number' },
];

/** Settings → Payments: which payment partner the server uses, whether it answers, and where it sends payment notices. */
export function PaymentsPage() {
  const { can } = useAuth();
  const q = useData<Connection>('/payments/connection');
  const copy = useCopy();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [testPayment, setTestPayment] = useState(false);
  const [bankCode, setBankCode] = useState('');
  const [acct, setAcct] = useState('');

  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (q.loading || !q.data) return <div className="stack"><Skeleton h={44} w={320} /><Skeleton h={260} /></div>;
  const c = q.data;
  const monnify = c.provider === 'monnify';
  const mode = !monnify ? 'Pretend money' : c.sandbox ? 'Monnify sandbox (test money)' : 'Monnify live (real money)';
  const canCheck = can('settings.core');

  const check = async () => {
    setBusy(true); setErr('');
    try {
      const r = await post<{ steps: Step[] }>('/payments/connection/check', { testPayment, ...(bankCode && acct ? { bankCode, accountNumber: acct } : {}) });
      setSteps(r.steps); q.reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <SectionHead title="Payments" lede="The payment partner that gives buyers an account number, holds the money and pays sellers." />
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head"><h2>Connection</h2></div>
          <div className="panel-body stack" style={{ gap: 16 }}>
            <div className={`site-status${monnify ? '' : ' off'}`}>
              <span className="ss-ic"><PlugZap /></span>
              <div style={{ minWidth: 0 }}>
                <b>{mode}</b>
                <div className="small muted">{monnify ? c.baseUrl : 'No money moves. Buyers reply "paid" to pretend.'}</div>
              </div>
            </div>

            {monnify ? (
              <ul className="uses keys-list">
                {KEYS.map((k) => (
                  <li key={k.key} className={c.configured[k.key] ? '' : 'missing'}>
                    {c.configured[k.key] ? <CircleCheck /> : <CircleX />}
                    <span><b>{k.label}</b> {c.configured[k.key] ? 'set' : 'missing'} <code>{k.env}</code></span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="note"><KeyRound /><span>To use Monnify, add on Render (hoolam → Environment): <code>PAYMENT_PROVIDER</code> = <code>monnify</code>, <code>MONNIFY_BASE_URL</code>, <code>MONNIFY_API_KEY</code>, <code>MONNIFY_SECRET_KEY</code>, <code>MONNIFY_CONTRACT_CODE</code> and <code>MONNIFY_WALLET_ACCOUNT</code>. Keys are never shown here.</span></div>
            )}

            <div className="field-block">
              <div className="small strong"><Webhook className="inline-ic" /> Payment notice address (webhook)</div>
              <p className="small muted">Paste this in the Monnify dashboard under Developer → Webhook URLs, for "Transaction completion" and "Disbursement".</p>
              <div className="copy-row">
                <code>{c.webhookUrl}</code>
                <Button size="sm" variant="ghost" icon={copy.copied ? Check : Copy} onClick={() => copy.copy(c.webhookUrl)}>{copy.copied ? 'Copied' : 'Copy'}</Button>
              </div>
              <p className="small muted">Last payment notice received: <b>{c.lastWebhookAt ? ago(c.lastWebhookAt) : 'none yet'}</b></p>
            </div>

            {monnify && !c.sandbox && !c.signatureRequired && (
              <div className="banner gold small"><AlertTriangle /><div>Live keys: also set <code>MONNIFY_REQUIRE_SIGNATURE</code> = <code>true</code> on Render, so only genuine Monnify notices can mark an order as paid.</div></div>
            )}
            {monnify && !c.sandbox && c.selfDeals && (
              <div className="banner red small"><AlertTriangle /><div>Live keys with <code>ALLOW_SELF_DEAL</code> on. Remove it on Render.</div></div>
            )}
            {monnify && c.sandbox && c.selfDeals && (
              <div className="banner teal small"><FlaskConical /><div>Test mode: one phone can be both buyer and seller. Buyers pay with Monnify's test bank (websim.sdk.monnify.com). Test orders never count on trust cards or in Money.</div></div>
            )}
          </div>
        </section>

        <aside className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Check the connection</h2>{!canCheck && <span className="right owner-tag"><Lock />Owner</span>}</div>
            <div className="panel-body stack" style={{ gap: 12 }}>
              <p className="small muted">Logs in to {monnify ? 'Monnify' : 'the pretend provider'}, reads the bank list and the wallet. Nothing is paid out.</p>
              <div className="stack" style={{ gap: 8 }}>
                <label className="small strong" htmlFor="chk-acct">Also look up an account name (optional)</label>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input num" style={{ width: 90 }} placeholder="Bank code" value={bankCode} onChange={(e) => setBankCode(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Bank code, e.g. 058" />
                  <input id="chk-acct" className="input num" style={{ flex: 1, minWidth: 0 }} placeholder="Account number" inputMode="numeric" value={acct} onChange={(e) => setAcct(e.target.value.replace(/\D/g, '').slice(0, 10))} />
                </div>
                <span className="small muted">e.g. 058 for GTBank, 044 for Access.</span>
              </div>
              {monnify && c.sandbox && (
                <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
                  <span className="small"><b>Create a ₦100 test payment</b><br /><span className="muted">Gives an account number to pay from Monnify's test bank.</span></span>
                  <Switch on={testPayment} onChange={setTestPayment} label="Create a test payment" />
                </div>
              )}
              <Button variant="primary" icon={PlugZap} busy={busy} disabled={!canCheck} onClick={check}>Run check</Button>
              {err && <div className="banner red small"><AlertTriangle /><div>{err}</div></div>}
              {steps && (
                <ol className="check-steps">
                  {steps.map((s) => (
                    <li key={s.key} className={s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'skip'}>
                      {s.ok === true ? <CircleCheck /> : s.ok === false ? <CircleX /> : <CircleDashed />}
                      <div><b>{s.title}</b><span>{s.detail}</span></div>
                    </li>
                  ))}
                </ol>
              )}
              {steps?.some((s) => s.key === 'login' && s.ok === false) && (
                <div className="note"><Landmark /><span>Login failed: check that the API key and secret key are the <b>sandbox</b> ones if the address says sandbox (or the live ones for api.monnify.com), with no spaces at either end.</span></div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
