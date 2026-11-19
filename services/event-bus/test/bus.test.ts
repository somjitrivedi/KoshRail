import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveredEvent } from '@kosh/contracts';
import { Consumer, emit, HttpBus, type Db, openDb, OutboxRelay, pendingOutbox, tx, migrationsDir } from '@kosh/service-kit';
import { serve, TEST_TOKEN, testLogger } from '@kosh/test-kit';
import { buildBusApp } from '../src/app.ts';

const log = testLogger();

describe('event bus with outbox and inbox', () => {
  let busDb: Db;
  let server: { url: string; close: () => Promise<void> };
  let bus: HttpBus;

  beforeEach(async () => {
    busDb = openDb(':memory:', migrationsDir(new URL('../src/main.ts', import.meta.url).href));
    server = await serve(buildBusApp({ db: busDb, log, internalToken: TEST_TOKEN }));
    bus = new HttpBus(server.url, TEST_TOKEN, 'test');
  });

  afterEach(async () => {
    await server.close();
    busDb.close();
  });

  function producerDb() {
    return openDb(':memory:', [{ name: '001', sql: 'CREATE TABLE orders (id TEXT PRIMARY KEY)' }]);
  }

  function consumerDb() {
    return openDb(':memory:', [{ name: '001', sql: 'CREATE TABLE seen (event_id TEXT, n INTEGER)' }]);
  }

  it('rejects calls without the internal token', async () => {
    const res = await fetch(`${server.url}/topics`);
    expect(res.status).toBe(401);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it('publishes outbox rows written in the same transaction as the state change', async () => {
    const db = producerDb();
    tx(db, () => {
      db.prepare('INSERT INTO orders (id) VALUES (?)').run('o1');
      emit(db, { topic: 'demo.events', type: 'OrderPlaced', key: 'o1', payload: { id: 'o1' } });
    });
    expect(() =>
      tx(db, () => {
        emit(db, { topic: 'demo.events', type: 'OrderPlaced', key: 'o2', payload: { id: 'o2' } });
        db.prepare('INSERT INTO orders (id) VALUES (?)').run('o1');
      }),
    ).toThrow();
    expect(pendingOutbox(db)).toBe(1);
    const relay = new OutboxRelay(db, bus, 'producer', log);
    expect(await relay.flush()).toBe(1);
    expect(pendingOutbox(db)).toBe(0);
    const events = await bus.fetch('g1', 'demo.events', 10);
    expect(events.map((e) => e.key)).toEqual(['o1']);
    expect(events[0]?.source).toBe('producer');
  });

  it('deduplicates republished events by id', async () => {
    const db = producerDb();
    tx(db, () => emit(db, { topic: 'demo.events', type: 'T', key: 'k', payload: {} }));
    await new OutboxRelay(db, bus, 'p', log).flush();
    db.prepare('UPDATE _outbox SET sent_at = NULL').run();
    await new OutboxRelay(db, bus, 'p', log).flush();
    const topics = (await fetch(`${server.url}/topics`, { headers: { 'x-kosh-internal-token': TEST_TOKEN } }).then((r) => r.json())) as {
      topics: { topic: string; count: number }[];
    };
    expect(topics.topics).toEqual([{ topic: 'demo.events', count: 1, lastOffset: 1 }]);
  });

  it('processes each event exactly once even when the bus redelivers', async () => {
    const pdb = producerDb();
    tx(pdb, () => {
      for (let i = 0; i < 5; i++) emit(pdb, { topic: 'demo.events', type: 'T', key: `k${i}`, payload: { i } });
    });
    await new OutboxRelay(pdb, bus, 'p', log).flush();

    const cdb = consumerDb();
    const handled: string[] = [];
    const consumer = new Consumer({
      bus,
      group: 'demo-consumer',
      topics: ['demo.events'],
      resolveDb: () => cdb,
      handle: (e: DeliveredEvent, db) => {
        handled.push(e.id);
        db.prepare('INSERT INTO seen (event_id, n) VALUES (?, ?)').run(e.id, (e.payload as { i: number }).i);
      },
      log,
    });

    const first = await consumer.pollOnce();
    expect(first.processed).toBe(5);
    await bus.seek('demo-consumer', 'demo.events', 0);
    const second = await consumer.pollOnce();
    expect(second).toMatchObject({ delivered: 5, processed: 0, duplicates: 5 });
    expect(cdb.prepare('SELECT COUNT(*) FROM seen').pluck().get()).toBe(5);
    expect(handled).toHaveLength(5);
    expect((await consumer.pollOnce()).delivered).toBe(0);
  });

  it('retries a failing event without skipping it', async () => {
    const pdb = producerDb();
    tx(pdb, () => {
      emit(pdb, { topic: 'demo.events', type: 'T', key: 'a', payload: { n: 1 } });
      emit(pdb, { topic: 'demo.events', type: 'T', key: 'b', payload: { n: 2 } });
    });
    await new OutboxRelay(pdb, bus, 'p', log).flush();
    const cdb = consumerDb();
    let fail = true;
    const consumer = new Consumer({
      bus,
      group: 'flaky',
      topics: ['demo.events'],
      resolveDb: () => cdb,
      handle: (e, db) => {
        if (e.key === 'b' && fail) throw new Error('boom');
        db.prepare('INSERT INTO seen (event_id, n) VALUES (?, 0)').run(e.id);
      },
      log,
    });
    expect((await consumer.pollOnce()).processed).toBe(1);
    fail = false;
    const retry = await consumer.pollOnce();
    expect(retry).toMatchObject({ delivered: 1, processed: 1 });
    expect(cdb.prepare('SELECT COUNT(*) FROM seen').pluck().get()).toBe(2);
  });

  it('long-polls until an event arrives', async () => {
    const started = Date.now();
    const pending = bus.fetch('lp', 'late.topic', 10, 2000);
    setTimeout(() => {
      void bus.publish([{ id: 'evt_late', topic: 'late.topic', type: 'T', key: 'k', occurredAt: new Date().toISOString(), source: 's', payload: {} }]);
    }, 150);
    const events = await pending;
    expect(events).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
