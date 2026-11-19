import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Principal } from '@kosh/contracts';
import { encodePrincipal, migrationsDir, notFound, openDb, type Db } from '@kosh/service-kit';
import { customerPrincipal, FakeClock, staffPrincipal, TEST_TOKEN, testLogger } from '@kosh/test-kit';
import { buildAccounts } from '../src/app.ts';

const MIGRATIONS = migrationsDir(new URL('../src/main.ts', import.meta.url).href);
const H = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway' };
const SVC = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'ledger-service' };

const maker = staffPrincipal('stf_maker', ['BANK_OPS'], 'KOSH');
const checker = staffPrincipal('stf_checker', ['BANK_OPS'], 'KOSH');
const alphaOps = staffPrincipal('stf_alpha', ['BANK_OPS'], 'ALPHA');
const admin = staffPrincipal('stf_admin', ['ADMIN']);

let db: Db;
let app: Express;
let balances: Record<string, { ledgerBalance: number; heldAmount: number }>;
let refreshed: string[];
const users: Record<string, string> = { usr_asha: '9999999999', usr_ravi: '8888888888' };

function as(p: Principal) {
  return { ...H, 'x-kosh-principal': encodePrincipal(p) };
}

function outbox(type?: string) {
  const rows = db.prepare('SELECT type, payload FROM _outbox ORDER BY seq').all() as { type: string; payload: string }[];
  return rows.filter((r) => !type || r.type === type).map((r) => ({ type: r.type, payload: JSON.parse(r.payload) }));
}

async function customerWithAccount(phone = '9999999999', type: 'SAVINGS' | 'CURRENT' = 'SAVINGS', kycTier = 'FULL') {
  const c = await request(app).post('/customers').set(as(maker)).send({ bankCode: 'KOSH', fullName: 'Asha Verma', phone, kycTier });
  expect(c.status).toBe(201);
  const a = await request(app).post('/accounts').set(as(maker)).send({ customerId: c.body.id, type });
  expect(a.status).toBe(201);
  await request(app).post(`/accounts/${a.body.id}/activate`).set(as(maker)).send({}).expect(200);
  return { customer: c.body, account: a.body };
}

async function approvalFlow(accountId: string, kind: string, payload = {}) {
  const req = await request(app).post('/approvals').set(as(maker)).send({ accountId, kind, reason: 'ops request', payload });
  expect(req.status).toBe(201);
  return request(app).post(`/approvals/${req.body.id}/approve`).set(as(checker)).send({ note: 'ok' });
}

beforeEach(() => {
  db = openDb(':memory:', MIGRATIONS);
  balances = {};
  refreshed = [];
  app = buildAccounts({
    db,
    clock: new FakeClock(),
    log: testLogger(),
    internalToken: TEST_TOKEN,
    users: {
      getUser: async (id) => {
        const phone = users[id];
        if (!phone) throw notFound('USER_NOT_FOUND', 'no user');
        return { id, phone, name: 'X', status: 'ACTIVE' };
      },
    },
    ledger: {
      getBalance: async (_b, id) => balances[id] ?? { ledgerBalance: 0, heldAmount: 0 },
      refresh: async (_b, id) => {
        refreshed.push(id);
      },
    },
  }).app;
});

describe('banks and chart of accounts', () => {
  it('seeds three banks with five GL accounts each and emits AccountOpened', async () => {
    const banks = await request(app).get('/banks').set(as(maker));
    expect(banks.body.banks.map((b: { code: string }) => b.code)).toEqual(['ALPHA', 'BETA', 'KOSH']);
    const opened = outbox('AccountOpened');
    expect(opened).toHaveLength(15);
    expect(new Set(opened.map((e) => e.payload.glCode))).toEqual(new Set(['CASH', 'SWITCH_SETTLEMENT', 'SUSPENSE', 'FEES', 'CENTRAL_SETTLEMENT']));
    const gl = await request(app).get('/internal/banks/KOSH/gl/SWITCH_SETTLEMENT').set(SVC);
    expect(gl.body).toMatchObject({ type: 'INTERNAL', glCode: 'SWITCH_SETTLEMENT', status: 'ACTIVE', bankCode: 'KOSH' });
    const handle = await request(app).get('/internal/banks/by-handle/alpha').set(SVC);
    expect(handle.body.code).toBe('ALPHA');
  });
});

describe('customers and accounts', () => {
  it('opens a pending account with tier limits and activates it', async () => {
    const c = await request(app).post('/customers').set(as(maker)).send({ bankCode: 'KOSH', fullName: 'Asha Verma', phone: '9999999999', kycTier: 'MIN' });
    const a = await request(app).post('/accounts').set(as(maker)).send({ customerId: c.body.id });
    expect(a.body).toMatchObject({ status: 'PENDING', type: 'SAVINGS', perTxnLimit: 1_000_000, dailyDebitLimit: 2_000_000, ifsc: 'KOSH0000001' });
    expect(a.body.accountNumber).toMatch(/^1001\d{8}$/);
    const act = await request(app).post(`/accounts/${a.body.id}/activate`).set(as(maker)).send({ reason: 'kyc done' });
    expect(act.body.status).toBe('ACTIVE');
    const again = await request(app).post(`/accounts/${a.body.id}/activate`).set(as(maker)).send({});
    expect(again.status).toBe(409);
    expect(outbox('AccountStatusChanged').at(-1)?.payload).toMatchObject({ from: 'PENDING', to: 'ACTIVE' });
  });

  it('scopes staff to their own bank', async () => {
    const r = await request(app).post('/customers').set(as(alphaOps)).send({ bankCode: 'KOSH', fullName: 'X Y', phone: '9999999999' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BANK_SCOPE');
    const { account } = await customerWithAccount();
    expect((await request(app).get(`/accounts/${account.id}`).set(as(alphaOps))).status).toBe(403);
    expect((await request(app).get(`/accounts/${account.id}`).set(as(admin))).status).toBe(200);
  });

  it('rejects duplicate customers and customer callers on staff APIs', async () => {
    await customerWithAccount();
    const dup = await request(app).post('/customers').set(as(maker)).send({ bankCode: 'KOSH', fullName: 'Asha', phone: '9999999999' });
    expect(dup.status).toBe(409);
    const cust = await request(app).post('/customers').set(as(customerPrincipal('usr_asha'))).send({ bankCode: 'KOSH', fullName: 'Asha', phone: '6666666666' });
    expect(cust.body.error.code).toBe('STAFF_ONLY');
  });

  it('keeps internal GL accounts out of lifecycle changes', async () => {
    const gl = await request(app).get('/internal/banks/KOSH/gl/CASH').set(SVC);
    const r = await request(app).post('/approvals').set(as(maker)).send({ accountId: gl.body.id, kind: 'FREEZE', reason: 'try it' });
    expect(r.body.error.code).toBe('INTERNAL_ACCOUNT');
  });
});

describe('maker-checker', () => {
  it('requires a different checker to freeze and unfreeze', async () => {
    const { account } = await customerWithAccount();
    const req = await request(app).post('/approvals').set(as(maker)).send({ accountId: account.id, kind: 'FREEZE', reason: 'suspicious activity' });
    const self = await request(app).post(`/approvals/${req.body.id}/approve`).set(as(maker)).send({});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CANNOT_APPROVE');
    const dup = await request(app).post('/approvals').set(as(maker)).send({ accountId: account.id, kind: 'FREEZE', reason: 'again please' });
    expect(dup.body.error.code).toBe('APPROVAL_PENDING');
    const ok = await request(app).post(`/approvals/${req.body.id}/approve`).set(as(checker)).send({ note: 'verified' });
    expect(ok.status).toBe(200);
    expect(ok.body.account.status).toBe('FROZEN');
    expect(ok.body.ledgerSynced).toBe(true);
    expect(refreshed.filter((id) => id === account.id).length).toBeGreaterThanOrEqual(2);
    expect(ok.body.approval).toMatchObject({ status: 'APPROVED', makerId: 'stf_maker', checkerId: 'stf_checker' });
    expect((await request(app).post(`/approvals/${req.body.id}/approve`).set(as(checker)).send({})).body.error.code).toBe('APPROVAL_NOT_PENDING');
    const freezeAgain = await request(app).post('/approvals').set(as(maker)).send({ accountId: account.id, kind: 'FREEZE', reason: 'double freeze' });
    expect(freezeAgain.body.error.code).toBe('INVALID_TRANSITION');
    const unfreeze = await approvalFlow(account.id, 'UNFREEZE');
    expect(unfreeze.body.account.status).toBe('ACTIVE');
    const history = await request(app).get(`/accounts/${account.id}`).set(as(maker));
    expect(history.body.history.map((h: { to: string }) => h.to)).toEqual(['ACTIVE', 'FROZEN', 'ACTIVE']);
  });

  it('supports reject and maker-only cancel', async () => {
    const { account } = await customerWithAccount();
    const a = await request(app).post('/approvals').set(as(maker)).send({ accountId: account.id, kind: 'FREEZE', reason: 'check this' });
    expect((await request(app).post(`/approvals/${a.body.id}/reject`).set(as(checker)).send({ note: 'not needed' })).body.status).toBe('REJECTED');
    const b = await request(app).post('/approvals').set(as(maker)).send({ accountId: account.id, kind: 'FREEZE', reason: 'check again' });
    expect((await request(app).post(`/approvals/${b.body.id}/cancel`).set(as(checker)).send({})).status).toBe(403);
    expect((await request(app).post(`/approvals/${b.body.id}/cancel`).set(as(maker)).send({})).body.status).toBe('CANCELLED');
    const pending = await request(app).get('/approvals?status=PENDING').set(as(maker));
    expect(pending.body.approvals).toHaveLength(0);
  });

  it('validates limit changes against tier caps and account type', async () => {
    const { account } = await customerWithAccount('9999999999', 'SAVINGS', 'MIN');
    const tooHigh = await request(app)
      .post('/approvals')
      .set(as(maker))
      .send({ accountId: account.id, kind: 'LIMIT_CHANGE', reason: 'raise', payload: { dailyDebitLimit: 5_000_000 } });
    expect(tooHigh.body.error.code).toBe('LIMIT_ABOVE_TIER');
    const od = await request(app).post('/approvals').set(as(maker)).send({ accountId: account.id, kind: 'LIMIT_CHANGE', reason: 'overdraft', payload: { overdraftLimit: 100 } });
    expect(od.body.error.code).toBe('OVERDRAFT_NOT_ALLOWED');
    const inconsistent = await request(app)
      .post('/approvals')
      .set(as(maker))
      .send({ accountId: account.id, kind: 'LIMIT_CHANGE', reason: 'odd', payload: { perTxnLimit: 1_500_000, dailyDebitLimit: 1_000_000 } });
    expect(inconsistent.body.error.code).toBe('LIMIT_INCONSISTENT');
    const ok = await approvalFlow(account.id, 'LIMIT_CHANGE', { perTxnLimit: 500_000 });
    expect(ok.body.account.perTxnLimit).toBe(500_000);
    expect(outbox('LimitChanged').at(-1)?.payload).toMatchObject({ accountId: account.id, perTxnLimit: 500_000, dailyDebitLimit: 2_000_000 });
  });

  it('allows overdraft on current accounts', async () => {
    const { account } = await customerWithAccount('7777777777', 'CURRENT');
    const ok = await approvalFlow(account.id, 'LIMIT_CHANGE', { overdraftLimit: 5_000_000 });
    expect(ok.body.account.overdraftLimit).toBe(5_000_000);
  });

  it('only closes accounts with zero balance and no holds', async () => {
    const { account } = await customerWithAccount();
    balances[account.id] = { ledgerBalance: 100, heldAmount: 0 };
    const blocked = await approvalFlow(account.id, 'CLOSE');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('BALANCE_NOT_ZERO');
    balances[account.id] = { ledgerBalance: 0, heldAmount: 0 };
    const pending = await request(app).get('/approvals?status=PENDING').set(as(checker));
    const closed = await request(app).post(`/approvals/${pending.body.approvals[0].id}/approve`).set(as(checker)).send({});
    expect(closed.body.account.status).toBe('CLOSED');
    const reopen = await request(app).post(`/accounts/${account.id}/reactivate`).set(as(maker)).send({});
    expect(reopen.status).toBe(409);
  });
});

describe('customer discovery', () => {
  it('links the bank customer to the user by phone and masks numbers', async () => {
    const { account } = await customerWithAccount('9999999999');
    const asha = as(customerPrincipal('usr_asha'));
    const found = await request(app).get('/discover?bankCode=KOSH').set(asha);
    expect(found.body.accounts).toHaveLength(1);
    expect(found.body.accounts[0].accountNumber).toMatch(/^X{8}\d{4}$/);
    const internal = await request(app).get(`/internal/accounts/${account.id}`).set(SVC);
    expect(internal.body).toMatchObject({ userId: 'usr_asha', holderName: 'Asha Verma', status: 'ACTIVE' });
    expect((await request(app).get('/me/accounts').set(asha)).body.accounts).toHaveLength(1);
    expect((await request(app).get(`/accounts/${account.id}`).set(asha)).status).toBe(200);
  });

  it('does not reveal other customers accounts', async () => {
    const { account } = await customerWithAccount('9999999999');
    const ravi = as(customerPrincipal('usr_ravi'));
    expect((await request(app).get('/discover?bankCode=KOSH').set(ravi)).body.accounts).toEqual([]);
    expect((await request(app).get(`/accounts/${account.id}`).set(ravi)).status).toBe(404);
    expect((await request(app).get('/discover?bankCode=NOPE').set(ravi)).status).toBe(404);
  });
});
