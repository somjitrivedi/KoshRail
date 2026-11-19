import { afterEach, describe, expect, it } from 'vitest';
import { call, gw } from './helpers.ts';
import { balance, clearFaults, customer, expectInvariants, ledgerByReference, payAndWait, setFault, stepCount, switchOps } from './switch-helpers.ts';

afterEach(async () => {
  await clearFaults();
});

describe('phase 5.3 - resilience', () => {
  it('two transient 503s on the credit are retried with backoff and the payment completes', async () => {
    const payer = await customer('KOSH', 50_000);
    const payee = await customer('ALPHA');
    await setFault('ALPHA', 'credit', { mode: 'ERROR', remaining: 2 });
    const done = await payAndWait(payer, payee, 4_000);
    expect(done.txn.state).toBe('COMPLETED');
    expect(stepCount(done, 'credit', 'TRANSIENT')).toBe(2);
    expect(stepCount(done, 'credit', 'OK')).toBe(1);
    expect((await balance(payee)).ledgerBalance).toBe(4_000);
    await expectInvariants();
  });

  it('timeout after commit: the switch retries the identical request and the payee is credited exactly once', async () => {
    const payer = await customer('KOSH', 50_000);
    const payee = await customer('BETA');
    await setFault('BETA', 'credit', { mode: 'TIMEOUT_AFTER_COMMIT', remaining: 1 });
    const done = await payAndWait(payer, payee, 3_300);
    expect(done.txn.state).toBe('COMPLETED');
    expect(stepCount(done, 'credit', 'UNKNOWN')).toBe(1);
    expect((await balance(payee)).ledgerBalance).toBe(3_300);
    expect((await ledgerByReference('BETA', done.txn.id)).entries.filter((e) => e.kind === 'CREDIT')).toHaveLength(1);
    await expectInvariants();
  });

  it('dropped connection after the hold commits: the retry gets the same hold back', async () => {
    const payer = await customer('ALPHA', 50_000);
    const payee = await customer('KOSH');
    await setFault('ALPHA', 'hold', { mode: 'DROP_RESPONSE', remaining: 1 });
    const done = await payAndWait(payer, payee, 1_200);
    expect(done.txn.state).toBe('COMPLETED');
    expect(stepCount(done, 'hold', 'UNKNOWN')).toBe(1);
    expect((await ledgerByReference('ALPHA', done.txn.id)).holds).toHaveLength(1);
    expect(await balance(payer)).toMatchObject({ ledgerBalance: 48_800, heldAmount: 0 });
    await expectInvariants();
  });

  it('every credit attempt times out: the payment goes DEEMED and the status poller completes it', async () => {
    const payer = await customer('KOSH', 50_000);
    const payee = await customer('ALPHA');
    await setFault('ALPHA', 'credit', { mode: 'LATENCY', latencyMs: 1500 });
    const done = await payAndWait(payer, payee, 2_500);
    expect(done.txn.state).toBe('COMPLETED');
    const path = done.transitions.map((t: { to: string }) => t.to);
    expect(path).toEqual(['RISK_PASSED', 'DEBIT_HELD', 'DEEMED', 'CREDITED', 'COMPLETED']);
    expect(stepCount(done, 'credit', 'UNKNOWN')).toBe(3);
    expect(stepCount(done, 'inquiry')).toBeGreaterThanOrEqual(1);
    expect((await balance(payee)).ledgerBalance).toBe(2_500);
    expect((await ledgerByReference('ALPHA', done.txn.id)).entries.filter((e) => e.kind === 'CREDIT')).toHaveLength(1);
    await expectInvariants();
  });

  it('a deemed hold that the bank actually declined ends DEBIT_FAILED without touching the payee', async () => {
    const payer = await customer('BETA', 1_000);
    const payee = await customer('KOSH');
    await setFault('BETA', 'hold', { mode: 'LATENCY', latencyMs: 1500 });
    const done = await payAndWait(payer, payee, 9_000);
    expect(done.txn).toMatchObject({ state: 'DEBIT_FAILED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(done.transitions.map((t: { to: string }) => t.to)).toEqual(['RISK_PASSED', 'DEEMED', 'DEBIT_FAILED']);
    expect(await balance(payer)).toMatchObject({ ledgerBalance: 1_000, heldAmount: 0 });
    expect(stepCount(done, 'credit')).toBe(0);
    await expectInvariants();
  });

  it('the circuit to a failing bank opens, fails fast, and closes again after the cooldown', async () => {
    const payer = await customer('BETA', 100_000);
    const payee = await customer('ALPHA');
    const ops = await switchOps();
    await setFault('BETA', 'hold', { mode: 'ERROR' });
    const first = await payAndWait(payer, payee, 100);
    const second = await payAndWait(payer, payee, 100);
    expect(first.txn.state).toBe('DEBIT_FAILED');
    expect(second.txn.state).toBe('DEBIT_FAILED');
    const failFast = [...first.steps, ...second.steps].filter((s: { code: string | null }) => s.code === 'CIRCUIT_OPEN');
    expect(failFast.length).toBeGreaterThanOrEqual(1);
    expect(failFast.every((s: { httpStatus: number | null }) => s.httpStatus === null)).toBe(true);
    const breakers = await call('GET', gw('/api/switch/ops/breakers'), { token: ops });
    const beta = breakers.body.banks.find((b: { bankCode: string }) => b.bankCode === 'BETA');
    expect(beta.breaker.opens).toBeGreaterThanOrEqual(1);
    await clearFaults('BETA');
    await new Promise((r) => setTimeout(r, 1200));
    const recovered = await payAndWait(payer, payee, 100);
    expect(recovered.txn.state).toBe('COMPLETED');
    const after = await call('GET', gw('/api/switch/ops/breakers'), { token: ops });
    expect(after.body.banks.find((b: { bankCode: string }) => b.bankCode === 'BETA').breaker.state).toBe('CLOSED');
    expect(await balance(payer)).toMatchObject({ ledgerBalance: 99_900, heldAmount: 0 });
    await expectInvariants();
  });
});
