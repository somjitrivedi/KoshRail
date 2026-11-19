import { describe, expect, it } from 'vitest';
import type { AdapterStep, TxnState } from '@kosh/contracts';
import { openDb } from '@kosh/service-kit';
import { FakeClock } from '@kosh/test-kit';
import { isTerminal } from '../src/machine.ts';
import { type Random, seededRandom } from '../src/resilience.ts';
import { CrashSignal } from '../src/saga.ts';
import { FakeBankNetwork, type FakeFault } from './fake-banks.ts';
import { createPayment, FakeIdentity, FakeVpa, harness, type Harness, MIGRATIONS, party, type Party } from './harness.ts';

interface SimOptions {
  payments: number;
  faultRate: number;
  crashRate: number;
}

interface SimResult {
  seed: number;
  crashes: number;
  faults: number;
  states: TxnState[];
  counts: Record<string, number>;
  problems: string[];
}

const FAULTS: FakeFault[] = ['ERROR', 'ERROR', 'REFUSED', 'TIMEOUT_BEFORE', 'TIMEOUT_AFTER_COMMIT', 'DROP_AFTER_COMMIT'];
const BANKS = ['KOSH', 'ALPHA', 'BETA'];

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

async function simulate(seed: number, opts: SimOptions): Promise<SimResult> {
  const random = seededRandom(seed);
  const clock = new FakeClock('2026-11-18T04:30:00.000Z');
  const banks = new FakeBankNetwork(clock, BANKS);
  const vpa = new FakeVpa();
  const identity = new FakeIdentity();
  let crashes = 0;
  let faults = 0;
  let chaosOn = true;
  let generation = 0;

  const crashHook = (point: string) => {
    if (chaosOn && random() < opts.crashRate) {
      crashes++;
      throw new CrashSignal(point);
    }
  };

  const first = harness({ clock, banks, vpa, identity, owner: 'sim-0', crash: crashHook, seed, config: { holdTtlSeconds: 20 } });
  const dbPath = first.dbPath!;
  const extraDbs: { close: () => void }[] = [];
  let h: Harness = first;
  const restart = () => {
    generation++;
    clock.advance(h.config.leaseMs + 1);
    const db = openDb(dbPath, MIGRATIONS);
    extraDbs.push(db);
    h = harness({ db, clock, banks, vpa, identity, owner: `sim-${generation}`, crash: crashHook, seed: seed + generation, config: { holdTtlSeconds: 20 } });
  };

  banks.onCall = async (bank: string, step: AdapterStep) => {
    clock.advance(Math.floor(random() * 40));
    if (chaosOn && random() < opts.faultRate) {
      faults++;
      banks.inject(bank, step, pick(random, FAULTS));
    }
    if (chaosOn && step === 'capture' && random() < 0.03) clock.advance(25_000);
  };

  const payers: Party[] = BANKS.flatMap((b) => [party(h, b, 200_000), party(h, b, 50_000)]);
  const payees: Party[] = BANKS.flatMap((b) => [party(h, b, 0), party(h, b, 1_000)]);
  const closedPayee = payees[3]!;
  banks.close(closedPayee.accountId);
  const startTotal = banks.customerTotal();
  const ids: string[] = [];

  const step = async () => {
    try {
      if (random() < 0.6 && ids.length < opts.payments) {
        const payer = pick(random, payers);
        const payee = pick(random, payees);
        const amount = 1 + Math.floor(random() * 60_000);
        const t = createPayment(h, payer, payee, amount);
        ids.push(t.id);
        if (random() < 0.7) await h.engine.drive(t.id);
      } else {
        await h.recovery.drain(3);
      }
      if (random() < 0.2) clock.advance(Math.floor(random() * 3000));
      if (random() < 0.1) banks.sweepExpired();
    } catch (err) {
      if (!(err instanceof CrashSignal)) throw err;
      restart();
    }
  };

  for (let i = 0; i < opts.payments * 6 && (ids.length < opts.payments || h.store.nonTerminalCount() > 0); i++) await step();

  chaosOn = false;
  banks.clearFaults();
  for (let round = 0; round < 200 && h.store.nonTerminalCount() > 0; round++) {
    clock.advance(Math.max(h.config.deemedPollMs, h.config.parkCapMs, h.config.leaseMs) + 1);
    await h.recovery.drain();
  }
  banks.sweepExpired();

  const problems = [...banks.invariants()];
  const states: TxnState[] = [];
  const expected = new Map<string, number>([...payers, ...payees].map((p) => [p.accountId, 0]));
  let reviewCount = 0;
  for (const id of ids) {
    const t = h.store.mustGet(id);
    states.push(t.state);
    if (!isTerminal(t.state)) problems.push(`${id} stuck in ${t.state}`);
    if (t.state === 'MANUAL_REVIEW') reviewCount++;
    const tos = h.store.transitions(id).map((x) => x.to).filter((s) => s !== 'DEEMED' && s !== 'MANUAL_REVIEW');
    if (new Set(tos).size !== tos.length) problems.push(`${id} repeated a state: ${tos.join(',')}`);
    for (const s of ['hold', 'credit', 'capture', 'release', 'reverse'] as const) {
      if (banks.executed(id, s) > 1) problems.push(`${id} executed ${s} ${banks.executed(id, s)} times`);
    }
    if (t.state === 'COMPLETED') {
      if (banks.executed(id, 'capture') !== 1 || banks.executed(id, 'credit') !== 1) problems.push(`${id} COMPLETED without exactly one credit and capture`);
      expected.set(t.payerAccount, (expected.get(t.payerAccount) ?? 0) - t.amount);
      expected.set(t.payeeAccount, (expected.get(t.payeeAccount) ?? 0) + t.amount);
    }
    if (t.state === 'REVERSED' || t.state === 'DEBIT_FAILED') {
      if (banks.executed(id, 'capture') !== 0) problems.push(`${id} ${t.state} but the payer hold was captured`);
      if (banks.executed(id, 'credit') !== banks.executed(id, 'reverse')) problems.push(`${id} ${t.state} with an unreversed credit`);
    }
    if (t.state !== 'MANUAL_REVIEW' && banks.activeHolds(id).length > 0) problems.push(`${id} ${t.state} left an active hold`);
  }
  if (reviewCount === 0) {
    const deposits = new Map<string, number>();
    payers.forEach((p, i) => deposits.set(p.accountId, i % 2 === 0 ? 200_000 : 50_000));
    payees.forEach((p, i) => deposits.set(p.accountId, i % 2 === 0 ? 0 : 1_000));
    for (const [acct, delta] of expected) {
      const want = (deposits.get(acct) ?? 0) + delta;
      if (banks.balance(acct) !== want) problems.push(`${acct} balance ${banks.balance(acct)} != expected ${want}`);
    }
    if (banks.switchGlTotal() !== 0) problems.push(`switch settlement GLs do not net to zero: ${banks.switchGlTotal()}`);
  }
  if (banks.customerTotal() !== startTotal) problems.push(`customer money changed: ${startTotal} -> ${banks.customerTotal()}`);

  const counts: Record<string, number> = {};
  for (const s of states) counts[s] = (counts[s] ?? 0) + 1;
  for (const db of extraDbs) db.close();
  first.cleanup();
  return { seed, crashes, faults, states, counts, problems };
}

const DEFAULTS: SimOptions = { payments: 40, faultRate: 0.15, crashRate: 0.02 };
const envSeed = process.env.SIM_SEED ? Number(process.env.SIM_SEED) : null;
const seeds = envSeed !== null ? [envSeed] : Array.from({ length: Number(process.env.SIM_SEEDS ?? 30) }, (_, i) => i + 1);

describe('5.5 deterministic simulation: real saga logic, fake banks, fake clock, seeded faults and crashes', () => {
  it.each(seeds)('seed %i keeps every invariant', async (seed) => {
    const r = await simulate(seed, { ...DEFAULTS, payments: Number(process.env.SIM_PAYMENTS ?? DEFAULTS.payments) });
    expect(r.problems, `replay with SIM_SEED=${seed} npm run sim:switch`).toEqual([]);
    expect(r.states).toHaveLength(Number(process.env.SIM_PAYMENTS ?? DEFAULTS.payments));
  });

  it('the same seed replays to exactly the same outcome', async () => {
    const a = await simulate(4242, DEFAULTS);
    const b = await simulate(4242, DEFAULTS);
    expect(b.states).toEqual(a.states);
    expect(b.crashes).toBe(a.crashes);
    expect(b.faults).toBe(a.faults);
  });

  it('across seeds the simulation really exercises crashes, faults and every failure branch', async () => {
    const totals: Record<string, number> = {};
    let crashes = 0;
    let faults = 0;
    for (let seed = 100; seed < 112; seed++) {
      const r = await simulate(seed, { payments: 40, faultRate: 0.25, crashRate: 0.04 });
      expect(r.problems, `replay with SIM_SEED=${seed}`).toEqual([]);
      crashes += r.crashes;
      faults += r.faults;
      for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] ?? 0) + v;
    }
    expect(crashes).toBeGreaterThan(5);
    expect(faults).toBeGreaterThan(50);
    expect(totals.COMPLETED ?? 0).toBeGreaterThan(100);
    expect(totals.DEBIT_FAILED ?? 0).toBeGreaterThan(0);
    expect(totals.REVERSED ?? 0).toBeGreaterThan(0);
  });
});
