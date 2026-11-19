import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InternalAccount } from '@kosh/contracts';
import { encodePrincipal, migrationsDir, notFound, openDb } from '@kosh/service-kit';
import { customerPrincipal, FakeClock, serve, staffPrincipal, TEST_TOKEN, testLogger } from '@kosh/test-kit';
import { buildLedgerApp } from '../../ledger-service/src/app.ts';
import { buildAdapter, httpLedgerApi } from '../src/app.ts';

const log = testLogger();
const LEDGER_MIGRATIONS = migrationsDir(new URL('../../ledger-service/src/main.ts', import.meta.url).href);
const ADAPTER_MIGRATIONS = migrationsDir(new URL('../src/main.ts', import.meta.url).href);
const SVC = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'switch-service', 'content-type': 'application/json' };

function acct(id: string, bankCode: string, extra: Partial<InternalAccount> = {}): InternalAccount {
  return {
    id,
    bankCode,
    accountNumber: '111111111111',
    ifsc: 'X',
    type: 'SAVINGS',
    glCode: null,
    status: 'ACTIVE',
    overdraftLimit: 0,
    perTxnLimit: 100_000_000,
    dailyDebitLimit: 1_000_000_000,
    customerId: `c_${id}`,
    userId: null,
    holderName: id,
    ...extra,
  };
}

const directory = new Map<string, InternalAccount>();
for (const bank of ['KOSH', 'ALPHA']) {
  directory.set(`gl_cash_${bank}`, acct(`gl_cash_${bank}`, bank, { type: 'INTERNAL', glCode: 'CASH', customerId: null }));
  directory.set(`gl_sw_${bank}`, acct(`gl_sw_${bank}`, bank, { type: 'INTERNAL', glCode: 'SWITCH_SETTLEMENT', customerId: null }));
}
directory.set('payer', acct('payer', 'KOSH'));
directory.set('payee', acct('payee', 'ALPHA'));

let ledger: Awaited<ReturnType<typeof serve>>;
let adapter: Awaited<ReturnType<typeof serve>>;
let seq = 0;

async function post(path: string, body: unknown, headers: Record<string, string> = SVC, timeoutMs = 5000) {
  const r = await fetch(`${adapter.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: (await r.json()) as any, replayed: r.headers.get('idempotent-replayed') === 'true' };
}

async function get(path: string) {
  const r = await fetch(`${adapter.url}${path}`, { headers: SVC });
  return (await r.json()) as any;
}

async function put(path: string, body: unknown) {
  return fetch(`${adapter.url}${path}`, { method: 'PUT', headers: SVC, body: JSON.stringify(body) });
}

async function ledgerGet(path: string) {
  const r = await fetch(`${ledger.url}${path}`, { headers: SVC });
  return (await r.json()) as any;
}

async function fund(accountId: string, bank: string, amount: number) {
  const r = await fetch(`${ledger.url}/banks/${bank}/deposits`, {
    method: 'POST',
    headers: { ...SVC, 'idempotency-key': `fund-${accountId}-${seq++}` },
    body: JSON.stringify({ accountId, amount, reference: 'test fund' }),
  });
  expect(r.status).toBe(201);
}

function txnId() {
  return `txn_test_${Date.now()}_${seq++}`;
}

beforeAll(async () => {
  const dbs = new Map([
    ['KOSH', openDb(':memory:', LEDGER_MIGRATIONS)],
    ['ALPHA', openDb(':memory:', LEDGER_MIGRATIONS)],
  ]);
  ledger = await serve(
    buildLedgerApp({
      dbs,
      clock: new FakeClock(new Date()),
      log,
      internalToken: TEST_TOKEN,
      accounts: {
        getAccount: async (id) => {
          const a = directory.get(id);
          if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'x');
          return a;
        },
        getGlAccount: async (bank, gl) => [...directory.values()].find((a) => a.bankCode === bank && a.glCode === gl)!,
      },
    }).app,
  );
  adapter = await serve(
    buildAdapter({
      db: openDb(':memory:', ADAPTER_MIGRATIONS),
      clock: new FakeClock(new Date()),
      log,
      internalToken: TEST_TOKEN,
      banks: ['KOSH', 'ALPHA'],
      ledger: httpLedgerApi(ledger.url, TEST_TOKEN),
      gl: { switchSettlement: async (bank) => `gl_sw_${bank}` },
      faultHangMs: 1500,
    }).app,
  );
  await fund('payer', 'KOSH', 1_000_000);
});

afterAll(async () => {
  await adapter.close();
  await ledger.close();
});

beforeEach(async () => {
  await fetch(`${adapter.url}/banks/KOSH/faults`, { method: 'DELETE', headers: SVC });
  await fetch(`${adapter.url}/banks/ALPHA/faults`, { method: 'DELETE', headers: SVC });
});

describe('bank adapter happy path', () => {
  it('runs hold, credit and capture across two banks', async () => {
    const id = txnId();
    const hold = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 50_000 });
    expect(hold.status).toBe(200);
    expect(hold.body).toMatchObject({ status: 'HELD', bankCode: 'KOSH', step: 'hold', amount: 50_000 });
    const credit = await post('/banks/ALPHA/credit', { txnId: id, accountId: 'payee', amount: 50_000 });
    expect(credit.body.status).toBe('CREDITED');
    const cap = await post('/banks/KOSH/capture', { txnId: id, holdId: hold.body.holdId });
    expect(cap.body.status).toBe('CAPTURED');
    expect((await ledgerGet('/banks/ALPHA/accounts/payee/balance')).ledgerBalance).toBe(50_000);
    expect((await ledgerGet('/banks/KOSH/accounts/gl_sw_KOSH/balance')).ledgerBalance).toBe(50_000);
    expect((await ledgerGet('/banks/ALPHA/accounts/gl_sw_ALPHA/balance')).ledgerBalance).toBe(-50_000);
    const status = await get(`/banks/KOSH/status/${id}`);
    expect(status.steps.map((s: { step: string; status: string }) => `${s.step}:${s.status}`)).toEqual(['capture:DONE', 'hold:DONE']);
    expect(status.ledger.holds[0].status).toBe('CAPTURED');
    expect((await ledgerGet('/admin/invariants')).ok).toBe(true);
  });

  it('replays a completed step without touching the ledger again', async () => {
    const id = txnId();
    const first = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 1_000 });
    const replays = await Promise.all(Array.from({ length: 10 }, () => post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 1_000 })));
    expect(replays.every((r) => r.body.holdId === first.body.holdId)).toBe(true);
    expect(replays.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(9);
    const holds = await ledgerGet(`/banks/KOSH/holds?reference=${id}`);
    expect(holds.holds).toHaveLength(1);
    const mismatch = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 2_000 });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('ADAPTER_REQUEST_MISMATCH');
  });

  it('stores business failures and replays them', async () => {
    const id = txnId();
    const r = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 999_999_999 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_FUNDS');
    const again = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 999_999_999 });
    expect(again.status).toBe(422);
    expect(again.replayed).toBe(true);
    expect((await get(`/banks/KOSH/status/${id}`)).steps[0].status).toBe('FAILED');
  });

  it('releases holds and refuses to touch another transaction hold', async () => {
    const a = txnId();
    const b = txnId();
    const hold = await post('/banks/KOSH/hold', { txnId: a, accountId: 'payer', amount: 2_000 });
    const wrong = await post('/banks/KOSH/capture', { txnId: b, holdId: hold.body.holdId });
    expect(wrong.body.error.code).toBe('HOLD_TXN_MISMATCH');
    const rel = await post('/banks/KOSH/release', { txnId: a, holdId: hold.body.holdId });
    expect(rel.body).toMatchObject({ status: 'RELEASED', holdStatus: 'RELEASED' });
  });

  it('reverses a credit', async () => {
    const id = txnId();
    const credit = await post('/banks/ALPHA/credit', { txnId: id, accountId: 'payee', amount: 3_000 });
    const before = (await ledgerGet('/banks/ALPHA/accounts/payee/balance')).ledgerBalance;
    const rev = await post('/banks/ALPHA/reverse', { txnId: id, entryId: credit.body.entryId, reason: 'payer debit failed' });
    expect(rev.body.status).toBe('REVERSED');
    expect((await ledgerGet('/banks/ALPHA/accounts/payee/balance')).ledgerBalance).toBe(before - 3_000);
  });

  it('rejects customers and unknown banks', async () => {
    const asCustomer = { ...SVC, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(customerPrincipal('usr_1')) };
    expect((await post('/banks/KOSH/hold', { txnId: txnId(), accountId: 'payer', amount: 1 }, asCustomer)).body.error.code).toBe('STAFF_ONLY');
    const asOps = { ...SVC, 'x-kosh-caller': 'gateway', 'x-kosh-principal': encodePrincipal(staffPrincipal('s', ['SWITCH_OPS'])) };
    expect((await post('/banks/KOSH/hold', { txnId: txnId(), accountId: 'payer', amount: 1 }, asOps)).status).toBe(200);
    expect((await post('/banks/NOPE/hold', { txnId: txnId(), accountId: 'payer', amount: 1 })).status).toBe(404);
  });
});

describe('fault injection', () => {
  it('ERROR fails before committing and clears after the remaining count', async () => {
    await put('/banks/KOSH/faults/hold', { mode: 'ERROR', errorRate: 100, remaining: 1 });
    const id = txnId();
    const fail = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 1_000 });
    expect(fail.status).toBe(503);
    expect((await get(`/banks/KOSH/status/${id}`)).steps).toEqual([]);
    const ok = await post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 1_000 });
    expect(ok.status).toBe(200);
  });

  it('LATENCY delays the response', async () => {
    await put('/banks/ALPHA/faults/credit', { mode: 'LATENCY', latencyMs: 300 });
    const started = Date.now();
    await post('/banks/ALPHA/credit', { txnId: txnId(), accountId: 'payee', amount: 10 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('TIMEOUT_AFTER_COMMIT times the caller out while the status shows the truth', async () => {
    await put('/banks/ALPHA/faults/credit', { mode: 'TIMEOUT_AFTER_COMMIT', remaining: 1 });
    const id = txnId();
    await expect(post('/banks/ALPHA/credit', { txnId: id, accountId: 'payee', amount: 700 }, SVC, 400)).rejects.toThrow();
    const status = await get(`/banks/ALPHA/status/${id}`);
    expect(status.steps[0]).toMatchObject({ step: 'credit', status: 'DONE' });
    expect(status.ledger.entries).toHaveLength(1);
    const retry = await post('/banks/ALPHA/credit', { txnId: id, accountId: 'payee', amount: 700 });
    expect(retry.replayed).toBe(true);
    expect(retry.body.entryId).toBe(status.ledger.entries[0].id);
  });

  it('DROP_RESPONSE kills the socket after committing', async () => {
    await put('/banks/KOSH/faults/hold', { mode: 'DROP_RESPONSE', remaining: 1 });
    const id = txnId();
    await expect(post('/banks/KOSH/hold', { txnId: id, accountId: 'payer', amount: 900 })).rejects.toThrow();
    const status = await get(`/banks/KOSH/status/${id}`);
    expect(status.steps[0]).toMatchObject({ step: 'hold', status: 'DONE' });
    expect(status.ledger.holds).toHaveLength(1);
    const faults = await get('/banks/KOSH/faults');
    expect(faults.faults[0]).toMatchObject({ op: 'hold', mode: 'DROP_RESPONSE', remaining: 0 });
  });
});

describe('core banking outage', () => {
  it('returns 502 BANK_UNAVAILABLE when core banking is unreachable', async () => {
    const deadAdapter = await serve(
      buildAdapter({
        db: openDb(':memory:', ADAPTER_MIGRATIONS),
        clock: new FakeClock(new Date()),
        log,
        internalToken: TEST_TOKEN,
        banks: ['KOSH'],
        ledger: httpLedgerApi('http://127.0.0.1:1', TEST_TOKEN),
        gl: { switchSettlement: async () => 'gl_sw_KOSH' },
      }).app,
    );
    const id = txnId();
    const r = await fetch(`${deadAdapter.url}/banks/KOSH/hold`, { method: 'POST', headers: SVC, body: JSON.stringify({ txnId: id, accountId: 'payer', amount: 5 }) });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.code).toBe('BANK_UNAVAILABLE');
    await deadAdapter.close();
  });
});
