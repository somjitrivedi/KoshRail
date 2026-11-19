import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export interface Migration {
  name: string;
  sql: string;
}

const KIT_MIGRATION: Migration = {
  name: '000_kit',
  sql: `
CREATE TABLE _outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX _outbox_unsent ON _outbox(seq) WHERE sent_at IS NULL;
CREATE TABLE _inbox (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);
CREATE TABLE _idempotency (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`,
};

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

export function migrate(db: Db, migrations: Migration[]): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM _migrations').pluck().all() as string[]);
  const ran: string[] = [];
  for (const m of [KIT_MIGRATION, ...migrations]) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString());
    }).immediate();
    ran.push(m.name);
  }
  return ran;
}

export function openDb(file: string, migrations: Migration[] | string = []): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, typeof migrations === 'string' ? loadMigrations(migrations) : migrations);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function migrationsDir(metaUrl: string): string {
  return join(dirname(fileURLToPath(metaUrl)), '..', 'migrations');
}
