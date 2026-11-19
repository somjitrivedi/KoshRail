import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { idemKey, poll } from './helpers.ts';
import { SWITCH_E2E_ENV } from './switch-env.ts';
import {
  armCrash,
  balance,
  clearFaults,
  customer,
  expectInvariants,
  ledgerByReference,
  pay,
  setFault,
  stepCount,
  switchHealthy,
  switchOwner,
  waitState,
} from './switch-helpers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

async function crashDuring(point: string, run: () => Promise<{ status: number; body: any }>) {
  await switchHealthy();
  const ownerBefore = await switchOwner();
  await armCrash(point);
  const r = await run();
  expect(r.status).toBe(202);
  await poll(async () => {
    const owner = await switchOwner();
    return owner !== null && owner !== ownerBefore;
  }, `switch-service to crash at ${point} and come back`, 30000);
  return waitState(r.body.id, ['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'], 30000);
}

describe('phase 5.4 - crash recovery (switch-service process killed at step boundaries)', () => {
  for (const point of ['hold:after-call', 'credit:before-call', 'credit:after-call', 'after:CREDITED', 'capture:after-call']) {
    it(`killed at ${point}: the restarted switch finishes the payment and money moves exactly once`, async () => {
      const payer = await customer('KOSH', 80_000);
      const payee = await customer('ALPHA');
      const done = await crashDuring(point, () => pay(payer, payee, 8_000));
      expect(done.txn.state).toBe('COMPLETED');
      expect(new Set(done.transitions.map((t: { owner: string }) => t.owner)).size).toBe(2);
      expect(await balance(payer)).toMatchObject({ ledgerBalance: 72_000, heldAmount: 0 });
      expect((await balance(payee)).ledgerBalance).toBe(8_000);
      const payerSide = await ledgerByReference('KOSH', done.txn.id);
      expect(payerSide.holds).toHaveLength(1);
      expect(payerSide.holds[0].status).toBe('CAPTURED');
      expect((await ledgerByReference('ALPHA', done.txn.id)).entries.filter((e) => e.kind === 'CREDIT')).toHaveLength(1);
      await expectInvariants();
    });
  }

  it('killed while releasing the hold of a failed credit: the payment still ends REVERSED with the hold released', async () => {
    const payer = await customer('BETA', 40_000);
    const payee = await customer('KOSH');
    await setFault('KOSH', 'credit', { mode: 'ERROR' });
    try {
      const done = await crashDuring('release:before-call', () => pay(payer, payee, 4_000));
      expect(done.txn).toMatchObject({ state: 'REVERSED', holdReleased: true });
      expect(await balance(payer)).toMatchObject({ ledgerBalance: 40_000, heldAmount: 0 });
    } finally {
      await clearFaults('KOSH');
    }
    await expectInvariants();
  });

  it('a dropped credit response followed by a crash before the result is recorded still credits once', async () => {
    const payer = await customer('ALPHA', 40_000);
    const payee = await customer('BETA');
    await setFault('BETA', 'credit', { mode: 'DROP_RESPONSE', remaining: 1 });
    try {
      const done = await crashDuring('credit:after-call', () => pay(payer, payee, 6_000));
      expect(done.txn.state).toBe('COMPLETED');
      expect(stepCount(done, 'credit', 'STARTED')).toBe(1);
      expect((await balance(payee)).ledgerBalance).toBe(6_000);
      expect((await ledgerByReference('BETA', done.txn.id)).entries.filter((e) => e.kind === 'CREDIT')).toHaveLength(1);
    } finally {
      await clearFaults('BETA');
    }
    await expectInvariants();
  });
});

describe('phase 5.4 - two switch processes on one database', () => {
  let second: ChildProcess | null = null;

  afterAll(async () => {
    if (second && second.exitCode === null) {
      const exited = new Promise((r) => second!.once('exit', r));
      second.kill();
      await exited;
    }
  });

  it('a second switch instance shares the work; killing the first mid-flight loses nothing', async () => {
    const urls = inject('urls');
    const port = Number(new URL(urls.KOSH_SWITCH_URL!).port) + 100;
    second = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'services/switch-service/src/main.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...urls,
        ...SWITCH_E2E_ENV,
        SWITCH_CHAOS: 'false',
        PORT: String(port),
        KOSH_DATA_DIR: inject('dataDir'),
        KOSH_INTERNAL_TOKEN: inject('internalToken'),
        LOG_LEVEL: 'warn',
      },
      stdio: 'ignore',
    });
    await poll(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/ready`)).ok;
      } catch {
        return false;
      }
    }, 'second switch instance to be ready', 30000);

    const payers = await Promise.all([customer('KOSH', 100_000), customer('ALPHA', 100_000), customer('BETA', 100_000)]);
    const payees = await Promise.all([customer('ALPHA'), customer('BETA'), customer('KOSH')]);
    await setFault('ALPHA', 'credit', { mode: 'LATENCY', latencyMs: 300 });
    await armCrash('credit:after-call');
    const accepted: string[] = [];
    for (let i = 0; i < 12; i++) {
      const key = idemKey();
      const r = await poll(async () => {
        const attempt = await pay(payers[i % 3]!, payees[i % 3]!, 1_000 + i, { key });
        if (attempt.status === 503 || attempt.status === 504) return null;
        return attempt;
      }, `payment ${i} to be accepted`, 30000);
      expect(r.status).toBe(202);
      accepted.push(r.body.id as string);
    }
    expect(new Set(accepted).size).toBe(12);
    try {
      const results = await Promise.all(accepted.map((id) => waitState(id, ['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'], 40000)));
      expect(results.map((r) => r.txn.state)).toEqual(accepted.map(() => 'COMPLETED'));
      const owners = new Set(results.flatMap((r) => r.transitions.map((t: { owner: string }) => t.owner)));
      expect(owners.size).toBeGreaterThanOrEqual(2);
    } finally {
      await clearFaults('ALPHA');
    }
    expect(second.exitCode).toBeNull();
    for (let i = 0; i < 3; i++) {
      const sent = accepted.filter((_, idx) => idx % 3 === i).length;
      expect((await balance(payers[i]!)).heldAmount).toBe(0);
      if (sent > 0) expect((await balance(payees[i]!)).ledgerBalance).toBeGreaterThan(0);
    }
    await switchHealthy();
    await expectInvariants();
  });
});
