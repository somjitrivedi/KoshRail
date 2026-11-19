import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { InternalAccount, Principal } from '@kosh/contracts';
import { encodePrincipal, notFound, openDb, type Db } from '@kosh/service-kit';
import { customerPrincipal, FakeClock, staffPrincipal, TEST_TOKEN, testLogger } from '@kosh/test-kit';
import { buildLedgerApp } from '../src/app.ts';
import { account, gl, MIGRATIONS } from './fixtures.ts';

const SVC = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'bank-adapter' };
const GW = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway' };

let app: Express;
let dbs: Map<string, Db>;
let directory: Map<string, InternalAccount>;
let lookups: number;

function as(p: Principal) {
  return { ...GW, 'x-kosh-principal': encodePrincipal(p) };
}

beforeEach(() => {
  dbs = new Map([
    ['KOSH', openDb(':memory:', MIGRATIONS)],
    ['ALPHA', openDb(':memory:', MIGRATIONS)],
  ]);
  directory = new Map();
  lookups = 0;
  for (const a of [gl('gl_cash', 'CASH'), gl('gl_switch', 'SWITCH_SETTLEMENT'), account('acc_a'), account('acc_b'), account('acc_rich', { perTxnLimit: 10_000_000 })]) directory.set(a.id, a);
  directory.set('acc_alpha', account('acc_alpha', { bankCode: 'ALPHA' }));
  app = buildLedgerApp({
    dbs,
    clock: new FakeClock(new Date()),
    log: testLogger(),
    internalToken: TEST_TOKEN,
    accounts: {
      getAccount: async (id) => {
        lookups++;
        const a = directory.get(id);
        if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'nope');
        return a;
      },
      getGlAccount: async (bankCode, glCode) => {
        lookups++;
        const a = [...directory.values()].find((x) => x.bankCode === bankCode && x.glCode === glCode);
        if (!a) throw notFound('GL_NOT_FOUND', 'nope');
        return a;
      },
    },
  }).app;
});

async function deposit(accountId: string, amount: number, key = `dep-${accountId}-${amount}-${Math.random()}`) {
  const r = await request(app).post('/banks/KOSH/deposits').set(SVC).set('idempotency-key', key).send({ accountId, amount, reference: 'seed deposit' });
  expect(r.status).toBe(201);
  return r;
}

describe('ledger http api', () => {
  it('syncs unknown accounts from the account service on first use', async () => {
    await deposit('acc_a', 1_000);
    expect(lookups).toBe(2);
    await deposit('acc_a', 1_000);
    expect(lookups).toBe(2);
    const unknown = await request(app).post('/banks/KOSH/deposits').set(SVC).set('idempotency-key', 'dep-unknown-1').send({ accountId: 'acc_zzz', amount: 1, reference: 'xyz' });
    expect(unknown.body.error.code).toBe('ACCOUNT_UNKNOWN');
    const wrongBank = await request(app).post('/banks/KOSH/deposits').set(SVC).set('idempotency-key', 'dep-wrong-1').send({ accountId: 'acc_alpha', amount: 1, reference: 'xyz' });
    expect(wrongBank.body.error.code).toBe('ACCOUNT_WRONG_BANK');
  });

  it('refreshes a stale non-active projection before rejecting', async () => {
    directory.set('acc_new', account('acc_new', { status: 'PENDING' }));
    const first = await request(app).post('/banks/KOSH/deposits').set(SVC).set('idempotency-key', 'dep-new-1').send({ accountId: 'acc_new', amount: 100, reference: 'opening' });
    expect(first.body.error.code).toBe('ACCOUNT_NOT_OPEN');
    directory.set('acc_new', account('acc_new', { status: 'ACTIVE' }));
    const second = await request(app).post('/banks/KOSH/deposits').set(SVC).set('idempotency-key', 'dep-new-2').send({ accountId: 'acc_new', amount: 100, reference: 'opening' });
    expect(second.status).toBe(201);
    directory.set('acc_new', account('acc_new', { status: 'FROZEN' }));
    const pushed = await request(app).post('/internal/banks/KOSH/accounts/acc_new/refresh').set(SVC).send({});
    expect(pushed.body.status).toBe('FROZEN');
  });

  it('requires an idempotency key and replays the same entry 100 times', async () => {
    await deposit('acc_a', 50_000);
    const body = { kind: 'TRANSFER', reference: 'tx-idem', postings: [{ accountId: 'acc_a', amount: -1_000 }, { accountId: 'acc_b', amount: 1_000 }] };
    expect((await request(app).post('/banks/KOSH/entries').set(SVC).send(body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const results = await Promise.all(Array.from({ length: 100 }, () => request(app).post('/banks/KOSH/entries').set(SVC).set('idempotency-key', 'transfer-key-1').send(body)));
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(99);
    const bal = await request(app).get('/banks/KOSH/accounts/acc_b/balance').set(SVC);
    expect(bal.body.ledgerBalance).toBe(1_000);
    const reused = await request(app).post('/banks/KOSH/entries').set(SVC).set('idempotency-key', 'transfer-key-1').send({ ...body, reference: 'different' });
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('allows exactly ten of fifty concurrent holds when funds cover ten', async () => {
    await deposit('acc_rich', 10_000);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request(app).post('/banks/KOSH/holds').set(SVC).set('idempotency-key', `hold-race-${i}`).send({ accountId: 'acc_rich', amount: 1_000, reference: `race-${i}`, ttlSeconds: 300 }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 422);
    expect(ok).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    expect(new Set(rejected.map((r) => r.body.error.code))).toEqual(new Set(['INSUFFICIENT_FUNDS']));
    const bal = await request(app).get('/banks/KOSH/accounts/acc_rich/balance').set(SVC);
    expect(bal.body).toMatchObject({ ledgerBalance: 10_000, heldAmount: 10_000, availableBalance: 0 });
    const inv = await request(app).get('/admin/invariants').set(SVC);
    expect(inv.body.ok).toBe(true);
  });

  it('runs a hold through capture over http', async () => {
    await deposit('acc_a', 5_000);
    const h = await request(app).post('/banks/KOSH/holds').set(SVC).set('idempotency-key', 'hold-cap-1').send({ accountId: 'acc_a', amount: 2_000, reference: 'txn-77' });
    const cap = await request(app).post(`/banks/KOSH/holds/${h.body.id}/capture`).set(SVC).send({ counterAccountId: 'gl_switch' });
    expect(cap.status).toBe(200);
    expect(cap.body.hold.status).toBe('CAPTURED');
    const entries = await request(app).get('/banks/KOSH/entries?reference=txn-77').set(SVC);
    expect(entries.body.entries.map((e: { kind: string }) => e.kind)).toEqual(['HOLD_CAPTURE']);
    const rev = await request(app).post(`/banks/KOSH/entries/${cap.body.entry.id}/reverse`).set(SVC).set('idempotency-key', 'rev-cap-1').send({ reason: 'switch reversal' });
    expect(rev.status).toBe(201);
    const statement = await request(app).get('/banks/KOSH/accounts/acc_a/statement').set(SVC);
    expect(statement.body.closingBalance).toBe(5_000);
    expect(statement.body.lines).toHaveLength(3);
  });

  it('keeps each bank in its own database', async () => {
    const r = await request(app).post('/banks/ALPHA/deposits').set(SVC).set('idempotency-key', 'alpha-dep-1').send({ accountId: 'acc_alpha', amount: 100, reference: 'alpha dep' });
    expect(r.body.error.code).toBe('GL_UNKNOWN');
    directory.set('gl_alpha_cash', { ...gl('gl_alpha_cash', 'CASH'), bankCode: 'ALPHA' });
    const ok = await request(app).post('/banks/ALPHA/deposits').set(SVC).set('idempotency-key', 'alpha-dep-2').send({ accountId: 'acc_alpha', amount: 100, reference: 'alpha dep' });
    expect(ok.status).toBe(201);
    expect(dbs.get('ALPHA')!.prepare('SELECT COUNT(*) FROM postings').pluck().get()).toBe(2);
    expect(dbs.get('KOSH')!.prepare('SELECT COUNT(*) FROM postings').pluck().get()).toBe(0);
    expect(dbs.get('KOSH')!.prepare('SELECT COUNT(*) FROM ledger_accounts WHERE bank_code = ?').pluck().get('ALPHA')).toBe(0);
    expect((await request(app).get('/banks/NOPE/accounts/x/balance').set(SVC)).status).toBe(404);
  });

  it('enforces caller roles and bank scope', async () => {
    await deposit('acc_a', 5_000);
    const body = { kind: 'ADJUSTMENT', reference: 'adj-1', postings: [{ accountId: 'acc_a', amount: -1 }, { accountId: 'acc_b', amount: 1 }] };
    const kosh = staffPrincipal('stf_k', ['BANK_OPS'], 'KOSH');
    const alpha = staffPrincipal('stf_a', ['BANK_OPS'], 'ALPHA');
    const admin = staffPrincipal('stf_admin', ['ADMIN']);
    expect((await request(app).post('/banks/KOSH/entries').set(as(kosh)).set('idempotency-key', 'adj-key-01').send(body)).status).toBe(403);
    expect((await request(app).post('/banks/KOSH/entries').set(as(admin)).set('idempotency-key', 'adj-key-02').send(body)).status).toBe(201);
    expect((await request(app).get('/banks/KOSH/accounts/acc_a/balance').set(as(kosh))).status).toBe(200);
    expect((await request(app).get('/banks/KOSH/accounts/acc_a/balance').set(as(alpha))).body.error.code).toBe('BANK_SCOPE');
    expect((await request(app).get('/banks/KOSH/accounts/acc_a/balance').set(as(customerPrincipal('usr_1')))).body.error.code).toBe('STAFF_ONLY');
    const dep = await request(app).post('/banks/KOSH/deposits').set(as(kosh)).set('idempotency-key', 'ops-dep-1').send({ accountId: 'acc_b', amount: 700, reference: 'branch cash' });
    expect(dep.status).toBe(201);
    expect(dep.body.createdBy).toBe('staff:stf_k');
    expect((await request(app).post('/banks/KOSH/deposits').set(as(alpha)).set('idempotency-key', 'ops-dep-2').send({ accountId: 'acc_b', amount: 1, reference: 'xyz' })).status).toBe(403);
    expect((await request(app).get('/admin/invariants').set(as(kosh))).status).toBe(403);
  });

  it('stores business rejections under the idempotency key', async () => {
    await deposit('acc_a', 100);
    const send = () =>
      request(app).post('/banks/KOSH/holds').set(SVC).set('idempotency-key', 'hold-nsf-1').send({ accountId: 'acc_a', amount: 500, reference: 'nsf' });
    const first = await send();
    expect(first.status).toBe(422);
    await deposit('acc_a', 1_000);
    const second = await send();
    expect(second.status).toBe(422);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });
});
