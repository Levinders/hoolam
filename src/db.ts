import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// BIGINT comes back as a string by default; our amounts fit safely in a JS number (< 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v); // DATE stays 'YYYY-MM-DD' (no time-zone surprises)

export function createPool(databaseUrl: string): Db {
  const needsSsl = /supabase\.(co|com)|sslmode=require/.test(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
  // An idle connection dropping (e.g. the database restarting) must not crash the server.
  pool.on('error', (e) => console.error('database connection error:', e.message));
  return pool;
}

/** Runs fn inside a transaction. Rolls back on any error. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
