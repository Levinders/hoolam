import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const db = createPool(loadConfig().DATABASE_URL);
const applied = await migrate(db, console.log);
console.log(applied.length ? `Done: ${applied.length} migration(s).` : 'Database is up to date.');
await db.end();
