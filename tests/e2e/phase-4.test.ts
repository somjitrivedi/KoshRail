import { describe, expect, it } from 'vitest';
import { adminToken, bankOps, call, gw, idemKey, internalHeaders, makerChecker, openAccount, poll, registerCustomer, uniqueSuffix, url, type Session } from './helpers.ts';

async function customerWithVpa(bank: string, psp = 'kosh', name?: string) {
  const ops = await bankOps(bank);
  const s = await registerCustomer(name);
  const acct = await openAccount(ops, { name: s.name, phone: s.phone });
  const discovered = await call('GET', gw(`/api/accounts/discover?bankCode=${bank}`), { token: s.accessToken });
  expect(discovered.body.accounts.map((a: { id: string }) => a.id)).toContain(acct.accountId);
  const handle = `u${uniqueSuffix()}`.slice(0, 24);
  const vpa = await call('POST', gw('/api/vpa/vpas'), { token: s.accessToken, body: { handle, pspHandle: psp } });
  expect(vpa.status).toBe(201);
  const link = await call('POST', gw(`/api/vpa/vpas/${vpa.body.address}/links`), { token: s.accessToken, body: { accountId: acct.accountId } });
  expect(link.status).toBe(201);
  return { ops, session: s, address: vpa.body.address as string, ...acct };
}

async function deposit(bank: string, accountId: string, amount: number) {
  const ops = await bankOps(bank);
  const r = await call('POST', gw(`/api/ledger/banks/${bank}/deposits`), { token: ops.maker.token, idempotencyKey: idemKey(), body: { accountId, amount, reference: 'e2e funding' } });
  expect(r.status).toBe(201);
}

function adapterCall(path: string, body: unknown, timeoutMs = 5000) {
  return fetch(url('KOSH_ADAPTER_URL', path), {
    method: 'POST',
    headers: { ...internalHeaders('switch-service'), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function adapterStatus(bank: string, txnId: string) {
  const r = await fetch(url('KOSH_ADAPTER_URL', `/banks/${bank}/status/${txnId}`), { headers: internalHeaders('switch-service') });
  return (await r.json()) as any;
}

function txnId() {
  return `txn_e2e_${uniqueSuffix()}`;
}

describe('phase 4 - VPA resolver', () => {
  it('links an account to a VPA and resolves it for another customer with a masked name', async () => {
    const payee = await customerWithVpa('ALPHA', 'kosh', 'Sunita Devi Rao');
    const payer: Session = await registerCustomer();
    const r = await call('GET', gw(`/api/vpa/resolve/${payee.address}`), { token: payer.accessToken });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ address: payee.address, maskedName: 'Sunita D R', bankCode: 'ALPHA', status: 'ACTIVE' });
    const mine = await call('GET', gw('/api/vpa/vpas'), { token: payee.session.accessToken });
    expect(mine.body.vpas[0].links[0]).toMatchObject({ accountId: payee.accountId, isDefault: true });
  });

  it('refuses to link an account the customer has not discovered', async () => {
    const ops = await bankOps('BETA');
    const owner = await registerCustomer();
    const acct = await openAccount(ops, { name: owner.name, phone: owner.phone });
    const thief = await registerCustomer();
    const vpa = await call('POST', gw('/api/vpa/vpas'), { token: thief.accessToken, body: { handle: `t${uniqueSuffix()}`.slice(0, 20), pspHandle: 'beta' } });
    const link = await call('POST', gw(`/api/vpa/vpas/${vpa.body.address}/links`), { token: thief.accessToken, body: { accountId: acct.accountId } });
    expect(link.status).toBe(403);
    expect(link.body.error.code).toBe('ACCOUNT_NOT_OWNED');
  });

  it('resolves from cache with p99 under 20 ms', async () => {
    const payee = await customerWithVpa('KOSH');
    const target = url('KOSH_VPA_URL', `/resolve/${payee.address}`);
    const headers = internalHeaders('switch-service');
    for (let i = 0; i < 20; i++) await fetch(target, { headers });
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      const r = await fetch(target, { headers });
      await r.arrayBuffer();
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99) - 1]!;
    expect(p99).toBeLessThan(20);
    const stats = (await (await fetch(url('KOSH_VPA_URL', '/internal/cache-stats'), { headers })).json()) as { hits: number };
    expect(stats.hits).toBeGreaterThanOrEqual(200);
  });

  it('returns ACCOUNT_INACTIVE after the account is frozen and recovers after unfreeze', async () => {
    const payee = await customerWithVpa('BETA', 'beta');
    const viewer = await registerCustomer();
    await call('GET', gw(`/api/vpa/resolve/${payee.address}`), { token: viewer.accessToken });
    await makerChecker(payee.ops, payee.accountId, 'FREEZE');
    const blocked = await poll(async () => {
      const r = await call('GET', gw(`/api/vpa/resolve/${payee.address}`), { token: viewer.accessToken });
      return r.status === 422 ? r : null;
    }, 'freeze to reach vpa-service');
    expect(blocked.body.error.code).toBe('ACCOUNT_INACTIVE');
    await makerChecker(payee.ops, payee.accountId, 'UNFREEZE');
    await poll(async () => (await call('GET', gw(`/api/vpa/resolve/${payee.address}`), { token: viewer.accessToken })).status === 200, 'unfreeze to reach vpa-service');
  });
});

describe('phase 4 - bank adapter', () => {
  it('moves money between two banks with hold, credit and capture through the gateway', async () => {
    const admin = await adminToken();
    const payer = await customerWithVpa('KOSH');
    const payee = await customerWithVpa('ALPHA');
    await deposit('KOSH', payer.accountId, 100_000);
    const id = txnId();
    const hold = await call('POST', gw('/api/adapter/banks/KOSH/hold'), { token: admin, body: { txnId: id, accountId: payer.accountId, amount: 25_000 } });
    expect(hold.body.status).toBe('HELD');
    const replay = await call('POST', gw('/api/adapter/banks/KOSH/hold'), { token: admin, body: { txnId: id, accountId: payer.accountId, amount: 25_000 } });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.holdId).toBe(hold.body.holdId);
    const credit = await call('POST', gw('/api/adapter/banks/ALPHA/credit'), { token: admin, body: { txnId: id, accountId: payee.accountId, amount: 25_000 } });
    expect(credit.body.status).toBe('CREDITED');
    const cap = await call('POST', gw('/api/adapter/banks/KOSH/capture'), { token: admin, body: { txnId: id, holdId: hold.body.holdId } });
    expect(cap.body.status).toBe('CAPTURED');
    const payerBal = await call('GET', gw(`/api/ledger/banks/KOSH/accounts/${payer.accountId}/balance`), { token: admin });
    const payeeBal = await call('GET', gw(`/api/ledger/banks/ALPHA/accounts/${payee.accountId}/balance`), { token: admin });
    expect(payerBal.body).toMatchObject({ ledgerBalance: 75_000, heldAmount: 0 });
    expect(payeeBal.body.ledgerBalance).toBe(25_000);
    const holds = await call('GET', gw(`/api/ledger/banks/KOSH/holds?reference=${id}`), { token: admin });
    expect(holds.body.holds).toHaveLength(1);
    const inv = await call('GET', gw('/api/ledger/admin/invariants'), { token: admin });
    expect(inv.body.ok).toBe(true);
  });

  it('keeps customers away from the adapter', async () => {
    const s = await registerCustomer();
    const r = await call('POST', gw('/api/adapter/banks/KOSH/hold'), { token: s.accessToken, body: { txnId: txnId(), accountId: 'x', amount: 1 } });
    expect(r.status).toBe(403);
  });

  it('timeout-after-commit: the caller times out but status reports the committed credit', async () => {
    const admin = await adminToken();
    const payee = await customerWithVpa('BETA', 'beta');
    await call('PUT', gw('/api/adapter/banks/BETA/faults/credit'), { token: admin, body: { mode: 'TIMEOUT_AFTER_COMMIT', remaining: 1 } });
    const id = txnId();
    await expect(adapterCall('/banks/BETA/credit', { txnId: id, accountId: payee.accountId, amount: 4_200 }, 500)).rejects.toThrow();
    const status = await adapterStatus('BETA', id);
    expect(status.steps[0]).toMatchObject({ step: 'credit', status: 'DONE' });
    expect(status.ledger.entries).toHaveLength(1);
    expect(status.ledger.entries[0].postings).toContainEqual({ accountId: payee.accountId, amount: 4_200 });
    const retry = await adapterCall('/banks/BETA/credit', { txnId: id, accountId: payee.accountId, amount: 4_200 });
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    const bal = await call('GET', gw(`/api/ledger/banks/BETA/accounts/${payee.accountId}/balance`), { token: admin });
    expect(bal.body.ledgerBalance).toBe(4_200);
    await call('DELETE', gw('/api/adapter/banks/BETA/faults'), { token: admin });
  });

  it('drop-response: the socket dies after the hold commits and a retry gets the stored answer', async () => {
    const admin = await adminToken();
    const payer = await customerWithVpa('KOSH');
    await deposit('KOSH', payer.accountId, 10_000);
    await call('PUT', gw('/api/adapter/banks/KOSH/faults/hold'), { token: admin, body: { mode: 'DROP_RESPONSE', remaining: 1 } });
    const id = txnId();
    await expect(adapterCall('/banks/KOSH/hold', { txnId: id, accountId: payer.accountId, amount: 3_000 })).rejects.toThrow();
    const status = await adapterStatus('KOSH', id);
    expect(status.ledger.holds).toHaveLength(1);
    expect(status.ledger.holds[0]).toMatchObject({ status: 'ACTIVE', amount: 3_000 });
    const retry = await adapterCall('/banks/KOSH/hold', { txnId: id, accountId: payer.accountId, amount: 3_000 });
    const body = (await retry.json()) as { holdId: string };
    expect(body.holdId).toBe(status.ledger.holds[0].id);
    const rel = await adapterCall('/banks/KOSH/release', { txnId: id, holdId: body.holdId });
    expect(rel.status).toBe(200);
    const bal = await call('GET', gw(`/api/ledger/banks/KOSH/accounts/${payer.accountId}/balance`), { token: admin });
    expect(bal.body).toMatchObject({ ledgerBalance: 10_000, heldAmount: 0 });
    await call('DELETE', gw('/api/adapter/banks/KOSH/faults'), { token: admin });
  });
});
