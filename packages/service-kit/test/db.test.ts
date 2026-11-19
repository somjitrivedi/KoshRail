import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tempDir } from '@kosh/test-kit';
import { migrate, openDb, tx } from '../src/index.ts';

const migrations = [
  { name: '001_items', sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)' },
  { name: '002_tags', sql: 'CREATE TABLE tags (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id))' },
];

describe('sqlite helpers', () => {
  it('runs migrations once and is idempotent across reopen', () => {
    const dir = tempDir();
    const file = join(dir.path, 'svc.db');
    const db = openDb(file, migrations);
    expect(db.prepare('SELECT name FROM _migrations ORDER BY name').pluck().all()).toEqual(['000_kit', '001_items', '002_tags']);
    expect(migrate(db, migrations)).toEqual([]);
    db.close();
    const again = openDb(file, migrations);
    expect(migrate(again, migrations)).toEqual([]);
    expect(again.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(again.pragma('foreign_keys', { simple: true })).toBe(1);
    again.close();
    dir.cleanup();
  });

  it('applies only new migrations when the list grows', () => {
    const db = openDb(':memory:', migrations.slice(0, 1));
    expect(migrate(db, migrations)).toEqual(['002_tags']);
  });

  it('rolls back the whole transaction on error', () => {
    const db = openDb(':memory:', migrations);
    expect(() =>
      tx(db, () => {
        db.prepare('INSERT INTO items (name) VALUES (?)').run('a');
        db.prepare('INSERT INTO items (name) VALUES (?)').run('a');
      }),
    ).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(0);
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:', migrations);
    expect(() => db.prepare('INSERT INTO tags (item_id) VALUES (99)').run()).toThrow(/FOREIGN KEY/);
  });
});
