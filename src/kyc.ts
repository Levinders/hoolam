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
export type KycFailure = 'BAD_NUMBER' | 'NOT_FOUND' | 'DOB_MISMATCH' | 'UNAVAILABLE' | 'NO_TRIES';
export type KycResult = { ok: true; name: string } | { ok: false; reason: KycFailure; triesLeft: number };

/** What a checker found. `dob` is YYYY-MM-DD (null when it didn't say). */
export type CheckerAnswer =
  | { found: true; name: string; dob: string | null; reference: string | null }
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
  bvnPath?: string;        // /verification/bvn_validation  (body: { number })
  ninPath?: string;        // /verification/vnin            (body: { number_nin })
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class PremblyChecker implements KycChecker {
  readonly name = 'prembly' as const;
  constructor(private readonly o: PremblyOptions) {}

  async check(method: KycMethod, number: string): Promise<CheckerAnswer> {
    const base = (this.o.baseUrl || 'https://api.prembly.com').replace(/\/$/, '');
    const path = method === 'BVN' ? this.o.bvnPath || '/verification/bvn_validation' : this.o.ninPath || '/verification/vnin';
    const body = method === 'BVN' ? { number } : { number_nin: number };
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
    if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429 || res.status === 402) {
      this.o.log?.(`prembly ${method}: HTTP ${res.status} ${detail}`);
      return { unavailable: true, why: `HTTP ${res.status} ${detail}` };
    }
    if (!json) return { unavailable: true, why: `HTTP ${res.status}: not JSON` };
    const reference = String(json.verification?.reference ?? json.billing_info?.reference_id ?? json.reference_id ?? json.verification?.verification_id ?? '').trim() || null;
    if (json.status === true && (json.response_code == null || String(json.response_code) === '00')) {
      const d = json.data ?? json.nin_data ?? json.bvn_data ?? {};
      const pick = (...keys: string[]) => keys.map((k) => d[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      const name = [pick('firstName', 'firstname', 'first_name'), pick('middleName', 'middlename', 'middle_name'), pick('lastName', 'surname', 'last_name')]
        .filter(Boolean).join(' ').trim();
      if (!name) { this.o.log?.(`prembly ${method}: found, but no name in the answer`); return { unavailable: true, why: 'no name in the answer' }; }
      return { found: true, name, dob: readDate(pick('dateOfBirth', 'birthdate', 'date_of_birth', 'dob') ?? ''), reference };
    }
    // a "no" that's really about our account or their service, not the number
    if (/insufficient|wallet|balance|unauthori[sz]ed|credential|api key|service|timeout|timed out|unavailable|try again|maintenance/i.test(detail)) {
      this.o.log?.(`prembly ${method}: ${json.response_code ?? ''} ${detail}`);
      return { unavailable: true, why: detail };
    }
    return { found: false, reference };
  }
}

// ---------------------------------------------------------------------------------------------
// Pretend checker (test mode, like the fake payments)
// ---------------------------------------------------------------------------------------------
/**
 * Any 11 digits pass, with the date of birth typed. 00000000000 = not found, 11111111111 = date of birth
 * doesn't match, 99999999999 = the checker is down. The name matches the fake bank's account name, so
 * payout accounts pass the name check unless `names` says otherwise.
 */
export class FakeKycChecker implements KycChecker {
  readonly name = 'fake' as const;
  /** The name returned for a number (default: the fake bank's account name). */
  names: Record<string, string> = {};
  defaultName = 'TEST ACCOUNT HOLDER';
  async check(_method: KycMethod, number: string, dob: string): Promise<CheckerAnswer> {
    if (number === '00000000000') return { found: false, reference: null };
    if (number === '99999999999') return { unavailable: true, why: 'pretend outage' };
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
}

export class KycService {
  constructor(private readonly db: Db, readonly checker: KycChecker, private readonly log?: (line: string) => void) {}

  /** Can people verify right now (a checker is set up)? */
  get available(): boolean { return this.checker.name !== 'off'; }
  get testMode(): boolean { return this.checker.name === 'fake'; }

  async status(userId: string): Promise<KycStatus> {
    const u = (await this.db.query('SELECT kyc_status, kyc_verified_at, kyc_method, kyc_name, kyc_last4, kyc_ref, kyc_review_reason FROM users WHERE id=$1', [userId])).rows[0] ?? {};
    const verified = u.kyc_status === 'VERIFIED' && !!u.kyc_verified_at;
    return {
      status: verified ? 'VERIFIED' : u.kyc_status === 'REVIEW' ? 'REVIEW' : 'UNVERIFIED', verified,
      name: u.kyc_name ?? null, method: u.kyc_method ?? null, last4: u.kyc_last4 ?? null,
      at: u.kyc_verified_at ?? null, reference: u.kyc_ref ?? null, reviewReason: u.kyc_review_reason ?? null,
    };
  }

  /** Failed tries today (Lagos time). A try that failed because the checker was down doesn't count. */
  async triesLeft(userId: string): Promise<number> {
    const r = await this.db.query(
      `SELECT count(*)::int AS n FROM kyc_checks WHERE user_id=$1 AND result IN ('NOT_FOUND','DOB_MISMATCH')
         AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')`, [userId]);
    return Math.max(0, KYC_TRIES_PER_DAY - r.rows[0].n);
  }

  /** Checks the ID. On success the person is verified for good. `dob` is YYYY-MM-DD. */
  async verify(userId: string, method: KycMethod, rawNumber: string, dob: string): Promise<KycResult> {
    const number = rawNumber.replace(/\D/g, '');
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
    await record('VERIFIED', a.reference);
    await this.db.query(
      `UPDATE users SET kyc_status='VERIFIED', kyc_verified_at=now(), kyc_method=$2, kyc_name=$3, kyc_last4=$4, kyc_ref=$5,
              kyc_review_reason=NULL, kyc_review_at=NULL WHERE id=$1`, [userId, method, name, last4, a.reference]);
    return { ok: true, name };
  }

  /** Puts someone in Needs review (unless they're verified). */
  async markReview(userId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='REVIEW', kyc_review_reason=$2, kyc_review_at=now() WHERE id=$1 AND kyc_status <> 'VERIFIED'`, [userId, reason.slice(0, 200)]);
  }

  /** Staff: mark someone verified after checking their ID another way. */
  async approve(userId: string, name: string, staffRef: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='VERIFIED', kyc_verified_at=now(), kyc_method=CASE WHEN kyc_status='VERIFIED' THEN kyc_method ELSE 'MANUAL' END,
              kyc_name=$2, kyc_ref=COALESCE(CASE WHEN kyc_status='VERIFIED' THEN kyc_ref END, $3), kyc_review_reason=NULL, kyc_review_at=NULL WHERE id=$1`,
      [userId, titleName(name), staffRef]);
  }

  /** Staff: take the verification away (they'd verify again). */
  async remove(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET kyc_status='UNVERIFIED', kyc_verified_at=NULL, kyc_method=NULL, kyc_name=NULL, kyc_last4=NULL, kyc_ref=NULL,
              kyc_review_reason=NULL, kyc_review_at=NULL WHERE id=$1`, [userId]);
  }

  /** Staff: take someone off Needs review without verifying them. */
  async clearReview(userId: string): Promise<void> {
    await this.db.query(`UPDATE users SET kyc_status='UNVERIFIED', kyc_review_reason=NULL, kyc_review_at=NULL WHERE id=$1 AND kyc_status='REVIEW'`, [userId]);
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
