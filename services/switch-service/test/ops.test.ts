import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePrincipal } from '@kosh/service-kit';
import { customerPrincipal, staffPrincipal, TEST_TOKEN } from '@kosh/test-kit';
import { createPayment, harness, type Harness, outboxTypes, party } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const OPS = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(staffPrincipal('stf_ops', ['SWITCH_OPS'], null)) };
const BANK = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(staffPrincipal('stf_bank', ['BANK_OPS'], 'KOSH')) };
const CUSTOMER = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(customerPrincipal('usr_x')) };

async function reviewed() {
  h = harness();
  const a = party(h, 'KOSH', 10_000);
  const b = party(h, 'ALPHA', 0);
  const t = createPayment(h, a, b, 1_000);
  h.banks.preRecord('KOSH', t.id, 'hold', { txnId: t.id, accountId: a.accountId, amount: 1, ttlSeconds: 600 });
  await h.engine.drive(t.id);
  expect(h.store.mustGet(t.id).state).toBe('MANUAL_REVIEW');
  return { a, b, t };
}

describe('5.5 staff resolution tools', () => {
  it('lists MANUAL_REVIEW transactions and shows the full trace with a live bank inquiry', async () => {
    const { t } = await reviewed();
    const list = await request(h.app).get('/ops/txns?state=MANUAL_REVIEW').set(OPS);
    expect(list.body.txns.map((x: { id: string }) => x.id)).toEqual([t.id]);
    const detail = await request(h.app).get(`/ops/txns/${t.id}?inquire=true`).set(OPS);
    expect(detail.body.txn).toMatchObject({ state: 'MANUAL_REVIEW', reviewFrom: 'RISK_PASSED', failureCode: 'ADAPTER_REQUEST_MISMATCH' });
    expect(detail.body.steps.map((s: { step: string; status: string }) => `${s.step}:${s.status}`)).toEqual(['risk:OK', 'hold:MISMATCH']);
    expect(detail.body.transitions.map((x: { to: string }) => x.to)).toEqual(['RISK_PASSED', 'MANUAL_REVIEW']);
    expect(detail.body.inquiries.map((i: { bankCode: string }) => i.bankCode).sort()).toEqual(['ALPHA', 'KOSH']);
    expect((await request(h.app).get('/ops/txns?state=BOGUS').set(OPS)).status).toBe(400);
  });

  it('retry resumes from the state before review; a still-broken step lands back in review', async () => {
    const { t } = await reviewed();
    const r = await request(h.app).post(`/ops/txns/${t.id}/retry`).set(OPS).send({ reason: 'checked adapter, retrying' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'RISK_PASSED', reviewFrom: null });
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id).state).toBe('MANUAL_REVIEW');
    expect(h.store.opsActions(t.id)).toMatchObject([{ action: 'RETRY', staffId: 'stf_ops', from: 'MANUAL_REVIEW', to: 'RISK_PASSED' }]);
  });

  it('reverse compensates what the switch recorded and ends REVERSED', async () => {
    const { a, t } = await reviewed();
    const r = await request(h.app).post(`/ops/txns/${t.id}/reverse`).set(OPS).send({ reason: 'hold body mismatch, cancel payment' });
    expect(r.body.state).toBe('REVERSING');
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id).state).toBe('REVERSED');
    expect(h.banks.balance(a.accountId)).toBe(10_000);
    expect(outboxTypes(h.db, t.id)).toContain('TxnReversed');
    const again = await request(h.app).post(`/ops/txns/${t.id}/reverse`).set(OPS).send({ reason: 'second click on reverse' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TXN_NOT_IN_REVIEW');
  });

  it('retrying a step the bank declined replays the stored decline, so the case stays in review', async () => {
    h = harness({ config: { holdTtlSeconds: 1 } });
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.onCall = async (_bank, step) => {
      if (step === 'capture') {
        h.clock.advance(5_000);
        h.banks.spend(b.accountId, 1_000);
      }
    };
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id)).toMatchObject({ state: 'MANUAL_REVIEW', reviewFrom: 'REVERSING' });
    h.banks.onCall = null;
    h.banks.spend(b.accountId, -1_000);
    const r = await request(h.app).post(`/ops/txns/${t.id}/retry`).set(OPS).send({ reason: 'payee topped up, retry reversal' });
    expect(r.body.state).toBe('REVERSING');
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id)).toMatchObject({ state: 'MANUAL_REVIEW', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(h.banks.executed(t.id, 'reverse')).toBe(0);
    expect(h.banks.invariants()).toEqual([]);
  });

  it('reverse after an unresolved DEEMED credit asks the bank first and releases the hold only if the credit never happened', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('ALPHA', 'credit', 'TIMEOUT_BEFORE');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    h.banks.setDown('ALPHA', true);
    for (let i = 0; i < 10 && h.store.mustGet(t.id).state === 'DEEMED'; i++) {
      h.clock.advance(h.config.deemedPollMs);
      await h.engine.drive(t.id);
    }
    expect(h.store.mustGet(t.id)).toMatchObject({ state: 'MANUAL_REVIEW', reviewFrom: 'DEEMED', deemedStep: 'credit' });
    const blind = await request(h.app).post(`/ops/txns/${t.id}/reverse`).set(OPS).send({ reason: 'customer wants money back' });
    expect(blind.status).toBe(503);
    expect(blind.body.error.code).toBe('BANK_INQUIRY_FAILED');
    h.banks.clearFaults();
    const r = await request(h.app).post(`/ops/txns/${t.id}/reverse`).set(OPS).send({ reason: 'ALPHA confirms no credit' });
    expect(r.status).toBe(200);
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id)).toMatchObject({ state: 'REVERSED', holdReleased: true });
    expect(h.banks.held(a.accountId)).toBe(0);
    expect(h.banks.invariants()).toEqual([]);
  });

  it('reverse is refused when the deemed credit actually succeeded; retry completes the payment instead', async () => {
    h = harness();
    const a = party(h, 'KOSH', 10_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.injectAlways('ALPHA', 'credit', 'TIMEOUT_AFTER_COMMIT');
    const t = createPayment(h, a, b, 1_000);
    await h.engine.drive(t.id);
    h.banks.setDown('ALPHA', true);
    for (let i = 0; i < 10 && h.store.mustGet(t.id).state === 'DEEMED'; i++) {
      h.clock.advance(h.config.deemedPollMs);
      await h.engine.drive(t.id);
    }
    expect(h.store.mustGet(t.id).state).toBe('MANUAL_REVIEW');
    h.banks.clearFaults();
    const refused = await request(h.app).post(`/ops/txns/${t.id}/reverse`).set(OPS).send({ reason: 'customer wants money back' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('DEEMED_STEP_SUCCEEDED');
    await request(h.app).post(`/ops/txns/${t.id}/retry`).set(OPS).send({ reason: 'ALPHA confirms the credit' }).expect(200);
    await h.engine.drive(t.id);
    expect(h.store.mustGet(t.id).state).toBe('COMPLETED');
    expect(h.banks.balance(b.accountId)).toBe(1_000);
    expect(h.banks.invariants()).toEqual([]);
  });

  it('only SWITCH_OPS or ADMIN staff may use the tools, and a reason is required', async () => {
    const { t } = await reviewed();
    expect((await request(h.app).get('/ops/txns').set(BANK)).status).toBe(403);
    expect((await request(h.app).get('/ops/txns').set(CUSTOMER)).status).toBe(403);
    expect((await request(h.app).post(`/ops/txns/${t.id}/retry`).set(BANK).send({ reason: 'not my job really' })).status).toBe(403);
    expect((await request(h.app).post(`/ops/txns/${t.id}/retry`).set(OPS).send({ reason: 'no' })).status).toBe(400);
    expect((await request(h.app).post('/ops/txns/txn_nope/retry').set(OPS).send({ reason: 'missing txn here' })).status).toBe(404);
  });

  it('refuses to act on a transaction that is not in review', async () => {
    h = harness();
    const t = createPayment(h, party(h, 'KOSH', 10_000), party(h, 'ALPHA', 0), 100);
    await h.engine.drive(t.id);
    const r = await request(h.app).post(`/ops/txns/${t.id}/reverse`).set(OPS).send({ reason: 'customer complained' });
    expect(r.status).toBe(409);
  });
});

describe('5.5 metrics', () => {
  it('reports counts by state, success rate, latency percentiles, bank outcomes and breakers', async () => {
    h = harness();
    const a = party(h, 'KOSH', 1_000_000);
    const b = party(h, 'ALPHA', 0);
    h.banks.inject('ALPHA', 'credit', 'ERROR');
    for (let i = 0; i < 4; i++) await h.engine.drive(createPayment(h, a, b, 100).id);
    await h.engine.drive(createPayment(h, a, b, 99_999_999).id);
    const m = await request(h.app).get('/ops/metrics').set(OPS);
    expect(m.status).toBe(200);
    expect(m.body.states).toEqual({ COMPLETED: 4, DEBIT_FAILED: 1 });
    expect(m.body.window).toMatchObject({ finished: 5, completed: 4, debitFailed: 1, successRate: 0.8 });
    expect(m.body.latencyMs.count).toBe(4);
    expect(m.body.latencyMs.p99).toBeGreaterThanOrEqual(0);
    expect(m.body.bankOutcomes).toContainEqual({ bankCode: 'ALPHA', step: 'credit', status: 'TRANSIENT', n: 1 });
    expect(m.body.breakers.map((x: { bankCode: string }) => x.bankCode)).toEqual(['ALPHA', 'KOSH']);
    expect(m.body.engine.outcomes.ALPHA).toMatchObject({ OK: 4, TRANSIENT: 1 });
    expect((await request(h.app).get('/ops/breakers').set(OPS)).body.banks).toHaveLength(2);
  });
});
