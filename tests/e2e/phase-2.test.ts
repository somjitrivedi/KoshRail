import { describe, expect, it } from 'vitest';
import { bankOps, call, gw, openAccount, poll, registerCustomer, topicEvents } from './helpers.ts';

describe('phase 2 - accounts', () => {
  it('lists the seeded banks', async () => {
    const s = await registerCustomer();
    const r = await call('GET', gw('/api/accounts/banks'), { token: s.accessToken });
    expect(r.body.banks.map((b: { code: string; vpaHandle: string }) => `${b.code}:${b.vpaHandle}`)).toEqual(['ALPHA:alpha', 'BETA:beta', 'KOSH:kosh']);
  });

  it('staff open an account through the gateway and AccountOpened reaches the bus', async () => {
    const ops = await bankOps('KOSH');
    const s = await registerCustomer('Kabir Rao');
    const { accountId, accountNumber } = await openAccount(ops, { name: s.name, phone: s.phone });
    expect(accountNumber).toMatch(/^1001\d{8}$/);
    const ev = await poll(async () => (await topicEvents('account.events')).find((e) => e.type === 'AccountOpened' && e.key === accountId), 'AccountOpened');
    expect(ev.payload).toMatchObject({ bankCode: 'KOSH', status: 'PENDING', type: 'SAVINGS' });
    const activated = await poll(
      async () => (await topicEvents('account.events')).find((e) => e.type === 'AccountStatusChanged' && e.key === accountId),
      'activation event',
    );
    expect(activated.payload).toMatchObject({ from: 'PENDING', to: 'ACTIVE' });
  });

  it('freezing needs a second approver', async () => {
    const ops = await bankOps('KOSH');
    const s = await registerCustomer();
    const { accountId } = await openAccount(ops, { name: s.name, phone: s.phone });
    const req = await call('POST', gw('/api/accounts/approvals'), { token: ops.maker.token, body: { accountId, kind: 'FREEZE', reason: 'fraud report' } });
    expect(req.status).toBe(201);
    const self = await call('POST', gw(`/api/accounts/approvals/${req.body.id}/approve`), { token: ops.maker.token, body: {} });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CANNOT_APPROVE');
    const stillActive = await call('GET', gw(`/api/accounts/accounts/${accountId}`), { token: ops.checker.token });
    expect(stillActive.body.status).toBe('ACTIVE');
    const ok = await call('POST', gw(`/api/accounts/approvals/${req.body.id}/approve`), { token: ops.checker.token, body: { note: 'confirmed' } });
    expect(ok.status).toBe(200);
    expect(ok.body.account.status).toBe('FROZEN');
    await poll(
      async () => (await topicEvents('account.events')).find((e) => e.type === 'AccountStatusChanged' && e.key === accountId && e.payload.to === 'FROZEN'),
      'freeze event',
    );
  });

  it('keeps staff inside their bank', async () => {
    const kosh = await bankOps('KOSH');
    const alpha = await bankOps('ALPHA');
    const s = await registerCustomer();
    const { accountId } = await openAccount(kosh, { name: s.name, phone: s.phone });
    const r = await call('GET', gw(`/api/accounts/accounts/${accountId}`), { token: alpha.maker.token });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BANK_SCOPE');
  });

  it('customers discover their own accounts by phone with masked numbers', async () => {
    const kosh = await bankOps('KOSH');
    const beta = await bankOps('BETA');
    const s = await registerCustomer('Divya Nair');
    await openAccount(kosh, { name: s.name, phone: s.phone });
    await openAccount(beta, { name: s.name, phone: s.phone });
    const found = await call('GET', gw('/api/accounts/discover?bankCode=BETA'), { token: s.accessToken });
    expect(found.body.accounts).toHaveLength(1);
    expect(found.body.accounts[0].accountNumber).toMatch(/^X{8}\d{4}$/);
    await call('GET', gw('/api/accounts/discover?bankCode=KOSH'), { token: s.accessToken });
    const mine = await call('GET', gw('/api/accounts/me/accounts'), { token: s.accessToken });
    expect(mine.body.accounts.map((a: { bankCode: string }) => a.bankCode).sort()).toEqual(['BETA', 'KOSH']);
    const other = await registerCustomer();
    expect((await call('GET', gw(`/api/accounts/accounts/${found.body.accounts[0].id}`), { token: other.accessToken })).status).toBe(404);
  });

  it('rejects limits above the KYC tier', async () => {
    const ops = await bankOps('ALPHA');
    const s = await registerCustomer();
    const { accountId } = await openAccount(ops, { name: s.name, phone: s.phone }, { kycTier: 'MIN' });
    const r = await call('POST', gw('/api/accounts/approvals'), {
      token: ops.maker.token,
      body: { accountId, kind: 'LIMIT_CHANGE', reason: 'raise limit', payload: { dailyDebitLimit: 100_000_000 } },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LIMIT_ABOVE_TIER');
  });
});
