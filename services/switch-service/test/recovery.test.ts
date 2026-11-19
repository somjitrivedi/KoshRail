import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '@kosh/service-kit';
import { CrashSignal } from '../src/saga.ts';
import { createPayment, harness, type Harness, MIGRATIONS, party } from './harness.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function crashingAt(point: string) {
  let armed = true;
  return (p: string) => {
    if (armed && p === point) {
      armed = false;
      throw new CrashSignal(p);
    }
  };
}

function restart(dead: Harness, owner: string): Harness {
  const next = harness({ db: openDb(dead.dbPath!, MIGRATIONS), clock: dead.clock, banks: dead.banks, vpa: dead.vpa, identity: dead.identity, owner });
  cleanups.push(() => next.db.close());
  return next;
}

async function settle(h: Harness, id: string) {
  for (let i = 0; i < 60; i++) {
    const t = h.store.mustGet(id);
    if (['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'].includes(t.state)) return t;
    const wake = Math.max(Date.parse(t.nextRunAt), t.leaseUntil ? Date.parse(t.leaseUntil) : 0);
    if (wake > h.clock.now().getTime()) h.clock.set(new Date(wake));
    await h.recovery.drain();
  }
  return h.store.mustGet(id);
}

const HAPPY_POINTS = [
  'after:RISK_PASSED',
  'hold:before-call',
  'hold:after-call',
  'after:DEBIT_HELD',
  'credit:before-call',
  'credit:after-call',
  'after:CREDITED',
  'capture:before-call',
  'capture:after-call',
];

describe('5.4 crash recovery at every step boundary', () => {
  for (const point of HAPPY_POINTS) {
    it(`crash at ${point}: a new process resumes after the lease expires and moves the money exactly once`, async () => {
      const a = harness({ crash: crashingAt(point) });
      cleanups.push(a.cleanup);
      const payer = party(a, 'KOSH', 100_000);
      const payee = party(a, 'ALPHA', 0);
      const t = createPayment(a, payer, payee, 25_000);
      await expect(a.engine.drive(t.id)).rejects.toThrow(CrashSignal);
      const orphan = a.store.mustGet(t.id);
      expect(orphan.leaseOwner).toBe('owner-a');
      const b = restart(a, 'owner-b');
      expect(await b.engine.drive(t.id)).toBeNull();
      const done = await settle(b, t.id);
      expect(done.state).toBe('COMPLETED');
      expect(done.fence).toBeGreaterThan(orphan.fence);
      for (const step of ['hold', 'credit', 'capture'] as const) expect(a.banks.executed(t.id, step)).toBe(1);
      expect(a.banks.balance(payer.accountId)).toBe(75_000);
      expect(a.banks.held(payer.accountId)).toBe(0);
      expect(a.banks.balance(payee.accountId)).toBe(25_000);
      expect(a.banks.invariants()).toEqual([]);
      const tos = b.store.transitions(t.id).map((x) => x.to);
      expect(new Set(tos).size).toBe(tos.length);
    });
  }

  const REVERSAL_POINTS = ['credit:after-call', 'after:CREDIT_FAILED', 'after:REVERSING', 'release:before-call', 'release:after-call'];
  for (const point of REVERSAL_POINTS) {
    it(`crash at ${point} on the reversal path still ends REVERSED with the hold released`, async () => {
      const a = harness({ crash: crashingAt(point) });
      cleanups.push(a.cleanup);
      const payer = party(a, 'KOSH', 100_000);
      const payee = party(a, 'BETA', 0);
      a.banks.close(payee.accountId);
      const t = createPayment(a, payer, payee, 10_000);
      await expect(a.engine.drive(t.id)).rejects.toThrow(CrashSignal);
      const b = restart(a, 'owner-b');
      const done = await settle(b, t.id);
      expect(done).toMatchObject({ state: 'REVERSED', holdReleased: true });
      expect(a.banks.balance(payer.accountId)).toBe(100_000);
      expect(a.banks.held(payer.accountId)).toBe(0);
      expect(a.banks.invariants()).toEqual([]);
    });
  }

  it('crash while reversing a credit after the hold expired still reverses exactly once', async () => {
    const a = harness({ crash: crashingAt('reverse:after-call'), config: { holdTtlSeconds: 1 } });
    cleanups.push(a.cleanup);
    const payer = party(a, 'KOSH', 100_000);
    const payee = party(a, 'ALPHA', 0);
    a.banks.onCall = async (_bank, step) => {
      if (step === 'capture') a.clock.advance(5_000);
    };
    const t = createPayment(a, payer, payee, 10_000);
    await expect(a.engine.drive(t.id)).rejects.toThrow(CrashSignal);
    a.banks.onCall = null;
    const b = restart(a, 'owner-b');
    const done = await settle(b, t.id);
    expect(done.state).toBe('REVERSED');
    expect(a.banks.executed(t.id, 'reverse')).toBe(1);
    expect(a.banks.balance(payee.accountId)).toBe(0);
    expect(a.banks.balance(payer.accountId)).toBe(100_000);
    expect(a.banks.invariants()).toEqual([]);
  });

  it('crashes again and again: three processes in a row still finish the payment', async () => {
    const a = harness({ crash: crashingAt('hold:after-call') });
    cleanups.push(a.cleanup);
    const payer = party(a, 'KOSH', 100_000);
    const payee = party(a, 'ALPHA', 0);
    const t = createPayment(a, payer, payee, 1_000);
    await expect(a.engine.drive(t.id)).rejects.toThrow(CrashSignal);
    a.clock.advance(a.config.leaseMs);
    const b = harness({ db: openDb(a.dbPath!, MIGRATIONS), clock: a.clock, banks: a.banks, vpa: a.vpa, owner: 'owner-b', crash: crashingAt('credit:after-call') });
    cleanups.push(() => b.db.close());
    await expect(b.recovery.drain()).rejects.toThrow(CrashSignal);
    const c = restart(a, 'owner-c');
    const done = await settle(c, t.id);
    expect(done.state).toBe('COMPLETED');
    expect(new Set(c.store.transitions(t.id).map((x) => x.owner))).toEqual(new Set(['owner-a', 'owner-b', 'owner-c']));
    expect(a.banks.invariants()).toEqual([]);
  });
});

describe('5.4 leases and fencing tokens', () => {
  it('a live lease keeps a second instance out; an expired one lets it in with a higher fence', async () => {
    const a = harness();
    cleanups.push(a.cleanup);
    const payer = party(a, 'KOSH', 10_000);
    const payee = party(a, 'ALPHA', 0);
    const t = createPayment(a, payer, payee, 100);
    const fence = a.store.acquireLease(t.id, 'owner-a', 5000)!;
    const b = restart(a, 'owner-b');
    expect(b.store.acquireLease(t.id, 'owner-b', 5000)).toBeNull();
    expect(b.store.runnable(10)).toEqual([]);
    a.clock.advance(5000);
    expect(b.store.runnable(10)).toEqual([t.id]);
    const fenceB = b.store.acquireLease(t.id, 'owner-b', 5000);
    expect(fenceB).toBe(fence + 1);
  });

  it('a zombie that wakes up after losing its lease cannot write anything', async () => {
    const a = harness();
    cleanups.push(a.cleanup);
    const payer = party(a, 'KOSH', 10_000);
    const payee = party(a, 'ALPHA', 0);
    const t = createPayment(a, payer, payee, 500);
    let releaseZombie!: () => void;
    const zombieBlocked = new Promise<void>((r) => {
      releaseZombie = r;
    });
    let first = true;
    a.banks.onCall = async () => {
      if (first) {
        first = false;
        await zombieBlocked;
      }
    };
    const zombie = a.engine.drive(t.id);
    await new Promise((r) => setTimeout(r, 10));
    a.clock.advance(a.config.leaseMs + 1);
    const b = restart(a, 'owner-b');
    const done = await settle(b, t.id);
    expect(done.state).toBe('COMPLETED');
    const transitionsBefore = b.store.transitions(t.id).length;
    releaseZombie();
    await zombie;
    expect(a.engine.stats.leaseLost).toBe(1);
    expect(b.store.transitions(t.id)).toHaveLength(transitionsBefore);
    expect(b.store.mustGet(t.id).state).toBe('COMPLETED');
    expect(b.store.transitions(t.id).filter((x) => x.owner === 'owner-a').map((x) => x.to)).toEqual(['RISK_PASSED']);
    expect(a.banks.executed(t.id, 'hold')).toBe(1);
    expect(a.banks.invariants()).toEqual([]);
  });

  it('two switch instances on one database drive 40 payments concurrently without a double step', async () => {
    const a = harness();
    cleanups.push(a.cleanup);
    const b = restart(a, 'owner-b');
    const payers = Array.from({ length: 8 }, () => party(a, 'KOSH', 1_000_000));
    const payees = Array.from({ length: 8 }, (_, i) => party(a, i % 2 ? 'ALPHA' : 'BETA', 0));
    a.banks.inject('ALPHA', 'credit', 'TIMEOUT_AFTER_COMMIT', 'ERROR', 'DROP_AFTER_COMMIT');
    a.banks.inject('KOSH', 'capture', 'ERROR', 'TIMEOUT_AFTER_COMMIT');
    a.banks.onCall = () => new Promise((r) => setTimeout(r, 1));
    const ids = Array.from({ length: 40 }, (_, i) => createPayment(a, payers[i % 8]!, payees[(i * 3) % 8]!, 1_000 + i).id);
    const startTotal = a.banks.customerTotal();
    for (let round = 0; round < 30; round++) {
      await Promise.all([a.recovery.drain(), b.recovery.drain()]);
      if (a.store.nonTerminalCount() === 0) break;
      a.clock.advance(1000);
    }
    expect(a.store.countsByState()).toEqual({ COMPLETED: 40 });
    for (const id of ids) {
      for (const step of ['hold', 'credit', 'capture'] as const) expect(a.banks.executed(id, step)).toBe(1);
      const tos = a.store.transitions(id).map((x) => x.to);
      expect(new Set(tos).size).toBe(tos.length);
    }
    const owners = new Set(ids.flatMap((id) => a.store.transitions(id).map((x) => x.owner)));
    expect(owners).toEqual(new Set(['owner-a', 'owner-b']));
    expect(a.banks.customerTotal()).toBe(startTotal);
    expect(a.banks.switchGlTotal()).toBe(0);
    expect(a.banks.invariants()).toEqual([]);
  });
});
