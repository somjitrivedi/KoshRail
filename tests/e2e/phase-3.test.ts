import { describe, expect, it } from 'vitest';
import { adminToken, bankOps, call, gw, idemKey, makerChecker, openAccount, poll, registerCustomer, topicEvents } from './helpers.ts';

async function fundedAccount(bank: string, amount: number) {
  const ops = await bankOps(bank);
  const s = await registerCustomer();
  const acct = await openAccount(ops, { name: s.name, phone: s.phone });
  if (amount > 0) {
    const dep = await call('POST', gw(`/api/ledger/banks/${bank}/deposits`), {
      token: ops.maker.token,
      idempotencyKey: idemKey(),
      body: { accountId: acct.accountId, amount, reference: 'branch deposit' },
    });
    if (dep.status !== 201) throw new Error(`deposit failed ${dep.status} ${JSON.stringify(dep.body)}`);
  }
  return { ops, session: s, ...acct };
}

describe('phase 3 - ledger', () => {
  it('branch staff deposit cash and the ledger syncs the account on first use', async () => {
    const { ops, accountId } = await fundedAccount('KOSH', 250_000);
    const bal = await call('GET', gw(`/api/ledger/banks/KOSH/accounts/${accountId}/balance`), { token: ops.maker.token });
    expect(bal.body).toMatchObject({ ledgerBalance: 250_000, heldAmount: 0, availableBalance: 250_000, status: 'ACTIVE' });
    const ev = await poll(
      async () => (await topicEvents('ledger.events')).find((e) => e.type === 'EntryPosted' && e.payload.postings.some((p: { accountId: string }) => p.accountId === accountId)),
      'EntryPosted',
    );
    expect(ev.source).toBe('ledger-service.KOSH');
  });

  it('posts a balanced transfer with an idempotent replay and a matching statement', async () => {
    const admin = await adminToken();
    const a = await fundedAccount('ALPHA', 100_000);
    const b = await fundedAccount('ALPHA', 0);
    const key = idemKey();
    const body = { kind: 'TRANSFER', reference: 'e2e-transfer', postings: [{ accountId: a.accountId, amount: -40_000 }, { accountId: b.accountId, amount: 40_000 }] };
    const first = await call('POST', gw('/api/ledger/banks/ALPHA/entries'), { token: admin, idempotencyKey: key, body });
    expect(first.status).toBe(201);
    const replay = await call('POST', gw('/api/ledger/banks/ALPHA/entries'), { token: admin, idempotencyKey: key, body });
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const unbalanced = await call('POST', gw('/api/ledger/banks/ALPHA/entries'), {
      token: admin,
      idempotencyKey: idemKey(),
      body: { ...body, postings: [{ accountId: a.accountId, amount: -1 }, { accountId: b.accountId, amount: 2 }] },
    });
    expect(unbalanced.body.error.code).toBe('ENTRY_UNBALANCED');
    const st = await call('GET', gw(`/api/ledger/banks/ALPHA/accounts/${a.accountId}/statement`), { token: a.ops.maker.token });
    expect(st.body.lines.map((l: { amount: number }) => l.amount)).toEqual([100_000, -40_000]);
    expect(st.body.closingBalance).toBe(60_000);
  });

  it('blocks double spending: exactly five of twenty concurrent holds succeed', async () => {
    const admin = await adminToken();
    const { accountId } = await fundedAccount('BETA', 50_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('POST', gw('/api/ledger/banks/BETA/holds'), { token: admin, idempotencyKey: idemKey(), body: { accountId, amount: 10_000, reference: `race-${i}`, ttlSeconds: 60 } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_FUNDS')).toHaveLength(15);
  });

  it('rejects debits once the account freeze reaches the ledger', async () => {
    const admin = await adminToken();
    const a = await fundedAccount('KOSH', 30_000);
    const b = await fundedAccount('KOSH', 0);
    const frozen = await makerChecker(a.ops, a.accountId, 'FREEZE');
    expect(frozen.body.account.status).toBe('FROZEN');
    const body = { kind: 'TRANSFER', reference: 'frozen-try', postings: [{ accountId: a.accountId, amount: -1_000 }, { accountId: b.accountId, amount: 1_000 }] };
    const rejected = await poll(async () => {
      const r = await call('POST', gw('/api/ledger/banks/KOSH/entries'), { token: admin, idempotencyKey: idemKey(), body });
      return r.status === 422 && r.body.error.code === 'ACCOUNT_NOT_ACTIVE' ? r : null;
    }, 'freeze projection');
    expect(rejected.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    const credit = await call('POST', gw('/api/ledger/banks/KOSH/deposits'), {
      token: a.ops.maker.token,
      idempotencyKey: idemKey(),
      body: { accountId: a.accountId, amount: 2_000, reference: 'credit while frozen' },
    });
    expect(credit.status).toBe(201);
    const bal = await call('GET', gw(`/api/ledger/banks/KOSH/accounts/${a.accountId}/balance`), { token: a.ops.maker.token });
    expect(bal.body).toMatchObject({ status: 'FROZEN', ledgerBalance: 32_000 });
  });

  it('refuses to close an account that still holds money', async () => {
    const a = await fundedAccount('KOSH', 5_000);
    const r = await makerChecker(a.ops, a.accountId, 'CLOSE');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BALANCE_NOT_ZERO');
    const b = await fundedAccount('KOSH', 0);
    const ok = await makerChecker(b.ops, b.accountId, 'CLOSE');
    expect(ok.body.account.status).toBe('CLOSED');
  });

  it('keeps the ledger out of reach of customers and reports clean invariants', async () => {
    const s = await registerCustomer();
    expect((await call('GET', gw('/api/ledger/admin/invariants'), { token: s.accessToken })).status).toBe(403);
    const admin = await adminToken();
    const inv = await call('GET', gw('/api/ledger/admin/invariants'), { token: admin });
    expect(inv.status).toBe(200);
    expect(inv.body.banks.map((b: { bankCode: string }) => b.bankCode).sort()).toEqual(['ALPHA', 'BETA', 'KOSH']);
    const failing = inv.body.banks.flatMap((b: { checks: { name: string; ok: boolean }[] }) => b.checks.filter((c) => !c.ok));
    expect(failing).toEqual([]);
    expect(inv.body.ok).toBe(true);
  });
});
