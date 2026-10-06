/**
 * Spins up a throwaway Postgres + the whole app with the fake payment provider and WhatsApp in dry-run mode.
 * Used by the tests and by `npm run simulate`. Nothing here touches real money or real WhatsApp.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { FakeProvider } from '../src/payments/fake.js';
import type { Inbound } from '../src/whatsapp/inbound.js';

export interface Harness {
  db: Db;
  provider: FakeProvider;
  app: ReturnType<typeof buildApp>;
  transcript: { phone: string; text: string }[];
  say(phone: string, text: string, name?: string): Promise<void>;
  tap(phone: string, buttonId: string, title?: string): Promise<void>;
  last(phone: string): string;
  stop(): Promise<void>;
}

let n = 0;

export async function startHarness(opts: { quiet?: boolean; onMessage?: (phone: string, text: string) => void; env?: Record<string, string> } = {}): Promise<Harness> {
  const port = 55000 + Math.floor(Math.random() * 4000);
  const dir = join(process.platform === 'win32' ? tmpdir() : '/var/tmp', `hoolam-pg-${process.pid}-${port}`);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'hoolam', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('hoolam');
  const db = createPool(`postgres://postgres:hoolam@localhost:${port}/hoolam`);
  await migrate(db);

  const transcript: { phone: string; text: string }[] = [];
  const log = (line: string) => {
    const m = line.match(/^\[whatsapp → (\+\d+)\] ([\s\S]*)$/);
    if (m) { transcript.push({ phone: m[1]!, text: m[2]! }); opts.onMessage?.(m[1]!, m[2]!); }
    else if (!opts.quiet) console.log(line);
  };
  const config = loadConfig({
    DATABASE_URL: 'unused', ADMIN_TOKEN: 'test-admin-token-123456', PAYMENT_PROVIDER: 'fake', WHATSAPP_DRY_RUN: 'true',
    WHATSAPP_PUBLIC_NUMBER: '2349000000000',
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const provider = new FakeProvider();
  const app = buildApp({ config, db, provider, log });
  await app.settings.load();

  const deliver = (m: Inbound) => app.chat.handle(m);
  return {
    db, provider, app, transcript,
    say: (phone, text, name) => deliver({ id: `m${++n}`, phone, name: name ?? null, type: 'text', text, buttonId: null, mediaId: null }),
    tap: (phone, buttonId, title) => deliver({ id: `m${++n}`, phone, name: null, type: 'button', text: title ?? buttonId, buttonId, mediaId: null }),
    last: (phone) => [...transcript].reverse().find((t) => t.phone === phone)?.text ?? '',
    stop: async () => {
      await app.app.close();
      await new Promise((r) => setTimeout(r, 200)); // let in-flight webhook work finish
      await db.end();
      await pg.stop();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
