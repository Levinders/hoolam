import type { Db } from './db.js';

/**
 * Every webhook is saved first (deduplicated by source + event_key), acknowledged, then processed.
 * If processing fails, the event stays unprocessed and the worker retries it.
 */
export async function storeEvent(db: Db, source: string, eventKey: string, payload: unknown): Promise<number | null> {
  const r = await db.query(
    `INSERT INTO webhook_events (source, event_key, payload) VALUES ($1,$2,$3) ON CONFLICT (source, event_key) DO NOTHING RETURNING id`,
    [source, eventKey, JSON.stringify(payload)],
  );
  return r.rows[0]?.id ?? null; // null = already seen
}

export type Handler = (payload: any) => Promise<'done' | 'retry'>;

export async function processEvent(db: Db, id: number, handler: Handler, log?: (l: string) => void): Promise<void> {
  // Claim the row so two workers never process the same event at once.
  const claim = await db.query(
    `UPDATE webhook_events SET attempts = attempts + 1 WHERE id = (
       SELECT id FROM webhook_events WHERE id=$1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED
     ) RETURNING payload`, [id]);
  if (!claim.rows[0]) return;
  try {
    const result = await handler(claim.rows[0].payload);
    if (result === 'done') await db.query('UPDATE webhook_events SET processed_at=now(), last_error=NULL WHERE id=$1', [id]);
  } catch (e) {
    log?.(`webhook ${id} failed: ${(e as Error).message}`);
    await db.query('UPDATE webhook_events SET last_error=$2 WHERE id=$1', [id, (e as Error).message.slice(0, 500)]);
  }
}

export async function pendingEvents(db: Db, source: string, maxAttempts = 10): Promise<number[]> {
  const r = await db.query(
    `SELECT id FROM webhook_events WHERE source=$1 AND processed_at IS NULL AND attempts < $2
       AND received_at < now() - interval '30 seconds' ORDER BY id LIMIT 50`, [source, maxAttempts]);
  return r.rows.map((x) => x.id);
}
