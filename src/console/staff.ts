import { timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import type { Db } from '../db.js';
import { audit, type Actor } from './audit.js';
import { hashPassword, newTotpSecret, otpauthUrl, randomToken, sha256, verifyPassword, verifyTotp, weakPassword } from './crypto.js';

export type Role = 'OWNER' | 'ADMIN' | 'FINANCE' | 'SUPPORT';
export const ROLES: Role[] = ['OWNER', 'ADMIN', 'FINANCE', 'SUPPORT'];

export interface StaffMember { id: string; email: string; name: string; role: Role; active: boolean; totp_enabled: boolean; created_at: Date; last_login_at: Date | null }

/** What each role may do. Viewing is open to every role; these are the actions. */
export const CAN: Record<string, Role[]> = {
  'deal.release': ['OWNER', 'ADMIN'],
  'deal.refund': ['OWNER', 'ADMIN'],
  'deal.cancel': ['OWNER', 'ADMIN'],
  'deal.extend': ['OWNER', 'ADMIN'],
  'deal.message': ['OWNER', 'ADMIN', 'SUPPORT'],
  'deal.note': ['OWNER', 'ADMIN', 'FINANCE', 'SUPPORT'],
  'payout.authorize': ['OWNER', 'FINANCE'],
  'payout.retry': ['OWNER', 'ADMIN', 'FINANCE'],
  'money.export': ['OWNER', 'FINANCE'],
  'support.reply': ['OWNER', 'ADMIN', 'SUPPORT'],
  'support.close': ['OWNER', 'ADMIN', 'SUPPORT'],
  'user.block': ['OWNER', 'ADMIN'],
  'user.cap': ['OWNER', 'ADMIN'],
  'settings.update': ['OWNER'],
  'staff.manage': ['OWNER'],
  'audit.view': ['OWNER', 'ADMIN', 'FINANCE'],
};
export const can = (role: Role, action: string) => (CAN[action] ?? []).includes(role);
export const permissionsFor = (role: Role) => Object.keys(CAN).filter((a) => can(role, a));

const SESSION_DAYS = 7;
const IDLE_HOURS = 12;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const TICKET_MINUTES = 10;

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Staff accounts. Every login needs a password AND a code from an authenticator app.
 * Sessions live in the database (only a hash of the cookie is stored), expire after 7 days or 12 idle hours.
 */
export class StaffAuth {
  /** Short-lived steps between "password OK" and "code OK", or during setup. Kept in memory on purpose. */
  private tickets = new Map<string, { staffId: string; kind: 'login' | 'enroll'; secret?: string; expires: number }>();

  constructor(private readonly db: Db, private readonly o: { setupToken: string; baseUrl: string }) {}

  async hasOwner(): Promise<boolean> {
    return ((await this.db.query(`SELECT 1 FROM staff WHERE role='OWNER' AND active AND totp_enabled LIMIT 1`)).rowCount ?? 0) > 0;
  }

  private ticket(staffId: string, kind: 'login' | 'enroll', secret?: string): string {
    const t = randomToken(24);
    this.tickets.set(t, { staffId, kind, secret, expires: Date.now() + TICKET_MINUTES * 60_000 });
    for (const [k, v] of this.tickets) if (v.expires < Date.now()) this.tickets.delete(k);
    return t;
  }

  private takeTicket(t: string, kind: 'login' | 'enroll') {
    const v = this.tickets.get(t);
    if (!v || v.kind !== kind || v.expires < Date.now()) throw new AuthError('This step has expired. Please start again.', 401);
    return v;
  }

  private async enrollment(staffId: string, email: string) {
    const secret = newTotpSecret();
    const url = otpauthUrl(secret, email);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: '#0E5C63', light: '#FFFFFF' } });
    return { ticket: this.ticket(staffId, 'enroll', secret), secret, qr };
  }

  /** The very first owner. Proven with the ADMIN_TOKEN from Render, then sets up their authenticator. */
  async setupOwner(input: { setupToken: string; name: string; email: string; password: string }, ip: string | null) {
    if (await this.hasOwner()) throw new AuthError('The console is already set up. Please sign in.', 409);
    const a = Buffer.from(input.setupToken ?? ''), b = Buffer.from(this.o.setupToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError('That setup key is not right. Copy ADMIN_TOKEN from Render → Environment.', 401);
    const weak = weakPassword(input.password ?? '');
    if (weak) throw new AuthError(weak);
    const email = cleanEmail(input.email);
    if (!input.name?.trim()) throw new AuthError('Please enter your name.');
    const r = await this.db.query(
      `INSERT INTO staff (email, name, role, password_hash) VALUES ($1,$2,'OWNER',$3)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role='OWNER', password_hash=EXCLUDED.password_hash, active=true RETURNING id`,
      [email, input.name.trim().slice(0, 60), await hashPassword(input.password)]);
    await audit(this.db, { staffId: r.rows[0].id, name: input.name.trim(), role: 'OWNER', ip }, { action: 'console.setup', targetType: 'staff', targetId: r.rows[0].id });
    return this.enrollment(r.rows[0].id, email);
  }

  /** Step 1 of signing in: email + password. Returns a ticket for the authenticator code. */
  async login(emailIn: string, password: string, ip: string | null): Promise<{ ticket: string }> {
    const email = cleanEmail(emailIn);
    const r = await this.db.query('SELECT id, name, role, password_hash, active, totp_enabled, failed_logins, locked_until FROM staff WHERE email=$1', [email]);
    const s = r.rows[0];
    const fail = async (msg = 'That email and password don\'t match.') => {
      if (s) {
        const locked = s.failed_logins + 1 >= LOCK_AFTER;
        await this.db.query(`UPDATE staff SET failed_logins=failed_logins+1, locked_until=CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id=$1`, [s.id, locked, LOCK_MINUTES]);
        await audit(this.db, { staffId: s.id, name: s.name, role: s.role, ip }, { action: 'auth.login_failed', targetType: 'staff', targetId: s.id, details: { locked } });
      }
      throw new AuthError(msg, 401);
    };
    if (!s || !s.active) {
      await hashPassword('timing-equaliser'); // don't reveal which emails exist
      return fail();
    }
    if (s.locked_until && new Date(s.locked_until) > new Date()) throw new AuthError(`Too many tries. Try again in ${LOCK_MINUTES} minutes.`, 429);
    if (!(await verifyPassword(password ?? '', s.password_hash))) return fail();
    if (!s.totp_enabled) throw new AuthError('Your account isn\'t finished. Open your invite link to set it up.', 403);
    return { ticket: this.ticket(s.id, 'login') };
  }

  /** Step 2: the 6-digit code. Returns a session token for the cookie. */
  async loginCode(ticket: string, code: string, meta: { ip: string | null; ua: string | null }) {
    const t = this.takeTicket(ticket, 'login');
    const s = (await this.db.query('SELECT id, name, role, totp_secret FROM staff WHERE id=$1 AND active', [t.staffId])).rows[0];
    if (!s) throw new AuthError('Account not found.', 401);
    if (!verifyTotp(s.totp_secret, code)) {
      await audit(this.db, { staffId: s.id, name: s.name, role: s.role, ip: meta.ip }, { action: 'auth.code_failed', targetType: 'staff', targetId: s.id });
      throw new AuthError('That code isn\'t right. Use the latest 6-digit code in your authenticator app.', 401);
    }
    this.tickets.delete(ticket);
    return this.startSession(s, meta);
  }

  /** Finishing setup or an invite: confirm the authenticator works, then sign in. */
  async enroll(ticket: string, code: string, meta: { ip: string | null; ua: string | null }) {
    const t = this.takeTicket(ticket, 'enroll');
    if (!verifyTotp(t.secret!, code)) throw new AuthError('That code isn\'t right. Scan the QR code again and type the 6 digits you see.', 401);
    const s = (await this.db.query(
      'UPDATE staff SET totp_secret=$2, totp_enabled=true, failed_logins=0, locked_until=NULL WHERE id=$1 RETURNING id, name, role', [t.staffId, t.secret])).rows[0];
    this.tickets.delete(ticket);
    await audit(this.db, { staffId: s.id, name: s.name, role: s.role, ip: meta.ip }, { action: 'auth.two_step_enabled', targetType: 'staff', targetId: s.id });
    return this.startSession(s, meta);
  }

  private async startSession(s: { id: string; name: string; role: string }, meta: { ip: string | null; ua: string | null }) {
    const token = randomToken(32);
    await this.db.query(
      `INSERT INTO staff_sessions (id, staff_id, expires_at, ip, user_agent) VALUES ($1,$2, now() + make_interval(days => $3), $4, $5)`,
      [sha256(token), s.id, SESSION_DAYS, meta.ip, meta.ua?.slice(0, 200) ?? null]);
    await this.db.query('UPDATE staff SET last_login_at=now(), failed_logins=0, locked_until=NULL WHERE id=$1', [s.id]);
    await audit(this.db, { staffId: s.id, name: s.name, role: s.role, ip: meta.ip }, { action: 'auth.login', targetType: 'staff', targetId: s.id });
    return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
  }

  /** The signed-in staff member for a cookie, or null. Slides the idle timer. */
  async fromSession(token: string | undefined): Promise<(StaffMember & { sessionId: string }) | null> {
    if (!token) return null;
    const id = sha256(token);
    const r = await this.db.query(
      `SELECT s.id, s.email, s.name, s.role, s.active, s.totp_enabled, s.created_at, s.last_login_at, x.id AS session_id
       FROM staff_sessions x JOIN staff s ON s.id=x.staff_id
       WHERE x.id=$1 AND x.expires_at > now() AND x.last_seen > now() - make_interval(hours => $2) AND s.active`, [id, IDLE_HOURS]);
    if (!r.rows[0]) return null;
    await this.db.query('UPDATE staff_sessions SET last_seen=now() WHERE id=$1', [id]);
    const { session_id, ...staff } = r.rows[0];
    return { ...staff, sessionId: session_id };
  }

  async logout(token: string | undefined, actor: Actor) {
    if (!token) return;
    await this.db.query('DELETE FROM staff_sessions WHERE id=$1', [sha256(token)]);
    await audit(this.db, actor, { action: 'auth.logout', targetType: 'staff', targetId: actor.staffId });
  }

  // ---------- team (owner only; checked by the caller) ----------
  async invite(actor: Actor, input: { email: string; name: string; role: Role }) {
    if (!ROLES.includes(input.role)) throw new AuthError('Pick a role.');
    if (!input.name?.trim()) throw new AuthError('Please enter their name.');
    const email = cleanEmail(input.email);
    const existing = (await this.db.query('SELECT id, totp_enabled FROM staff WHERE email=$1', [email])).rows[0];
    if (existing?.totp_enabled) throw new AuthError('Someone with that email is already on the team.', 409);
    const r = await this.db.query(
      `INSERT INTO staff (email, name, role) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, active=true RETURNING id`,
      [email, input.name.trim().slice(0, 60), input.role]);
    const url = await this.newInvite(r.rows[0].id, actor.staffId);
    await audit(this.db, actor, { action: 'staff.invite', targetType: 'staff', targetId: r.rows[0].id, details: { email, name: input.name.trim(), role: input.role } });
    return { id: r.rows[0].id, inviteUrl: url };
  }

  /** A one-time link (valid 72 hours) to set a password and authenticator. Also used to reset someone's login. */
  async newInvite(staffId: string, by: string | null): Promise<string> {
    const token = randomToken(32);
    await this.db.query('UPDATE staff_invites SET used_at=now() WHERE staff_id=$1 AND used_at IS NULL', [staffId]);
    await this.db.query(`INSERT INTO staff_invites (id, staff_id, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '72 hours')`, [sha256(token), staffId, by]);
    return `${this.o.baseUrl.replace(/\/$/, '')}/console/invite/${token}`;
  }

  async inviteInfo(token: string) {
    const r = await this.db.query(
      `SELECT s.id, s.email, s.name, s.role FROM staff_invites i JOIN staff s ON s.id=i.staff_id
       WHERE i.id=$1 AND i.used_at IS NULL AND i.expires_at > now() AND s.active`, [sha256(token)]);
    if (!r.rows[0]) throw new AuthError('This invite link has expired or was already used. Ask the owner for a new one.', 404);
    return r.rows[0] as { id: string; email: string; name: string; role: Role };
  }

  async acceptInvite(token: string, password: string, ip: string | null) {
    const info = await this.inviteInfo(token);
    const weak = weakPassword(password ?? '');
    if (weak) throw new AuthError(weak);
    await this.db.query('UPDATE staff SET password_hash=$2, totp_enabled=false, totp_secret=NULL WHERE id=$1', [info.id, await hashPassword(password)]);
    await this.db.query('UPDATE staff_invites SET used_at=now() WHERE id=$1', [sha256(token)]);
    await this.db.query('DELETE FROM staff_sessions WHERE staff_id=$1', [info.id]);
    await audit(this.db, { staffId: info.id, name: info.name, role: info.role, ip }, { action: 'staff.invite_accepted', targetType: 'staff', targetId: info.id });
    return this.enrollment(info.id, info.email);
  }

  async setRole(actor: Actor, staffId: string, role: Role) {
    if (!ROLES.includes(role)) throw new AuthError('Pick a role.');
    if (staffId === actor.staffId) throw new AuthError('You can\'t change your own role.');
    if (role !== 'OWNER') await this.keepAnOwner(staffId);
    const before = (await this.db.query('SELECT role FROM staff WHERE id=$1', [staffId])).rows[0];
    await this.db.query('UPDATE staff SET role=$2 WHERE id=$1', [staffId, role]);
    await audit(this.db, actor, { action: 'staff.role', targetType: 'staff', targetId: staffId, details: { from: before?.role, to: role } });
  }

  async setActive(actor: Actor, staffId: string, active: boolean) {
    if (staffId === actor.staffId) throw new AuthError('You can\'t deactivate yourself.');
    if (!active) await this.keepAnOwner(staffId);
    await this.db.query('UPDATE staff SET active=$2 WHERE id=$1', [staffId, active]);
    if (!active) await this.db.query('DELETE FROM staff_sessions WHERE staff_id=$1', [staffId]);
    await audit(this.db, actor, { action: active ? 'staff.reactivate' : 'staff.deactivate', targetType: 'staff', targetId: staffId });
  }

  async resetLogin(actor: Actor, staffId: string) {
    await this.db.query('UPDATE staff SET totp_enabled=false, totp_secret=NULL WHERE id=$1', [staffId]);
    await this.db.query('DELETE FROM staff_sessions WHERE staff_id=$1', [staffId]);
    const url = await this.newInvite(staffId, actor.staffId);
    await audit(this.db, actor, { action: 'staff.reset_login', targetType: 'staff', targetId: staffId });
    return url;
  }

  private async keepAnOwner(changing: string) {
    const r = await this.db.query(`SELECT count(*)::int AS n FROM staff WHERE role='OWNER' AND active AND id<>$1`, [changing]);
    const isOwner = (await this.db.query(`SELECT 1 FROM staff WHERE id=$1 AND role='OWNER'`, [changing])).rowCount;
    if (isOwner && r.rows[0].n === 0) throw new AuthError('Hoolam needs at least one active owner.');
  }
}


function cleanEmail(e: string): string {
  const email = (e ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Please enter a valid email address.');
  return email;
}
