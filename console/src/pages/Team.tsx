import { Copy, KeyRound, ShieldCheck, UserMinus, UserPlus, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { post } from '../api';
import { useAuth } from '../auth';
import { ago, dateTime } from '../format';
import { useData } from '../hooks';
import { Avatar, Button, ConfirmAction, ErrorBanner, Modal, SkeletonRows, useCopy, useToast } from '../ui';

const ROLE_TEXT: Record<string, { name: string; does: string }> = {
  OWNER: { name: 'Owner', does: 'Everything: the team, fees, limits and Hoolam\'s WhatsApp number.' },
  ADMIN: { name: 'Admin', does: 'Handles orders and disputes: release, refund, cancel. Pauses accounts. Settings: timing, alerts, logo and website images.' },
  FINANCE: { name: 'Finance', does: 'Approves and retries payouts, exports for the accountant.' },
  SUPPORT: { name: 'Support', does: 'Replies to people, messages buyers and sellers, adds notes. Can\'t move money.' },
};

export function Team() {
  const { can, me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useData<any>('/team');
  const [invite, setInvite] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'deactivate' | 'reactivate' | 'reset'; s: any }>(null);
  const manage = can('staff.manage');
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Team</h1><p className="lede">Who can sign in to the console, and what each person can do. Everyone signs in with a password and a code from their phone.</p></div>
        {manage && <div className="actions"><Button variant="primary" icon={UserPlus} onClick={() => setInvite(true)}>Invite someone</Button></div>}
      </div>
      <div className="grid side">
        <section className="panel">
          {error ? <div className="panel-body"><ErrorBanner error={error} /></div> : loading ? <SkeletonRows rows={4} /> : (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last active</th><th></th></tr></thead>
              <tbody>{data.rows.map((s: any) => (
                <tr key={s.id} style={{ opacity: s.active ? 1 : .55 }}>
                  <td><div className="row"><Avatar name={s.name} gold={s.role === 'OWNER'} /><div><div className="cell-main">{s.name}{s.id === me?.id && <span className="faint"> (you)</span>}</div><div className="cell-sub">{s.email}</div></div></div></td>
                  <td>{manage && s.id !== me?.id && s.active ? (
                    <select className="select" style={{ width: 130, height: 32 }} value={s.role} aria-label={`Role for ${s.name}`}
                      onChange={async (e) => { try { await post(`/team/${s.id}/role`, { role: e.target.value }); toast({ kind: 'ok', title: `${s.name} is now ${ROLE_TEXT[e.target.value]!.name}` }); reload(); } catch (x) { toast({ kind: 'error', title: 'Role not changed', body: (x as Error).message }); } }}>
                      {Object.entries(ROLE_TEXT).map(([r, t]) => <option key={r} value={r}>{t.name}</option>)}
                    </select>
                  ) : <span className={`role ${s.role}`}>{ROLE_TEXT[s.role]?.name}</span>}</td>
                  <td>{!s.active ? <span className="pill grey">Deactivated</span> : !s.totp_enabled ? <span className="pill gold">Invite not accepted</span> : <span className="pill green">Active</span>}</td>
                  <td className="muted nowrap" title={dateTime(s.last_action_at ?? s.last_login_at)}>{s.last_action_at ? ago(s.last_action_at) : s.last_login_at ? ago(s.last_login_at) : 'Never'}{s.actions_30d ? <div className="cell-sub">{s.actions_30d} action{s.actions_30d === 1 ? '' : 's'} in 30 days</div> : null}</td>
                  <td className="r">{manage && s.id !== me?.id && (<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => setConfirm({ kind: 'reset', s })}>{s.totp_enabled ? 'Reset login' : 'New invite link'}</Button>
                    {s.active ? <Button size="sm" variant="ghost" icon={UserMinus} onClick={() => setConfirm({ kind: 'deactivate', s })}>Deactivate</Button>
                      : <Button size="sm" variant="ghost" icon={UserCheck} onClick={() => setConfirm({ kind: 'reactivate', s })}>Reactivate</Button>}
                  </div>)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>What each role can do</h2><ShieldCheck className="faint" style={{ marginLeft: 'auto', width: 18 }} /></div>
          <div className="panel-body stack" style={{ gap: 14 }}>
            {Object.entries(ROLE_TEXT).map(([r, t]) => <div key={r}><span className={`role ${r}`}>{t.name}</span><p className="small" style={{ marginTop: 6, color: 'var(--ink-2)' }}>{t.does}</p></div>)}
            <p className="small muted">Every role can see orders, people and insights. Every action anyone takes is in the audit trail with their name and the time.</p>
          </div>
        </section>
      </div>
      {invite && <InviteModal onClose={() => setInvite(false)} onDone={(name, url) => { setInvite(false); setLink({ name, url }); reload(); }} />}
      {link && <LinkModal name={link.name} url={link.url} onClose={() => setLink(null)} />}
      {confirm && <ConfirmAction needReason={false}
        icon={confirm.kind === 'reset' ? KeyRound : confirm.kind === 'deactivate' ? UserMinus : UserCheck} tone={confirm.kind === 'deactivate' ? 'danger' : 'gold'}
        title={confirm.kind === 'reset' ? `Reset ${confirm.s.name}'s login?` : confirm.kind === 'deactivate' ? `Deactivate ${confirm.s.name}?` : `Reactivate ${confirm.s.name}?`}
        confirmLabel={confirm.kind === 'reset' ? 'Reset and get a link' : confirm.kind === 'deactivate' ? 'Deactivate' : 'Reactivate'}
        description={confirm.kind === 'reset' ? 'They\'re signed out everywhere and get a new link to set a password and authenticator. Use this if they lost their phone.' : confirm.kind === 'deactivate' ? 'They\'re signed out straight away and can\'t sign in. Their past actions stay in the audit trail.' : 'They can sign in again with their existing password and authenticator.'}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm.kind === 'reset') { const r = await post(`/team/${confirm.s.id}/reset`); setLink({ name: confirm.s.name, url: r.inviteUrl }); }
          else { await post(`/team/${confirm.s.id}/active`, { active: confirm.kind === 'reactivate' }); toast({ kind: 'ok', title: confirm.kind === 'deactivate' ? 'Deactivated' : 'Reactivated' }); }
          reload();
        }} />}
    </div>
  );
}

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: (name: string, url: string) => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'SUPPORT' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} label="Invite someone">
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { const r = await post('/team/invite', f); onDone(f.name, r.inviteUrl); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } }}>
        <div className="modal-head"><div className="mi"><UserPlus /></div><div><h2>Invite someone</h2><p>You'll get a private link to send them. It works once, for 3 days.</p></div></div>
        <div className="modal-body">
          <div className="field"><label htmlFor="n">Name</label><input id="n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
          <div className="field"><label htmlFor="e">Work email</label><input id="e" className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></div>
          <div className="field"><label>Role</label>
            <div className="stack" style={{ gap: 6 }}>{Object.entries(ROLE_TEXT).map(([r, t]) => (
              <label key={r} className="row" style={{ alignItems: 'flex-start', padding: '8px 10px', border: `1px solid ${f.role === r ? 'var(--teal)' : 'var(--line)'}`, borderRadius: 10, cursor: 'pointer', background: f.role === r ? 'var(--teal-50)' : undefined }}>
                <input type="radio" name="role" checked={f.role === r} onChange={() => setF({ ...f, role: r })} style={{ marginTop: 3 }} />
                <div><b>{t.name}</b><div className="small muted">{t.does}</div></div>
              </label>
            ))}</div>
          </div>
          {err && <ErrorBanner error={err} />}
        </div>
        <div className="modal-foot"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} icon={UserPlus}>Create invite link</Button></div>
      </form>
    </Modal>
  );
}

function LinkModal({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <Modal onClose={onClose} label="Invite link">
      <div className="modal-head"><div className="mi gold"><KeyRound /></div><div><h2>Send this link to {name.split(' ')[0]}</h2><p>Send it privately (WhatsApp or email). It works once and expires in 3 days. They'll set a password and their authenticator.</p></div></div>
      <div className="modal-body"><div className="secret" style={{ background: 'var(--sunk)', padding: 12, borderRadius: 10 }}>{url}</div></div>
      <div className="modal-foot"><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary" icon={Copy} onClick={() => copy(url)}>{copied ? 'Copied' : 'Copy link'}</Button></div>
    </Modal>
  );
}
