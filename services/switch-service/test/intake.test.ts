import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, encodePrincipal } from '@kosh/service-kit';
import { customerPrincipal, staffPrincipal, TEST_TOKEN } from '@kosh/test-kit';
import { harness, type Harness, outboxTypes, party, type Party } from './harness.ts';

let h: Harness;
let asha: Party;
let ravi: Party;

const SVC = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'test-service' };
function asCustomer(userId: string) {
  return { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(customerPrincipal(userId)) };
}
function asStaff(roles: ('SWITCH_OPS' | 'BANK_OPS' | 'ADMIN')[]) {
  return { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(staffPrincipal('stf_1', roles, null)) };
}

let keySeq = 0;
function key() {
  keySeq++;
  return `pay-key-${String(keySeq).padStart(6, '0')}`;
}

function pay(userId: string, body: Record<string, unknown>, idem: string | null = key()) {
  const r = request(h.app).post('/pay').set(asCustomer(userId));
  if (idem) r.set('idempotency-key', idem);
  return r.send(body);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { payerVpa: asha.vpa, payeeVpa: ravi.vpa, amount: 50_000, mpinToken: h.identity.issue(asha.userId), ...overrides };
}

beforeEach(() => {
  h = harness();
  asha = party(h, 'KOSH', 1_000_000, 'Asha V');
  ravi = party(h, 'ALPHA', 0, 'Ravi K');
});

afterEach(() => h.cleanup());

describe('5.1 payment intake: POST /pay', () => {
  it('accepts a valid payment with 202, a 12-digit RRN and a TxnInitiated event, and moves no money yet', async () => {
    const r = await pay(asha.userId, validBody({ note: 'dinner' }));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'PENDING', state: 'INITIATED', amount: 50_000, payerVpa: asha.vpa, payeeVpa: ravi.vpa, payeeName: 'Ravi K', note: 'dinner' });
    expect(r.body.rrn).toMatch(/^\d{12}$/);
    expect(r.body.id).toMatch(/^txn_/);
    expect(outboxTypes(h.db, r.body.id)).toEqual(['TxnInitiated']);
    expect(h.banks.calls).toHaveLength(0);
    const t = h.store.mustGet(r.body.id);
    expect(t).toMatchObject({ payerAccount: asha.accountId, payeeAccount: ravi.accountId, payerBank: 'KOSH', payeeBank: 'ALPHA', payeeUserId: ravi.userId });
  });

  it('a double click with the same idempotency key creates one transaction and replays the answer', async () => {
    const body = validBody();
    const k = key();
    const [first, second] = await Promise.all([pay(asha.userId, body, k), pay(asha.userId, body, k)]);
    expect(first.body.id).toBe(second.body.id);
    expect([first.headers['idempotent-replayed'], second.headers['idempotent-replayed']]).toContain('true');
    const third = await pay(asha.userId, body, k);
    expect(third.status).toBe(202);
    expect(third.body.id).toBe(first.body.id);
    expect(h.store.countsByState()).toEqual({ INITIATED: 1 });
  });

  it('a replay still works after the MPIN token is gone, but a changed body is rejected', async () => {
    const k = key();
    const body = validBody();
    const first = await pay(asha.userId, body, k);
    const replay = await pay(asha.userId, { ...body, mpinToken: 'expired-token-xyz' }, k);
    expect(replay.body.id).toBe(first.body.id);
    const changed = await pay(asha.userId, { ...body, amount: 1 }, k);
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('an idempotency key is scoped to the user', async () => {
    const k = key();
    await pay(asha.userId, validBody(), k).expect(202);
    const other = party(h, 'BETA', 10_000);
    const r = await pay(other.userId, { payerVpa: other.vpa, payeeVpa: ravi.vpa, amount: 100, mpinToken: h.identity.issue(other.userId) }, k);
    expect(r.status).toBe(202);
    expect(h.store.countsByState()).toEqual({ INITIATED: 2 });
  });

  it('an MPIN token can pay only once', async () => {
    const token = h.identity.issue(asha.userId);
    await pay(asha.userId, validBody({ mpinToken: token })).expect(202);
    const again = await pay(asha.userId, validBody({ mpinToken: token, amount: 10 }));
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('MPIN_TOKEN_USED');
    expect(h.store.countsByState()).toEqual({ INITIATED: 1 });
  });

  it('rejects missing or bad MPIN tokens', async () => {
    expect((await pay(asha.userId, validBody({ mpinToken: 'not-a-real-token' }))).body.error.code).toBe('MPIN_TOKEN_INVALID');
    expect((await pay(asha.userId, validBody({ mpinToken: h.identity.issue(ravi.userId) }))).body.error.code).toBe('MPIN_TOKEN_NOT_YOURS');
    expect((await pay(asha.userId, validBody({ mpinToken: h.identity.issue(asha.userId, 'BALANCE') }))).body.error.code).toBe('MPIN_TOKEN_PURPOSE');
    const missing = await pay(asha.userId, { payerVpa: asha.vpa, payeeVpa: ravi.vpa, amount: 100 });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');
    expect(h.store.countsByState()).toEqual({});
  });

  it('validates the body: amount must be positive integer paise within the limit', async () => {
    for (const amount of [0, -5, 10.5, '500', Number.MAX_SAFE_INTEGER + 1]) {
      const r = await pay(asha.userId, validBody({ amount }));
      expect(r.status).toBe(400);
    }
    const tooBig = await pay(asha.userId, validBody({ amount: h.config.maxTxnAmount + 1 }));
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('AMOUNT_LIMIT_EXCEEDED');
    expect((await pay(asha.userId, validBody({ payeeVpa: 'not-a-vpa' }))).status).toBe(400);
    expect((await pay(asha.userId, validBody({ payeeVpa: asha.vpa }))).body.error.code).toBe('SAME_VPA');
  });

  it('requires an idempotency key and a customer caller', async () => {
    const noKey = await pay(asha.userId, validBody(), null);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const staff = await request(h.app).post('/pay').set(asStaff(['SWITCH_OPS'])).set('idempotency-key', key()).send(validBody());
    expect(staff.status).toBe(403);
    const anon = await request(h.app).post('/pay').set(SVC).set('idempotency-key', key()).send(validBody());
    expect(anon.status).toBe(401);
    const noToken = await request(h.app).post('/pay').set('idempotency-key', key()).send(validBody());
    expect(noToken.body.error.code).toBe('INTERNAL_TOKEN_INVALID');
  });

  it('only lets you pay from your own VPA and reports payee problems clearly', async () => {
    const stranger = party(h, 'BETA', 10_000);
    const stolen = await pay(asha.userId, validBody({ payerVpa: stranger.vpa }));
    expect(stolen.status).toBe(403);
    expect(stolen.body.error.code).toBe('PAYER_VPA_NOT_OWNED');
    expect((await pay(asha.userId, validBody({ payeeVpa: 'ghost@alpha' }))).body.error.code).toBe('PAYEE_VPA_NOT_FOUND');
    h.vpa.fail('frozen@alpha', new AppError(422, 'ACCOUNT_INACTIVE', 'linked account cannot receive'));
    const frozen = await pay(asha.userId, validBody({ payeeVpa: 'frozen@alpha' }));
    expect(frozen.status).toBe(422);
    expect(frozen.body.error.code).toBe('PAYEE_ACCOUNT_INACTIVE');
    h.vpa.add('twin@kosh', asha.userId, 'KOSH', asha.accountId);
    expect((await pay(asha.userId, validBody({ payeeVpa: 'twin@kosh' }))).body.error.code).toBe('SAME_ACCOUNT');
    h.vpa.fail('down@alpha', new AppError(503, 'UPSTREAM_UNAVAILABLE', 'vpa-service down'));
    expect((await pay(asha.userId, validBody({ payeeVpa: 'down@alpha' }))).status).toBe(503);
    expect(h.store.countsByState()).toEqual({});
  });
});

describe('5.1 payment status: GET /txn/:id and GET /txns', () => {
  it('payer and payee can read the transaction, nobody else can', async () => {
    const r = await pay(asha.userId, validBody());
    const id = r.body.id as string;
    const mine = await request(h.app).get(`/txn/${id}`).set(asCustomer(asha.userId));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id, rrn: r.body.rrn, status: 'PENDING' });
    expect(mine.body.payerAccount).toBeUndefined();
    expect((await request(h.app).get(`/txn/${id}`).set(asCustomer(ravi.userId))).status).toBe(200);
    expect((await request(h.app).get(`/txn/${id}`).set(asCustomer('usr_stranger'))).status).toBe(404);
    expect((await request(h.app).get('/txn/txn_missing').set(asCustomer(asha.userId))).status).toBe(404);
    expect((await request(h.app).get(`/txn/${id}`).set(asStaff(['BANK_OPS']))).status).toBe(403);
    const ops = await request(h.app).get(`/txn/${id}`).set(asStaff(['SWITCH_OPS']));
    expect(ops.body.payer.accountId).toBe(asha.accountId);
  });

  it('shows the final state once the saga has run', async () => {
    const r = await pay(asha.userId, validBody());
    await h.engine.drive(r.body.id);
    const done = await request(h.app).get(`/txn/${r.body.id}`).set(asCustomer(asha.userId));
    expect(done.body).toMatchObject({ status: 'SUCCESS', state: 'COMPLETED', failureCode: null });
    expect(done.body.finishedAt).not.toBeNull();
    const list = await request(h.app).get('/txns').set(asCustomer(ravi.userId));
    expect(list.body.txns.map((t: { id: string }) => t.id)).toEqual([r.body.id]);
  });

  it('shows a failure code to the customer when the payment fails', async () => {
    const r = await pay(asha.userId, validBody({ amount: 5_000_000 }));
    await h.engine.drive(r.body.id);
    const done = await request(h.app).get(`/txn/${r.body.id}`).set(asCustomer(asha.userId));
    expect(done.body).toMatchObject({ status: 'FAILED', state: 'DEBIT_FAILED', failureCode: 'INSUFFICIENT_FUNDS' });
  });
});
