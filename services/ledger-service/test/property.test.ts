import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AppError } from '@kosh/service-kit';
import { FakeClock } from '@kosh/test-kit';
import { account, setupLedger } from './fixtures.ts';

const CUSTOMERS = ['acc_a', 'acc_b', 'acc_c', 'acc_d'];

type Op =
  | { t: 'deposit'; acc: number; amount: number }
  | { t: 'withdraw'; acc: number; amount: number }
  | { t: 'transfer'; from: number; to: number; amount: number }
  | { t: 'hold'; acc: number; amount: number; ttl: number }
  | { t: 'capture'; pick: number }
  | { t: 'release'; pick: number }
  | { t: 'reverse'; pick: number }
  | { t: 'tick'; seconds: number }
  | { t: 'sweep' };

const amount = fc.integer({ min: 1, max: 50_000 });
const acc = fc.integer({ min: 0, max: CUSTOMERS.length - 1 });
const pick = fc.nat({ max: 1000 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('deposit' as const), acc, amount }),
  fc.record({ t: fc.constant('withdraw' as const), acc, amount }),
  fc.record({ t: fc.constant('transfer' as const), from: acc, to: acc, amount }),
  fc.record({ t: fc.constant('hold' as const), acc, amount, ttl: fc.integer({ min: 1, max: 120 }) }),
  fc.record({ t: fc.constant('capture' as const), pick }),
  fc.record({ t: fc.constant('release' as const), pick }),
  fc.record({ t: fc.constant('reverse' as const), pick }),
  fc.record({ t: fc.constant('tick' as const), seconds: fc.integer({ min: 1, max: 90 }) }),
  fc.constant({ t: 'sweep' as const }),
);

const EXPECTED_REJECTIONS = new Set([
  'INSUFFICIENT_FUNDS',
  'HOLD_NOT_ACTIVE',
  'HOLD_EXPIRED',
  'HOLD_ALREADY_CAPTURED',
  'ENTRY_ALREADY_REVERSED',
  'CANNOT_REVERSE_REVERSAL',
  'ENTRY_DUPLICATE_ACCOUNT',
  'LIMIT_DAILY_EXCEEDED',
]);

let totalOps = 0;
let succeeded = 0;

function run(ops: Op[]) {
  const clock = new FakeClock('2026-11-16T05:00:00.000Z');
  const { ledger } = setupLedger(clock);
  ledger.upsertAccount(account('acc_c', { type: 'CURRENT', overdraftLimit: 20_000 }));
  ledger.upsertAccount(account('acc_d', { dailyDebitLimit: 60_000 }));
  const holds: string[] = [];
  const entries: string[] = [];
  const model = new Map<string, number>(CUSTOMERS.map((c) => [c, 0]));
  let cash = 0;
  for (const op of ops) {
    totalOps++;
    try {
      switch (op.t) {
        case 'deposit': {
          const e = ledger.deposit(CUSTOMERS[op.acc]!, op.amount, 'p-dep', 'prop');
          entries.push(e.id);
          model.set(CUSTOMERS[op.acc]!, model.get(CUSTOMERS[op.acc]!)! + op.amount);
          cash -= op.amount;
          break;
        }
        case 'withdraw': {
          const e = ledger.withdraw(CUSTOMERS[op.acc]!, op.amount, 'p-wd', 'prop');
          entries.push(e.id);
          model.set(CUSTOMERS[op.acc]!, model.get(CUSTOMERS[op.acc]!)! - op.amount);
          cash += op.amount;
          break;
        }
        case 'transfer': {
          const from = CUSTOMERS[op.from]!;
          const to = CUSTOMERS[op.to]!;
          const e = ledger.post({ kind: 'TRANSFER', reference: 'p-tx', postings: [{ accountId: from, amount: -op.amount }, { accountId: to, amount: op.amount }], createdBy: 'prop' });
          entries.push(e.id);
          model.set(from, model.get(from)! - op.amount);
          model.set(to, model.get(to)! + op.amount);
          break;
        }
        case 'hold':
          holds.push(ledger.placeHold({ accountId: CUSTOMERS[op.acc]!, amount: op.amount, reference: 'p-h', ttlSeconds: op.ttl }).id);
          break;
        case 'capture': {
          if (holds.length === 0) break;
          const id = holds[op.pick % holds.length]!;
          const before = ledger.getHold(id);
          const r = ledger.capture(id, { counterAccountId: 'gl_switch', createdBy: 'prop' });
          if (before.status === 'ACTIVE') {
            entries.push(r.entry.id);
            model.set(before.accountId, model.get(before.accountId)! - before.amount);
          }
          break;
        }
        case 'release':
          if (holds.length) ledger.releaseHold(holds[op.pick % holds.length]!);
          break;
        case 'reverse': {
          if (entries.length === 0) break;
          const id = entries[op.pick % entries.length]!;
          const r = ledger.reverse(id, 'prop reversal', 'prop');
          for (const p of r.postings) {
            if (model.has(p.accountId)) model.set(p.accountId, model.get(p.accountId)! + p.amount);
            if (p.accountId === 'gl_cash') cash += p.amount;
          }
          break;
        }
        case 'tick':
          clock.advanceSeconds(op.seconds);
          break;
        case 'sweep':
          ledger.expireHolds();
          break;
      }
      succeeded++;
    } catch (err) {
      if (!(err instanceof AppError) || !EXPECTED_REJECTIONS.has(err.code)) throw err;
    }
  }
  const report = ledger.invariants();
  if (!report.ok) throw new Error(JSON.stringify(report.checks.filter((c) => !c.ok)));
  for (const [id, expected] of model) expect(ledger.balance(id).ledgerBalance, id).toBe(expected);
  expect(ledger.balance('gl_cash').ledgerBalance).toBe(cash);
  const total = CUSTOMERS.reduce((s, c) => s + ledger.balance(c).ledgerBalance, 0) + ledger.balance('gl_cash').ledgerBalance + ledger.balance('gl_switch').ledgerBalance;
  expect(total).toBe(0);
}

describe('ledger properties', () => {
  it('keeps every invariant across 10,000+ random operations and matches a reference model', () => {
    totalOps = 0;
    succeeded = 0;
    fc.assert(fc.property(fc.array(opArb, { minLength: 40, maxLength: 80 }), (ops) => run(ops)), { numRuns: 200, seed: 20261116 });
    expect(totalOps).toBeGreaterThanOrEqual(10_000);
    expect(succeeded / totalOps).toBeGreaterThan(0.6);
  });
});
