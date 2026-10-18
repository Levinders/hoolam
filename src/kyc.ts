import { createHmac } from 'node:crypto';
import type { Db } from './db.js';

/**
 * ID CHECKS (KYC). Done once per person, with their BVN or NIN (their choice) and date of birth.
 *   - needed for an order above the no-ID limit (Console → Settings → Limits), on either side
 *   - needed by every seller before their payout account; then the account name must match the ID
 *   - 3 tries a day; after that a rep looks at it (Needs review in the console)
 * We store only the result: the name on the ID, the last 4 digits, the method and the checker's reference.
 * Never the BVN or NIN itself (the chat message that carried it is blanked too).
 *
 * Checkers: Prembly (live), a pretend one for test mode (like the fake payments), or none (switched off).
 */

export type KycMethod = 'BVN' | 'NIN';
export type KycFailure = 'BAD_NUMBER' | 'NOT_FOUND' | 'DOB_MISMATCH' | 'UNAVAILABLE' | 'NO_TRIES' | 'IN_REVIEW' | 'DECLINED';
/** `fresh`: this check is what put them in review (IN_REVIEW only). */
export type KycResult = { ok: true; name: string } | { ok: false; reason: KycFailure; triesLeft: number; fresh?: boolean };

/**
 * What a checker found. `dob` is YYYY-MM-DD (null when it didn't say).
 * `flag`: the ID exists but its issuer has flagged it (a BVN watchlisted by NIBSS, a NIN suspended by NIMC).
 */
export type CheckerAnswer =
  | { found: true; name: string; dob: string | null; reference: string | null; flag?: string | null }
  | { found: false; reference?: string | null }
  | { unavailable: true; why: string };

export interface KycChecker {
  readonly name: 'prembly' | 'fake' | 'off';
  check(method: KycMethod, number: string, dob: string): Promise<CheckerAnswer>;
}

export const KYC_TRIES_PER_DAY = 3;

// ---------------------------------------------------------------------------------------------
// Prembly
// ---------------------------------------------------------------------------------------------
export interface PremblyOptions {
  apiKey: string;
  appId?: string;
  baseUrl?: string;        // https://api.prembly.com
  bvnPath?: string;        // /verification/bvn_validation  (BVN Basic)
  ninPath?: string;        // /verification/vnin-basic      (NIN Basic)
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export const PREMBLY_BVN_PATH = '/verification/bvn_validation';
export const PREMBLY_NIN_PATH = '/verification/vnin-basic';

export class PremblyChecker implements KycChecker {
  readonly name = 'prembly' as const;
  constructor(private readonly o: PremblyOptions) {}

  async check(method: KycMethod, number: string): Promise<CheckerAnswer> {
    const base = (this.o.baseUrl || 'https://api.prembly.com').replace(/\/$/, '');
    const path = method === 'BVN' ? this.o.bvnPath || PREMBLY_BVN_PATH : this.o.ninPath || PREMBLY_NIN_PATH;
    const body = { number }; // BVN Basic and NIN Basic both take just the number
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': this.o.apiKey };
    if (this.o.appId) headers['app-id'] = this.o.appId;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(base + (path.startsWith('/') ? path : '/' + path), {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 25_000),
      });
    } catch (e) {
      return { unavailable: true, why: `network: ${(e as Error).message}` };
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    const detail = String(json?.detail ?? json?.message ?? '').slice(0, 200);
    // our side (keys, wallet) or theirs (down, busy): tell the person to try again, nothing is lost
    if (res.status >= 500 || [401, 402, 403, 404, 405, 429].includes(res.status)) {
      this.o.log?.(`prembly ${method}: HTTP ${res.status} ${detail} (${path})${res.status === 404 || res.status === 405 ? ': check PREMBLY_' + method + '_PATH' : ''}`);
      return { unavailable: true, why: `HTTP ${res.status} ${detail}` };
    }
    // a refused request (wrong body or address) is our setup, not their number: unless it plainly says "not found"
    if (res.status >= 400 && !/not found|no record|does not exist|invalid (bvn|nin)|record not/i.test(detail)) {
      this.o.log?.(`prembly ${method}: HTTP ${res.status} ${detail} (${path}): the request was refused, check the address and fields`);
      return { unavailable: true, why: `HTTP ${res.status} ${detail}` };
    }
    if (!json) return { unavailable: true, why: `HTTP ${res.status}: not JSON` };
    const reference = String(json.data?.verification_reference ?? json.verification?.reference ?? json.billing_info?.reference_id ?? json.reference_id ?? json.verification?.verification_id ?? '').trim() || null;
    if (json.status === true && (json.response_code == null || String(json.response_code) === '00')) {
      const d = json.data ?? json.nin_data ?? json.bvn_data ?? {};
      const pick = (...keys: string[]) => keys.map((k) => d[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      const name = [pick('firstName', 'firstname', 'first_name'), pick('middleName', 'middlename', 'middle_name'), pick('lastName', 'surname', 'last_name')]
        .filter(Boolean).join(' ').trim();
      if (!name) { this.o.log?.(`prembly ${method}: found, but no name in the answer`); return { unavailable: true, why: 'no name in the answer' }; }
      // flagged by the issuer: NIBSS watchlist (BVN Basic), NIMC suspension (NIN Basic)
      const flag = method === 'BVN'
        ? (isYes(d.watchListed ?? d.watchlisted ?? d.watch_listed) ? 'BVN watchlisted by NIBSS' : null)
        : (isYes(d.nin_suspension_status ?? d.suspended) ? 'NIN suspended by NIMC' : null);
      return { found: true, name, dob: readDate(pick('dateOfBirth', 'birthdate', 'date_of_birth', 'dob') ?? ''), reference, flag };
    }
    // a "no" that's really about our account or their service, not the number
    if (/insufficient|wallet|balance|unauthori[sz]ed|credential|api key|service|timeout|timed out|unavailable|try again|maintenance/i.test(detail)) {
      this.o.log?.(`prembly ${method}: ${json.response_code ?? ''} ${detail}`);
      return { unavailable: true, why: detail };
    }
    return { found: false, reference };
  }
}

const isYes = (v: unknown) => v === true || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));

// ---------------------------------------------------------------------------------------------
// Pretend checker (test mode, like the fake payments)
// ---------------------------------------------------------------------------------------------
/**
 * Any 11 digits pass, with the date of birth typed. 00000000000 = not found, 11111111111 = date of birth
 * doesn't match, 99999999999 = the checker is down, 22222222222 = flagged (goes to Needs review). The name matches the fake bank's account name, so
 * payout accounts pass the name check unless `names` says otherwise.
 */
export class FakeKycChecker implements KycChecker {
  readonly name = 'fake' as const;
  /** The name returned for a number (default: the fake bank's account name). */
  names: Record<string, string> = {};
  defaultName = 'TEST ACCOUNT HOLDER';
  async check(method: KycMethod, number: string, dob: string): Promise<CheckerAnswer> {
    if (number === '00000000000') return { found: false, reference: null };
    if (number === '99999999999') return { unavailable: true, why: 'pretend outage' };
    if (number === '22222222222') return { found: true, name: this.names[number] ?? this.defaultName, dob, reference: 'FAKE-KYC-FLAG', flag: method === 'BVN' ? 'BVN watchlisted by NIBSS' : 'NIN suspended by NIMC' };
    if (number === '11111111111') return { found: true, name: this.names[number] ?? this.defaultName, dob: '1970-01-01', reference: 'FAKE-KYC' };
    return { found: true, name: this.names[number] ?? this.defaultName, dob, reference: `FAKE-KYC-${number.slice(-4)}` };
  }
}

/** Switched off: no checks, so the no-ID limit is the most anyone can do (unless staff raise it for a person). */
export class NoKycChecker implements KycChecker {
  readonly name = 'off' as const;
  async check(): Promise<CheckerAnswer> { return { unavailable: true, why: 'ID checks are switched off' }; }
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------
export interface KycStatus {
  status: 'UNVERIFIED' | 'VERIFIED' | 'REVIEW';
  verified: boolean;
  name: string | null;
  method: 'BVN' | 'NIN' | 'MANUAL' | null;
  last4: string | null;
  at: Date | null;
  reference: string | null;
  reviewReason: string | null;
  /** Flagged by the ID's issuer: no more checks until the team decides. */
  flag: string | null;
  declined: boolean;
}

export interface KycServiceOptions {
  /**
   * The bank names are pretend (pretend money) while the ID checks are real: payout accounts can't be matched to the
   * ID name, so that match is skipped until real payments (Monnify) come on. Then it applies by itself.
   */
  skipAccountMatch?: boolean;
  /** Key for the one-way code of each checked ID number (users.kyc_id_hash), so two accounts of one person can be spotted. */
  idSecret?: string;
}

/** A one-way code of an ID number: the same number always gives the same code, and the number can't be read back. */
export function idHash(secret: string, method: KycMethod, number: string): string {
  return createHmac('sha256', secret).update(`${method}:${number.replace(/\D/g, '')}`).digest('hex').slice(0, 40);
}

export class KycService {
  constructor(private readonly db: Db, readonly checker: KycChecker, private readonly log?: (line: string) => void, private readonly opts: KycServiceOptions = {}) {}

  /** Is this payout account in the name on their ID? (Always yes while the bank names are pretend: see skipAccountMatch.) */
  accountMatches(idName: string | null | undefined, accountName: string | null | undefined): boolean {
    return this.opts.skipAccountMatch ? true : namesMatch(idName, accountName);
  }
  get skipsAccountMatch(): boolean { return !!this.opts.skipAccountMatch; }

  /** Flagged and waiting for the team ('REVIEW'), or the team declined ('DECLINED'): no more checks. Null: they can check. */
  async blocked(userId: string): Promise<'REVIEW' | 'DECLINED' | null> {
    const u = (await this.db.query('SELECT kyc_status, kyc_flag, kyc_declined_at FROM users WHERE id=$1', [userId])).rows[0];
    if (!u || u.kyc_status === 'VERIFIED' || !u.kyc_flag) return null;
    return u.kyc_declined_at ? 'DECLINED' : 'REVIEW';
  }

  /** Can people verify right now (a checker is set up)? */
  get available(): boolean { return this.checker.name !== 'off'; }
  get testMode(): boolean { return this.checker.name === 'fake'; }

  async status(userId: string): Promise<KycStatus> {
    const u = (await this.db.query('SELECT kyc_status, kyc_verified_at, kyc_method, kyc_name, kyc_last4, kyc_ref, kyc_review_reason, kyc_flag, kyc_declined_at FROM users WHERE id=$1', [userId])).rows[0] ?? {};
    const verified = u.kyc_status === 'VERIFIED' && !!u.kyc_verified_at;
    return {
      status: verified ? 'VERIFIED' : u.kyc_status === 'REVIEW' ? 'REVIEW' : 'UNVERIFIED', verified,
      name: u.kyc_name ?? null, method: u.kyc_method ?? null, last4: u.kyc_last4 ?? null,
      at: u.kyc_verified_at ?? null, reference: u.kyc_ref ?? null, reviewReason: u.kyc_review_reason ?? null,
      flag: verified ? null : u.kyc_flag ?? null, declined: !verified && !!u.kyc_flag && !!u.kyc_declined_at,
    };
  }

  /** Failed tries today (Lagos time). A try that failed because the checker was down doesn't count. */
  async triesLeft(userId: string): Promise<number> {
    const r = await this.db.query(
      `SELECT count(*)::int AS n FROM kyc_checks WHERE user_id=$1 AND result IN ('NOT_FOUND','DOB_MISMATCH')
         AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')`, [userId]);
    return Math.max(0, KYC_TRIES_PER_DAY - r.rows[0].n);
  }

  /**
   * Checks the ID. On success the person is verified for good. `dob` is YYYY-MM-DD.
   * Never calls the checker (each call costs money) for someone already verified, or flagged and waiting for the team.
   */
  async verify(userId: string, method: KycMethod, rawNumber: string, dob: string): Promise<KycResult> {
    const number = rawNumber.replace(/\D/g, '');
    const now = (await this.db.query('SELECT kyc_status, kyc_verified_at, kyc_name, kyc_flag, kyc_declined_at FROM users WHERE id=$1', [userId])).rows[0];
    if (now?.kyc_status === 'VERIFIED' && now.kyc_verified_at && now.kyc_name) return { ok: true, name: now.kyc_name };
    if (now?.kyc_flag) return { ok: false, reason: now.kyc_declined_at ? 'DECLINED' : 'IN_REVIEW', triesLeft: 0 };
    let left = await this.triesLeft(userId);
    if (left <= 0) return { ok: false, reason: 'NO_TRIES', triesLeft: 0 };
    if (!/^\d{11}$/.test(number)) return { ok: false, reason: 'BAD_NUMBER', triesLeft: left };
    let a: CheckerAnswer;
    try { a = await this.checker.check(method, number, dob); }
    catch (e) { a = { unavailable: true, why: (e as Error).message }; }
    const last4 = number.slice(-4);
    const record = (result: string, reference: string | null) => this.db.query(
      'INSERT INTO kyc_checks (user_id, method, last4, result, provider, reference) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, method, last4, result, this.checker.name, reference]);
    if ('unavailable' in a) {
      this.log?.(`ID check unavailable (${this.checker.name}): ${a.why}`);
      await record('UNAVAILABLE', null);
      return { ok: false, reason: 'UNAVAILABLE', triesLeft: left };
    }
    if (!a.found || (a.dob && a.dob !== dob)) {
      const reason = a.found ? 'DOB_MISMATCH' : 'NOT_FOUND';
      await record(reason, a.reference ?? null);
      left -= 1;
      if (left <= 0) await this.markReview(userId, `${KYC_TRIES_PER_DAY} ID checks didn't pass today`);
      return { ok: false, reason, triesLeft: left };
    }
    const name = titleName(a.name);
    if (a.flag) {
      // the ID is real and the details match, but its issuer has flagged it: the team decides (doesn't use a try)
      await record('FLAGGED', a.reference);
      await this.db.query(
        `UPDATE users SET kyc_status='REVIEW', kyc_flag=$2, kyc_declined_at=NULL, kyc_review_reason=$3, kyc_review_at=now() WHERE id=$1 AND kyc_status <> 'VERIFIED'`,
        [userId, a.flag.slice(0, 120), `${a.flag} (${method} ••••${last4}, name on it: ${name})`.slice(0, 200)]);
      this.log?.(`ID check flagged for review: ${a.flag}`);
      return { ok: false, reason: 'IN_REVIEW', triesLeft: left, fresh: true };
    }
    await record('VERIFIED', a.reference);
    await this.db.query(
      `UPDATE users SET kyc_status='VERIFIED', kyc_verified_at=now(), kyc_method=$2, kyc_name=$3, kyc_last4=$4, kyc_ref=$5,
              kyc_review_reason=NULL, kyc_review_at=NULL, kyc_flag=NULL, kyc_declined_at=NULL, kyc_id_hash=$6 WHERE id=$1`,
      [userId, method, name, last4, a.reference, this.opts.idSecret ? idHash(this.opts.idSecret, method, number) : null]);
    return { ok: true, name };
  }

  /** Puts someone in Needs review (unless they're verified, or already flagged: that reason stays). */
  async markReview(userId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='REVIEW', kyc_review_reason=$2, kyc_review_at=now() WHERE id=$1 AND kyc_status <> 'VERIFIED' AND kyc_flag IS NULL`, [userId, reason.slice(0, 200)]);
  }

  /** Staff: mark someone verified after checking their ID another way. */
  async approve(userId: string, name: string, staffRef: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='VERIFIED', kyc_verified_at=now(), kyc_method=CASE WHEN kyc_status='VERIFIED' THEN kyc_method ELSE 'MANUAL' END,
              kyc_name=$2, kyc_ref=COALESCE(CASE WHEN kyc_status='VERIFIED' THEN kyc_ref END, $3), kyc_review_reason=NULL, kyc_review_at=NULL,
              kyc_flag=NULL, kyc_declined_at=NULL WHERE id=$1`,
      [userId, titleName(name), staffRef]);
  }

  /** Staff: take the verification away (they'd verify again). */
  async remove(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='UNVERIFIED', kyc_verified_at=NULL, kyc_method=NULL, kyc_name=NULL, kyc_last4=NULL, kyc_ref=NULL, kyc_id_hash=NULL,
              kyc_review_reason=NULL, kyc_review_at=NULL, kyc_flag=NULL, kyc_declined_at=NULL WHERE id=$1`, [userId]);
  }

  /** Staff: decline a flagged ID. They stay at the limit without ID, and no more checks run for them. */
  async decline(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='UNVERIFIED', kyc_declined_at=now(), kyc_review_reason=NULL, kyc_review_at=NULL
        WHERE id=$1 AND kyc_flag IS NOT NULL AND kyc_status <> 'VERIFIED'`, [userId]);
  }

  /** Staff: take someone off Needs review without verifying them. */
  async clearReview(userId: string): Promise<void> {
    await this.db.query(`UPDATE users SET kyc_status='UNVERIFIED', kyc_review_reason=NULL, kyc_review_at=NULL WHERE id=$1 AND kyc_status='REVIEW' AND kyc_flag IS NULL`, [userId]);
  }
}

// ---------------------------------------------------------------------------------------------
// Names and dates
// ---------------------------------------------------------------------------------------------
const TITLES = new Set(['mr', 'mrs', 'miss', 'ms', 'dr', 'chief', 'alhaji', 'alhaja', 'pastor', 'prof', 'engr', 'barr', 'hon', 'sir', 'madam']);
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z]+/).filter((w) => w.length >= 2 && !TITLES.has(w));

function closeEnough(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  // one letter added, removed or changed (Chidinma / Chidimma)
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Does a bank account name belong to the person on the ID? Tolerant: any order, middle names optional,
 * titles ignored, one-letter spelling slips allowed. Needs two names in common (one, if either has only one).
 */
export function namesMatch(idName: string | null | undefined, bankName: string | null | undefined): boolean {
  const a = words(idName ?? ''), b = words(bankName ?? '');
  if (!a.length || !b.length) return false;
  const hits = new Set(b.filter((w) => a.some((v) => closeEnough(v, w)))).size;
  return hits >= Math.min(2, a.length, b.length);
}

/** "CHIDERA ANITA JOHNSON" → "Chidera Anita Johnson". */
export function titleName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** A date as checkers write it: 01-Jan-2000, 22-05-1998, 1998-05-22, 22/05/1998. → YYYY-MM-DD (day first). */
export function readDate(s: string): string | null {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = t.match(/^(\d{1,2})[-/. ]+(\d{1,2})[-/. ]+(\d{4})$/);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[-/. ,]+([a-z]{3,})[-/. ,]+(\d{4})$/);
  if (m) { const mo = MONTHS.indexOf(m[2]!.slice(0, 3)); return mo < 0 ? null : iso(+m[3]!, mo + 1, +m[1]!); }
  m = t.match(/^([a-z]{3,})[-/. ]+(\d{1,2})(?:st|nd|rd|th)?[-/. ,]+(\d{4})$/);
  if (m) { const mo = MONTHS.indexOf(m[1]!.slice(0, 3)); return mo < 0 ? null : iso(+m[3]!, mo + 1, +m[2]!); }
  return null;
}

/** A date of birth someone typed (25/12/1995, 25-12-1995, 25 Dec 1995). Null if it isn't a real, sensible one. */
export function readDob(s: string, now = new Date()): string | null {
  const d = readDate(s.replace(/\s+/g, ' '));
  if (!d) return null;
  const year = Number(d.slice(0, 4));
  if (year < 1900 || year > now.getUTCFullYear() - 13) return null;
  return d;
}
