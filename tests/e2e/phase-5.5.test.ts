import { describe, expect, it } from 'vitest';
import { bankOps, call, gw, internalHeaders, poll, registerCustomer, url } from './helpers.ts';
import { admin, balance, clearFaults, customer, expectInvariants, pay, setFault, switchOps, waitState } from './switch-helpers.ts';

describe('phase 5.5 - load', () => {
  it('80 payments across three banks with 16 in flight all complete, with p99 time-to-final under 5 s', async () => {
    const banks = ['KOSH', 'ALPHA', 'BETA'];
    const payers = await Promise.all(Array.from({ length: 8 }, (_, i) => customer(banks[i % 3]!, 1_000_000)));
    const payees = await Promise.all(Array.from({ length: 8 }, (_, i) => customer(banks[(i + 1) % 3]!)));
    const jobs = Array.from({ length: 80 }, (_, i) => ({ payer: payers[i % 8]!, payee: payees[(i * 5) % 8]!, amount: 100 + i }));
    const latencies: number[] = [];
    const states: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const started = performance.now();
        const r = await pay(job.payer, job.payee, job.amount);
        expect(r.status).toBe(202);
        const done = await waitState(r.body.id, undefined, 30000);
        latencies.push(performance.now() - started);
        states.push(done.txn.state);
      }
    };
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 16 }, worker));
    const seconds = (performance.now() - t0) / 1000;
    expect(states).toEqual(jobs.map(() => 'COMPLETED'));
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.ceil(latencies.length * 0.99) - 1]!;
    process.stdout.write(`switch load: ${jobs.length} payments in ${seconds.toFixed(1)}s (${(jobs.length / seconds).toFixed(1)}/s), p50 ${latencies[Math.floor(latencies.length / 2)]!.toFixed(0)}ms p99 ${p99.toFixed(0)}ms\n`);
    expect(p99).toBeLessThan(5000);
    for (let i = 0; i < 8; i++) {
      const sent = jobs.filter((j) => j.payer === payers[i]).reduce((s, j) => s + j.amount, 0);
      const received = jobs.filter((j) => j.payee === payees[i]).reduce((s, j) => s + j.amount, 0);
      expect(await balance(payers[i]!)).toMatchObject({ ledgerBalance: 1_000_000 - sent, heldAmount: 0 });
      expect((await balance(payees[i]!)).ledgerBalance).toBe(received);
    }
    const metrics = await call('GET', gw('/api/switch/ops/metrics'), { token: await switchOps() });
    expect(metrics.status).toBe(200);
    expect(metrics.body.states.COMPLETED).toBeGreaterThanOrEqual(80);
    expect(metrics.body.latencyMs.p99).not.toBeNull();
    expect(metrics.body.window.successRate).toBeGreaterThan(0);
    await expectInvariants();
  });
});

describe('phase 5.5 - staff resolution tools', () => {
  it('a changed adapter body lands in MANUAL_REVIEW; switch ops can inspect and reverse it', async () => {
    const payer = await customer('KOSH', 20_000);
    const payee = await customer('ALPHA');
    const ops = await switchOps();
    await setFault('KOSH', 'hold', { mode: 'LATENCY', latencyMs: 500, remaining: 1 });
    let squatterHold: string | null = null;
    try {
      const r = await pay(payer, payee, 5_000);
      expect(r.status).toBe(202);
      const txnId = r.body.id as string;
      await poll(async () => {
        const f = await call('GET', gw('/api/adapter/banks/KOSH/faults'), { token: await admin() });
        return f.body.faults.find((x: { op: string }) => x.op === 'hold')?.remaining === 0;
      }, 'the switch hold call to consume the latency fault');
      const squat = await fetch(url('KOSH_ADAPTER_URL', '/banks/KOSH/hold'), {
        method: 'POST',
        headers: { ...internalHeaders('e2e'), 'content-type': 'application/json' },
        body: JSON.stringify({ txnId, accountId: payer.accountId, amount: 1, ttlSeconds: 60 }),
      });
      expect(squat.status).toBe(200);
      squatterHold = ((await squat.json()) as { holdId: string }).holdId;
      const reviewed = await waitState(txnId, ['MANUAL_REVIEW', 'COMPLETED', 'DEBIT_FAILED', 'REVERSED']);
      expect(reviewed.txn).toMatchObject({ state: 'MANUAL_REVIEW', failureCode: 'ADAPTER_REQUEST_MISMATCH', reviewFrom: 'RISK_PASSED' });

      const list = await call('GET', gw('/api/switch/ops/txns?state=MANUAL_REVIEW'), { token: ops });
      expect(list.body.txns.map((t: { id: string }) => t.id)).toContain(txnId);
      const detail = await call('GET', gw(`/api/switch/ops/txns/${txnId}?inquire=true`), { token: ops });
      expect(detail.status).toBe(200);
      expect(detail.body.steps.some((s: { status: string }) => s.status === 'MISMATCH')).toBe(true);
      expect(detail.body.inquiries.find((i: { bankCode: string }) => i.bankCode === 'KOSH').ok).toBe(true);

      const customerTry = await call('POST', gw(`/api/switch/ops/txns/${txnId}/reverse`), { token: payer.session.accessToken, body: { reason: 'give it back now' } });
      expect(customerTry.status).toBe(403);
      const bankStaff = await call('POST', gw(`/api/switch/ops/txns/${txnId}/reverse`), { token: (await bankOps('KOSH')).maker.token, body: { reason: 'give it back now' } });
      expect(bankStaff.status).toBe(403);

      const reversed = await call('POST', gw(`/api/switch/ops/txns/${txnId}/reverse`), { token: ops, body: { reason: 'adapter record belongs to a different request' } });
      expect(reversed.status).toBe(200);
      const done = await waitState(txnId, ['REVERSED']);
      expect(done.txn.state).toBe('REVERSED');
      const view = await call('GET', gw(`/api/switch/txn/${txnId}`), { token: payer.session.accessToken });
      expect(view.body.status).toBe('FAILED');
      expect((await balance(payee)).ledgerBalance).toBe(0);
    } finally {
      await clearFaults('KOSH');
      if (squatterHold) {
        await call('POST', gw(`/api/ledger/banks/KOSH/holds/${squatterHold}/release`), { token: await admin(), body: {} });
      }
    }
    expect(await balance(payer)).toMatchObject({ ledgerBalance: 20_000, heldAmount: 0 });
    await expectInvariants();
  });

  it('switch metrics need SWITCH_OPS', async () => {
    const s = await registerCustomer();
    expect((await call('GET', gw('/api/switch/ops/metrics'), { token: s.accessToken })).status).toBe(403);
    const m = await call('GET', gw('/api/switch/ops/metrics'), { token: await switchOps() });
    expect(m.body).toHaveProperty('breakers');
    expect(m.body).toHaveProperty('bankOutcomes');
  });
});
