import type { Queryable } from '../db.js';

/** Who is acting. Every console action carries one, so the trail always says who and when. */
export interface Actor { staffId: string | null; name: string; role: string; ip?: string | null }

export const SYSTEM: Actor = { staffId: null, name: 'System', role: 'SYSTEM' };

export interface AuditEntry {
  action: string;              // e.g. deal.release
  targetType?: string;         // deal, payout, user, staff, settings, support
  targetId?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

/** Appends to the audit trail. The table refuses updates and deletes, so the trail can't be rewritten. */
export async function audit(q: Queryable, actor: Actor, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (staff_id, actor, action, target_type, target_id, reason, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.staffId, actor.name, e.action, e.targetType ?? null, e.targetId ?? null, e.reason ?? null, JSON.stringify(e.details ?? {}), actor.ip ?? null],
  );
}
