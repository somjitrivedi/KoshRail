import { describe, expect, it } from 'vitest';
import { badRequest, conflict, idempotent, openDb, stableStringify, ulid } from '../src/index.ts';

function setup() {
  const db = openDb(':memory:', [{ name: '001', sql: 'CREATE TABLE writes (id INTEGER PRIMARY KEY, v TEXT)' }]);
  const count = () => db.prepare('SELECT COUNT(*) FROM writes').pluck().get() as number;
  return { db, count };
}

describe('idempotency', () => {
  it('executes once and replays the stored response', () => {
    const { db, count } = setup();
    const run = () =>
      idempotent(db, 'pay', 'key-00000001', { amount: 5 }, () => {
        db.prepare('INSERT INTO writes (v) VALUES (?)').run('x');
        return { status: 201, body: { ok: true, n: count() } };
      });
    const first = run();
    const results = Array.from({ length: 100 }, run);
    expect(first.replayed).toBe(false);
    expect(results.every((r) => r.replayed && r.status === 201 && r.body.n === 1)).toBe(true);
    expect(count()).toBe(1);
  });

  it('rejects reuse of a key with a different request', () => {
    const { db } = setup();
    idempotent(db, 'pay', 'key-00000002', { amount: 5 }, () => ({ status: 200, body: {} }));
    expect(() => idempotent(db, 'pay', 'key-00000002', { amount: 6 }, () => ({ status: 200, body: {} }))).toThrow(/different request/);
  });

  it('stores business errors and rolls back their partial writes', () => {
    const { db, count } = setup();
    const run = () =>
      idempotent(db, 'pay', 'key-00000003', {}, () => {
        db.prepare('INSERT INTO writes (v) VALUES (?)').run('partial');
        throw badRequest('NOPE', 'not allowed');
      });
    const a = run();
    const b = run();
    expect(a.status).toBe(400);
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual({ error: { code: 'NOPE', message: 'not allowed' } });
    expect(count()).toBe(0);
  });

  it('does not store conflicts so the caller may retry', () => {
    const { db } = setup();
    expect(() => idempotent(db, 's', 'key-00000004', {}, () => { throw conflict('BUSY', 'busy'); })).toThrow(/busy/);
    const ok = idempotent(db, 's', 'key-00000004', {}, () => ({ status: 200, body: { ok: 1 } }));
    expect(ok.replayed).toBe(false);
  });

  it('scopes keys independently', () => {
    const { db } = setup();
    const a = idempotent(db, 'a', 'key-00000005', {}, () => ({ status: 200, body: 'a' }));
    const b = idempotent(db, 'b', 'key-00000005', {}, () => ({ status: 200, body: 'b' }));
    expect([a.body, b.body]).toEqual(['a', 'b']);
  });
});

describe('ids', () => {
  it('generates sortable unique ulids', () => {
    const ids = Array.from({ length: 2000 }, () => ulid());
    expect(new Set(ids).size).toBe(2000);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('stringifies objects with stable key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":2,"y":1}]},"b":1}');
  });
});
