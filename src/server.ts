import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { createProvider } from './payments/index.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db, console.log);
const provider = createProvider(config);
const { app, tick } = buildApp({ config, db, provider });

const guard = (kind: 'fast' | 'slow') => async () => {
  try { await tick(kind); } catch (e) { console.error(`${kind} tick failed:`, (e as Error).message); }
};
const fast = setInterval(guard('fast'), 30_000);
const slow = setInterval(guard('slow'), 10 * 60_000);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Hoolam listening on :${config.PORT} · payments: ${provider.name} · WhatsApp: ${config.WHATSAPP_DRY_RUN ? 'dry run' : 'live'}${config.ALLOW_SELF_DEAL ? ' · TEST MODE' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(fast); clearInterval(slow);
    await app.close(); await db.end();
    process.exit(0);
  });
}
