import { describe, expect, it } from 'vitest';
import { TXN_STATES, type TxnState } from '@kosh/contracts';
import { AppError, migrationsDir, openDb } from '@kosh/service-kit';
import { FakeClock } from '@kosh/test-kit';
import { classifyError } from '../src/classify.ts';
import { allowedTargets, assertTransition, canTransition, customerStatus, IllegalTransition, isTerminal, TERMINAL_STATES } from '../src/machine.ts';
import { backoffMs, Bulkhead, CircuitBreaker, seededRandom } from '../src/resilience.ts';
import { isRrn, nextRrn, rrnPrefix } from '../src/rrn.ts';

describe('5.2 saga state machine transition table', () => {
  it('walks the happy path INITIATED -> RISK_PASSED -> DEBIT_HELD -> CREDITED -> COMPLETED', () => {
    const path: TxnState[] = ['INITIATED', 'RISK_PASSED', 'DEBIT_HELD', 'CREDITED', 'COMPLETED'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('allows every failure branch from the plan', () => {
    expect(canTransition('RISK_PASSED', 'DEBIT_FAILED')).toBe(true);
    expect(canTransition('DEBIT_HELD', 'CREDIT_FAILED')).toBe(true);
    expect(canTransition('CREDIT_FAILED', 'REVERSING')).toBe(true);
    expect(canTransition('REVERSING', 'REVERSED')).toBe(true);
    expect(canTransition('CREDITED', 'REVERSING')).toBe(true);
    for (const from of ['RISK_PASSED', 'DEBIT_HELD', 'CREDITED'] as TxnState[]) expect(canTransition(from, 'DEEMED')).toBe(true);
    expect(canTransition('DEEMED', 'COMPLETED')).toBe(true);
    expect(canTransition('DEEMED', 'REVERSING')).toBe(true);
  });

  it('never lets money skip a step or leave a finished state', () => {
    expect(canTransition('RISK_PASSED', 'CREDITED')).toBe(false);
    expect(canTransition('DEBIT_HELD', 'COMPLETED')).toBe(false);
    expect(canTransition('CREDIT_FAILED', 'COMPLETED')).toBe(false);
    expect(canTransition('REVERSING', 'COMPLETED')).toBe(false);
    expect(canTransition('DEBIT_FAILED', 'REVERSING')).toBe(false);
    for (const s of ['COMPLETED', 'DEBIT_FAILED', 'REVERSED'] as TxnState[]) expect(allowedTargets(s)).toEqual([]);
    expect(() => assertTransition('COMPLETED', 'REVERSING')).toThrow(IllegalTransition);
  });

  it('lets every non-terminal state escalate to MANUAL_REVIEW and review only resume to a non-terminal state', () => {
    for (const s of TXN_STATES) {
      if (isTerminal(s)) continue;
      expect(canTransition(s, 'MANUAL_REVIEW')).toBe(true);
    }
    for (const s of allowedTargets('MANUAL_REVIEW')) expect(isTerminal(s)).toBe(false);
  });

  it('marks exactly four states terminal and maps them to customer statuses', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['COMPLETED', 'DEBIT_FAILED', 'MANUAL_REVIEW', 'REVERSED']);
    expect(customerStatus('COMPLETED')).toBe('SUCCESS');
    expect(customerStatus('REVERSED')).toBe('FAILED');
    expect(customerStatus('DEBIT_FAILED')).toBe('FAILED');
    expect(customerStatus('DEEMED')).toBe('PENDING');
    expect(customerStatus('MANUAL_REVIEW')).toBe('PENDING');
  });
});

describe('5.3 retry policy', () => {
  it('grows exponentially, stays inside [ceiling/2, ceiling] and respects the cap', () => {
    const random = seededRandom(1);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ceiling = Math.min(1000, 100 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const d = backoffMs(attempt, 100, 1000, random);
        expect(d).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('adds jitter so two callers rarely pick the same delay', () => {
    const random = seededRandom(2);
    const delays = new Set(Array.from({ length: 50 }, () => backoffMs(4, 100, 5000, random)));
    expect(delays.size).toBeGreaterThan(30);
  });

  it('seeded random is deterministic', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });
});

describe('5.3 circuit breaker and bulkhead', () => {
  it('opens after the failure threshold, fails fast, then allows a single half-open probe', () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(clock, 3, 1000);
    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.onFailure();
    }
    expect(b.snapshot().state).toBe('OPEN');
    expect(b.tryAcquire()).toBe(false);
    clock.advance(1000);
    expect(b.snapshot().state).toBe('HALF_OPEN');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    b.onSuccess();
    expect(b.snapshot()).toMatchObject({ state: 'CLOSED', consecutiveFailures: 0, opens: 1 });
  });

  it('re-opens when the probe fails and resets the failure count on success', () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(clock, 2, 500);
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    expect(b.snapshot().state).toBe('CLOSED');
    b.onFailure();
    expect(b.snapshot().state).toBe('OPEN');
    clock.advance(500);
    expect(b.tryAcquire()).toBe(true);
    b.onFailure();
    expect(b.snapshot()).toMatchObject({ state: 'OPEN', opens: 2 });
    expect(b.tryAcquire()).toBe(false);
  });

  it('bulkhead caps concurrent calls and counts rejections', () => {
    const bh = new Bulkhead(2);
    expect(bh.tryEnter()).toBe(true);
    expect(bh.tryEnter()).toBe(true);
    expect(bh.tryEnter()).toBe(false);
    bh.leave();
    expect(bh.tryEnter()).toBe(true);
    expect(bh.snapshot()).toEqual({ active: 2, limit: 2, rejected: 1 });
  });
});

describe('5.3 adapter error classification (fixed table)', () => {
  const kind = (status: number, code: string, details?: unknown) => classifyError(new AppError(status, code, 'x', details)).kind;

  it('treats 400/404/409/422 as definitive business failures', () => {
    for (const [s, c] of [
      [422, 'INSUFFICIENT_FUNDS'],
      [422, 'ACCOUNT_NOT_ACTIVE'],
      [422, 'LIMIT_PER_TXN_EXCEEDED'],
      [409, 'HOLD_EXPIRED'],
      [409, 'HOLD_NOT_ACTIVE'],
      [404, 'ACCOUNT_NOT_FOUND'],
      [400, 'VALIDATION_FAILED'],
    ] as const) {
      expect(kind(s, c)).toBe('BUSINESS');
    }
  });

  it('treats 502/503 as transient, but a dropped socket as unknown', () => {
    expect(kind(502, 'BANK_UNAVAILABLE')).toBe('TRANSIENT');
    expect(kind(503, 'ADAPTER_FAULT_INJECTED')).toBe('TRANSIENT');
    expect(kind(503, 'UPSTREAM_UNAVAILABLE', { cause: 'ECONNREFUSED' })).toBe('TRANSIENT');
    expect(kind(503, 'UPSTREAM_UNAVAILABLE', { cause: 'UND_ERR_SOCKET' })).toBe('UNKNOWN');
    expect(kind(503, 'UPSTREAM_UNAVAILABLE', { cause: 'ECONNRESET' })).toBe('UNKNOWN');
    expect(kind(503, 'UPSTREAM_UNAVAILABLE')).toBe('UNKNOWN');
  });

  it('treats 504, unexpected 5xx and non-HTTP errors as unknown', () => {
    expect(kind(504, 'UPSTREAM_TIMEOUT')).toBe('UNKNOWN');
    expect(kind(500, 'INTERNAL_ERROR')).toBe('UNKNOWN');
    expect(classifyError(new Error('boom')).kind).toBe('UNKNOWN');
  });

  it('flags a changed retry body as a switch bug', () => {
    expect(kind(409, 'ADAPTER_REQUEST_MISMATCH')).toBe('MISMATCH');
  });
});

describe('5.1 RRN generation', () => {
  const db = () => openDb(':memory:', migrationsDir(new URL('../src/main.ts', import.meta.url).href));

  it('is 12 digits: year digit, IST day of year, IST hour, 6-digit sequence', () => {
    const at = new Date('2026-11-18T04:30:00.000Z');
    expect(rrnPrefix(at)).toBe('632210');
    const r = nextRrn(db(), at);
    expect(isRrn(r)).toBe(true);
    expect(r).toBe('632210000001');
  });

  it('uses the IST calendar, so 23:00 UTC on 31 Dec is already the next year', () => {
    expect(rrnPrefix(new Date('2026-12-31T23:00:00.000Z'))).toBe('700104');
  });

  it('is unique and increasing within an hour and restarts per hour', () => {
    const d = db();
    const at = new Date('2026-11-18T04:30:00.000Z');
    const many = Array.from({ length: 500 }, () => nextRrn(d, at));
    expect(new Set(many).size).toBe(500);
    expect([...many].sort()).toEqual(many);
    expect(nextRrn(d, new Date('2026-11-18T05:30:00.000Z'))).toBe('632211000001');
  });
});
