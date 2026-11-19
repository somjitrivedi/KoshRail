import { afterEach, describe, expect, it } from 'vitest';
import { createPayment, harness, type Harness, outboxTypes, party } from './harness.ts';

let h: Harness;

afterEach(() => {
  h?.cleanup();
});

function expectBalanced() {
  expect(h.banks.invariants()).toEqual([]);
}

async function run(id: string) {
  await h.engine.drive(id);
  for (let i = 0; i < 40; i++) {
    const t = h.store.mustGet(id);
    if (['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'].includes(t.state)) return t;
    h.clock.set(new Date(Math.max(h.clock.now().getTime(), Date.parse(t.nextRunAt))));
    await h.engine.drive(id);
  }
  return h.store.mustGet(id);
}

describe('5.2 saga orchestrator: happy path', () => {
  it('moves Rs 500 between two banks with hold, credit and capture', async () => {
    h = harness();
    const asha = party(h, 'KOSH', 1_000_000);
    const ravi = party(h, 'ALPHA', 0);
    const t = createPayment(h, asha, ravi, 50_000);
    const done = await run(t.id);
    expect(done.state).toBe('COMPLETED');
    expect(h.banks.balance(asha.accountId)).toBe(950_000);
    expect(h.banks.held(asha.accountId)).toBe(0);
    expect(h.banks.balance(ravi.accountId)).toBe(50_000);
    expect(h.banks.balance(h.banks.gl('KOSH', 'SWITCH'))).toBe(50_000);
    expect(h.banks.balance(h.banks.gl('ALPHA', 'SWITCH'))).toBe(-50_000);
    expect(done.holdId).toBeTruthy();
    expect(done.creditEntryId).toBeTruthy();
    expect(done.captureEntryId).toBeTruthy();
    expect(h.store.transitions(t.id).map((x) => x.to)).toEqual(['RISK_PASSED', 'DEBIT_HELD', 'CREDITED', 'COMPLETED']);
    expect(outboxTypes(h.db, t.id)).toEqual(['TxnStepCompleted', 'TxnStepCompleted', 'TxnStepCompleted', 'TxnStepCompleted', 'TxnCompleted']);
    expect(done.finishedAt).not.toBeNull();
    expect(done.leaseOwner).toBeNull();
    expectBalanced();
  });

  it('writes every bank step to the step log before and after the call', async () => {
    h = harness();
    const a = party(h, 'KOSH', 100_000);
    const b = party(h, 'BETA', 0);
    const seen: { step: string; status: string }[] = [];
    h.banks.onCall = async (_bank, step, body) => {
      const rows = h.store.steps(String(body.txnId)).filter((s) => s.step === step);
      seen.push({ step, status: rows.at(-1)!.status });
    };
    const t = createPayment(h, a, b, 1_000);
    await run(t.id);
    expect(seen).toEqual([
      { step: 'hold', status: 'STARTED' },
      { step: 'credit', status: 'STARTED' },
      { step: 'capture', status: 'STARTED' },
    ]);
    const steps = h.store.steps(t.id);
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual(['risk:OK', 'hold:OK', 'credit:OK', 'capture:OK']);
    expect(steps.every((s) => s.finishedAt !== null)).toBe(true);
    expect(steps[1]!.request).toEqual({ txnId: t.id, accountId: a.accountId, amount: 1_000, ttlSeconds: 600 });
  });

  it('pays between two customers of the same bank', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'KOSH', 0);
    const done = await run(createPayment(h, a, b, 2_500).id);
    expect(done.state).toBe('COMPLETED');
    expect(h.banks.balance(a.accountId)).toBe(7_500);
    expect(h.banks.balance(b.accountId)).toBe(2_500);
    expect(h.banks.balance(h.banks.gl('KOSH', 'SWITCH'))).toBe(0);
    expectBalanced();
  });

  it('a second drive of a finished saga is a no-op', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    const t = createPayment(h, a, b, 100);
    await run(t.id);
    const callsBefore = h.banks.calls.length;
    expect(await h.engine.drive(t.id)).toBeNull();
    expect(h.banks.calls.length).toBe(callsBefore);
  });
});

describe('5.2 saga orchestrator: business failure paths', () => {
  it('insufficient funds ends in DEBIT_FAILED with no hold left and no credit', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    const done = await run(createPayment(h, a, b, 50_000).id);
    expect(done).toMatchObject({ state: 'DEBIT_FAILED', failureCode: 'INSUFFICIENT_FUNDS', holdId: null });
    expect(h.banks.held(a.accountId)).toBe(0);
    expect(h.banks.balance(b.accountId)).toBe(0);
    expect(h.banks.calls.filter((c) => c.step === 'credit')).toHaveLength(0);
    expect(outboxTypes(h.db, done.id).at(-1)).toBe('TxnFailed');
    expectBalanced();
  });

  it('a credit the payee bank refuses releases the hold and ends REVERSED', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.close(b.accountId);
    const done = await run(createPayment(h, a, b, 4_000).id);
    expect(done).toMatchObject({ state: 'REVERSED', failureCode: 'ACCOUNT_NOT_OPEN', holdReleased: true, creditEntryId: null });
    expect(h.store.transitions(done.id).map((x) => x.to)).toEqual(['RISK_PASSED', 'DEBIT_HELD', 'CREDIT_FAILED', 'REVERSING', 'REVERSED']);
    expect(h.banks.balance(a.accountId)).toBe(10_000);
    expect(h.banks.held(a.accountId)).toBe(0);
    expect(outboxTypes(h.db, done.id).at(-1)).toBe('TxnReversed');
    expectBalanced();
  });

  it('a hold that expires before capture reverses the credit and ends REVERSED', async () => {
    h = harness({ config: { holdTtlSeconds: 1 } });
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.onCall = async (_bank, step) => {
      if (step === 'capture') h.clock.advance(5_000);
    };
    const done = await run(createPayment(h, a, b, 3_000).id);
    expect(done).toMatchObject({ state: 'REVERSED', failureCode: 'HOLD_EXPIRED' });
    expect(done.reversalEntryId).toBeTruthy();
    expect(h.banks.balance(a.accountId)).toBe(10_000);
    expect(h.banks.balance(b.accountId)).toBe(0);
    expect(h.banks.balance(h.banks.gl('ALPHA', 'SWITCH'))).toBe(0);
    expectBalanced();
  });

  it('a reversal the payee can no longer cover goes to MANUAL_REVIEW', async () => {
    h = harness({ config: { holdTtlSeconds: 1 } });
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.onCall = async (_bank, step) => {
      if (step === 'capture') {
        h.clock.advance(5_000);
        h.banks.spend(b.accountId, 3_000);
      }
    };
    const done = await run(createPayment(h, a, b, 3_000).id);
    expect(done).toMatchObject({ state: 'MANUAL_REVIEW', reviewFrom: 'REVERSING', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(outboxTypes(h.db, done.id).at(-1)).toBe('TxnManualReview');
    expectBalanced();
  });

  it('a changed retry body (ADAPTER_REQUEST_MISMATCH) is a bug and goes to MANUAL_REVIEW', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    const t = createPayment(h, a, b, 1_000);
    h.banks.preRecord('KOSH', t.id, 'hold', { txnId: t.id, accountId: a.accountId, amount: 1, ttlSeconds: 600 });
    const done = await run(t.id);
    expect(done).toMatchObject({ state: 'MANUAL_REVIEW', reviewFrom: 'RISK_PASSED', failureCode: 'ADAPTER_REQUEST_MISMATCH' });
    expect(h.banks.held(a.accountId)).toBe(0);
  });
});

describe('5.3 resilience: retries, unknown outcomes and the circuit breaker', () => {
  it('retries a transient 503 with backoff and completes', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.inject('ALPHA', 'credit', 'ERROR', 'ERROR');
    const started = h.clock.now().getTime();
    const done = await run(createPayment(h, a, b, 1_000).id);
    expect(done.state).toBe('COMPLETED');
    expect(h.store.steps(done.id).filter((s) => s.step === 'credit').map((s) => s.status)).toEqual(['TRANSIENT', 'TRANSIENT', 'OK']);
    expect(h.clock.now().getTime() - started).toBeGreaterThanOrEqual(25 + 50);
    expect(h.banks.balance(b.accountId)).toBe(1_000);
    expectBalanced();
  });

  it('timeout after commit: retrying the identical request replays and credits exactly once', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.inject('ALPHA', 'credit', 'TIMEOUT_AFTER_COMMIT');
    const done = await run(createPayment(h, a, b, 1_000).id);
    expect(done.state).toBe('COMPLETED');
    expect(h.banks.executed(done.id, 'credit')).toBe(1);
    expect(h.banks.balance(b.accountId)).toBe(1_000);
    expect(h.store.steps(done.id).filter((s) => s.step === 'credit').map((s) => s.status)).toEqual(['UNKNOWN', 'OK']);
    expectBalanced();
  });

  it('dropped socket after a hold commits: retry gets the same hold, no second hold', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.inject('KOSH', 'hold', 'DROP_AFTER_COMMIT');
    const done = await run(createPayment(h, a, b, 1_000).id);
    expect(done.state).toBe('COMPLETED');
    expect(h.banks.executed(done.id, 'hold')).toBe(1);
    expect([...h.banks.holds.values()].filter((x) => x.txnId === done.id)).toHaveLength(1);
    expectBalanced();
  });

  it('bank down for every hold attempt: DEBIT_FAILED with BANK_UNAVAILABLE, nothing moved', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('KOSH', 'hold', 'ERROR');
    const done = await run(createPayment(h, a, b, 1_000).id);
    expect(done).toMatchObject({ state: 'DEBIT_FAILED', failureCode: 'ADAPTER_FAULT_INJECTED' });
    expect(h.store.steps(done.id).filter((s) => s.step === 'hold')).toHaveLength(3);
    expect(h.banks.held(a.accountId)).toBe(0);
  });

  it('payee bank down for every credit attempt: CREDIT_FAILED, hold released, REVERSED', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('ALPHA', 'credit', 'ERROR');
    const done = await run(createPayment(h, a, b, 1_000).id);
    expect(done).toMatchObject({ state: 'REVERSED', holdReleased: true, creditEntryId: null });
    expect(h.banks.balance(a.accountId)).toBe(10_000);
    expect(h.banks.held(a.accountId)).toBe(0);
    expectBalanced();
  });

  it('credit outcome unknown on every attempt -> DEEMED; status inquiry later finds it DONE -> COMPLETED', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('ALPHA', 'credit', 'TIMEOUT_AFTER_COMMIT');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    const deemed = h.store.mustGet(t.id);
    expect(deemed).toMatchObject({ state: 'DEEMED', deemedStep: 'credit', failureCode: 'UPSTREAM_TIMEOUT' });
    expect(outboxTypes(h.db, t.id)).toContain('TxnDeemed');
    h.banks.clearFaults();
    const done = await run(t.id);
    expect(done.state).toBe('COMPLETED');
    expect(h.store.transitions(t.id).map((x) => x.to)).toEqual(['RISK_PASSED', 'DEBIT_HELD', 'DEEMED', 'CREDITED', 'COMPLETED']);
    expect(h.banks.executed(t.id, 'credit')).toBe(1);
    expect(h.store.steps(t.id).some((s) => s.step === 'inquiry' && s.code === 'DONE')).toBe(true);
    expectBalanced();
  });

  it('DEEMED credit that the bank actually declined -> CREDIT_FAILED -> REVERSED', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.close(b.accountId);
    h.banks.injectAlways('ALPHA', 'credit', 'TIMEOUT_AFTER_COMMIT');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id).state).toBe('DEEMED');
    h.banks.clearFaults();
    const done = await run(t.id);
    expect(h.store.steps(t.id).some((s) => s.step === 'inquiry' && s.code === 'FAILED')).toBe(true);
    expect(done).toMatchObject({ state: 'REVERSED', failureCode: 'ACCOUNT_NOT_OPEN', holdReleased: true });
    expect(h.banks.balance(a.accountId)).toBe(10_000);
    expectBalanced();
  });

  it('DEEMED where the request never reached the bank: inquiry finds nothing, resend succeeds', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('ALPHA', 'credit', 'TIMEOUT_BEFORE');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id).state).toBe('DEEMED');
    h.banks.clearFaults();
    const done = await run(t.id);
    expect(done.state).toBe('COMPLETED');
    expect(h.store.steps(t.id).some((s) => s.step === 'inquiry' && s.code === 'NOT_FOUND')).toBe(true);
    expectBalanced();
  });

  it('DEEMED that never resolves goes to MANUAL_REVIEW after the poll budget', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('ALPHA', 'credit', 'TIMEOUT_BEFORE');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    h.banks.setDown('ALPHA', true);
    const done = await run(t.id);
    expect(done).toMatchObject({ state: 'MANUAL_REVIEW', reviewFrom: 'DEEMED', failureCode: 'DEEMED_UNRESOLVED', deemedPolls: 4 });
    expect(h.store.steps(t.id).filter((s) => s.step === 'inquiry')).toHaveLength(5);
  });

  it('capture that keeps failing transiently parks the saga and completes once the bank is back', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('KOSH', 'capture', 'ERROR');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    const parked = h.store.mustGet(t.id);
    expect(parked).toMatchObject({ state: 'CREDITED', parkCount: 1 });
    expect(parked.nextRunAt > h.store.now()).toBe(true);
    expect(h.store.runnable(10)).toEqual([]);
    h.banks.clearFaults();
    const done = await run(t.id);
    expect(done).toMatchObject({ state: 'COMPLETED', parkCount: 0 });
    expectBalanced();
  });

  it('the circuit opens after repeated failures and fails fast without calling the bank', async () => {
    h = harness({ config: { breakerFailureThreshold: 3, maxAttempts: 3 } });
    const a = party(h, 'KOSH', 100_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('KOSH', 'hold', 'ERROR');
    const first = await run(createPayment(h, a, b, 100).id);
    expect(first.state).toBe('DEBIT_FAILED');
    expect(h.guards.for('KOSH').breaker.snapshot().state).toBe('OPEN');
    const callsBefore = h.banks.calls.length;
    const second = await run(createPayment(h, a, b, 100).id);
    expect(second).toMatchObject({ state: 'DEBIT_FAILED', failureCode: 'CIRCUIT_OPEN' });
    expect(h.banks.calls.length).toBe(callsBefore);
    h.banks.clearFaults();
    h.clock.advance(h.config.breakerCooldownMs);
    const third = await run(createPayment(h, a, b, 100).id);
    expect(third.state).toBe('COMPLETED');
    expect(h.guards.for('KOSH').breaker.snapshot().state).toBe('CLOSED');
  });

  it('a connection refused is transient, not unknown, so it never makes a saga DEEMED', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.setDown('KOSH', true);
    const done = await run(createPayment(h, a, b, 100).id);
    expect(done).toMatchObject({ state: 'DEBIT_FAILED', failureCode: 'UPSTREAM_UNAVAILABLE' });
  });

  it('compensation retries until the payer bank releases the hold', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.close(b.accountId);
    h.banks.injectAlways('KOSH', 'release', 'ERROR');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id)).toMatchObject({ state: 'REVERSING', holdReleased: false, parkCount: 1 });
    expect(h.banks.held(a.accountId)).toBe(1_000);
    h.banks.clearFaults();
    const done = await run(t.id);
    expect(done).toMatchObject({ state: 'REVERSED', holdReleased: true });
    expect(h.banks.held(a.accountId)).toBe(0);
    expectBalanced();
  });
});
