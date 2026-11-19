import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { InternalAccount } from '@kosh/contracts';
import { encodePrincipal, migrationsDir, notFound, openDb, type Db } from '@kosh/service-kit';
import { customerPrincipal, TEST_TOKEN, testLogger, FakeClock } from '@kosh/test-kit';
import { buildVpa } from '../src/app.ts';
import { TtlLru } from '../src/cache.ts';
import { handleProblem, maskName } from '../src/rules.ts';
import type { VpaService } from '../src/service.ts';

const MIGRATIONS = migrationsDir(new URL('../src/main.ts', import.meta.url).href);
const GW = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway' };
const SVC = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'switch-service' };

let db: Db;
let app: Express;
let svc: VpaService;
let accounts: Map<string, InternalAccount>;

function asUser(id: string) {
  return { ...GW, 'x-kosh-principal': encodePrincipal(customerPrincipal(id)) };
}

function acct(id: string, userId: string | null, extra: Partial<InternalAccount> = {}): InternalAccount {
  return {
    id,
    bankCode: 'ALPHA',
    accountNumber: '111111111111',
    ifsc: 'x',
    type: 'SAVINGS',
    glCode: null,
    status: 'ACTIVE',
    overdraftLimit: 0,
    perTxnLimit: 1,
    dailyDebitLimit: 1,
    customerId: 'c',
    userId,
    holderName: 'Ravi Kumar Sharma',
    ...extra,
  };
}

beforeEach(() => {
  db = openDb(':memory:', MIGRATIONS);
  accounts = new Map([
    ['acc_1', acct('acc_1', 'usr_ravi')],
    ['acc_2', acct('acc_2', 'usr_ravi', { bankCode: 'BETA' })],
    ['acc_other', acct('acc_other', 'usr_meera')],
    ['acc_frozen', acct('acc_frozen', 'usr_ravi', { status: 'FROZEN' })],
  ]);
  const built = buildVpa({
    db,
    clock: new FakeClock(),
    log: testLogger(),
    internalToken: TEST_TOKEN,
    accounts: {
      getAccount: async (id) => {
        const a = accounts.get(id);
        if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'x');
        return a;
      },
      listBanks: async () => [
        { code: 'KOSH', name: 'Kosh', ifscPrefix: 'KOSH', vpaHandle: 'kosh', status: 'ACTIVE' },
        { code: 'ALPHA', name: 'Alpha', ifscPrefix: 'ALPH', vpaHandle: 'alpha', status: 'ACTIVE' },
        { code: 'BETA', name: 'Beta', ifscPrefix: 'BETA', vpaHandle: 'beta', status: 'ACTIVE' },
      ],
    },
  });
  app = built.app;
  svc = built.svc;
});

async function createLinked(handle = 'ravi', userId = 'usr_ravi', accountId = 'acc_1') {
  const v = await request(app).post('/vpas').set(asUser(userId)).send({ handle, pspHandle: 'kosh' });
  expect(v.status).toBe(201);
  const l = await request(app).post(`/vpas/${v.body.address}/links`).set(asUser(userId)).send({ accountId });
  expect(l.status).toBe(201);
  return v.body.address as string;
}

describe('vpa rules', () => {
  it('validates handles', () => {
    expect(handleProblem('ravi.k')).toBeNull();
    expect(handleProblem('9999999999')).toBeNull();
    expect(handleProblem('ab')).toMatch(/3-30/);
    expect(handleProblem('Ravi')).toMatch(/lowercase/);
    expect(handleProblem('ravi..k')).toMatch(/consecutive/);
    expect(handleProblem('ravi.')).toMatch(/end/);
    expect(handleProblem('admin')).toMatch(/reserved/);
    expect(handleProblem('12345')).toMatch(/numeric/);
  });

  it('masks names to first name and initials', () => {
    expect(maskName('Ravi Kumar Sharma')).toBe('Ravi K S');
    expect(maskName('  meera  ')).toBe('meera');
    expect(maskName('Asha verma')).toBe('Asha V');
  });

  it('expires and evicts cache entries', () => {
    let t = 0;
    const c = new TtlLru<number>(2, 100, () => t);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    t = 150;
    expect(c.get('a')).toBeUndefined();
    expect(c.stats()).toMatchObject({ evictions: 1 });
  });
});

describe('vpa lifecycle', () => {
  it('creates VPAs and enforces uniqueness, psp and per-user limits', async () => {
    const created = await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: 'Ravi', pspHandle: 'KOSH' });
    expect(created.body.address).toBe('ravi@kosh');
    expect((await request(app).post('/vpas').set(asUser('usr_meera')).send({ handle: 'ravi', pspHandle: 'kosh' })).body.error.code).toBe('VPA_TAKEN');
    expect((await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: 'ravi', pspHandle: 'nope' })).body.error.code).toBe('PSP_UNKNOWN');
    expect((await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: 'support', pspHandle: 'kosh' })).body.error.code).toBe('VPA_HANDLE_INVALID');
    for (const h of ['r2', 'r3', 'r4', 'r5']) await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: `ravi${h}`, pspHandle: 'alpha' }).expect(201);
    expect((await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: 'ravi6', pspHandle: 'beta' })).body.error.code).toBe('VPA_LIMIT');
    const avail = await request(app).get('/availability?handle=ravi&psp=kosh').set(asUser('usr_meera'));
    expect(avail.body).toMatchObject({ available: false, reason: 'already taken' });
    expect(db.prepare("SELECT COUNT(*) FROM _outbox WHERE type = 'VpaCreated'").pluck().get()).toBe(5);
  });

  it('links only owned active accounts and manages the default', async () => {
    await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: 'ravi', pspHandle: 'kosh' });
    expect((await request(app).post('/vpas/ravi@kosh/links').set(asUser('usr_ravi')).send({ accountId: 'acc_other' })).body.error.code).toBe('ACCOUNT_NOT_OWNED');
    expect((await request(app).post('/vpas/ravi@kosh/links').set(asUser('usr_ravi')).send({ accountId: 'acc_frozen' })).body.error.code).toBe('ACCOUNT_INACTIVE');
    expect((await request(app).post('/vpas/ravi@kosh/links').set(asUser('usr_meera')).send({ accountId: 'acc_other' })).status).toBe(404);
    const first = await request(app).post('/vpas/ravi@kosh/links').set(asUser('usr_ravi')).send({ accountId: 'acc_1' });
    expect(first.body.links).toEqual([expect.objectContaining({ accountId: 'acc_1', isDefault: true })]);
    const second = await request(app).post('/vpas/ravi@kosh/links').set(asUser('usr_ravi')).send({ accountId: 'acc_2' });
    expect(second.body.links.find((l: { accountId: string }) => l.accountId === 'acc_2').isDefault).toBe(false);
    expect((await request(app).post('/vpas/ravi@kosh/links').set(asUser('usr_ravi')).send({ accountId: 'acc_1' })).body.error.code).toBe('ALREADY_LINKED');
    expect((await request(app).get('/resolve/ravi@kosh').set(SVC)).body.bankCode).toBe('ALPHA');
    await request(app).post('/vpas/ravi@kosh/default').set(asUser('usr_ravi')).send({ accountId: 'acc_2' }).expect(200);
    expect((await request(app).get('/resolve/ravi@kosh').set(SVC)).body).toMatchObject({ bankCode: 'BETA', accountRef: 'acc_2' });
    const unlinked = await request(app).delete('/vpas/ravi@kosh/links/acc_2').set(asUser('usr_ravi'));
    expect(unlinked.body.links).toEqual([expect.objectContaining({ accountId: 'acc_1', isDefault: true })]);
    expect((await request(app).get('/resolve/ravi@kosh').set(SVC)).body.accountRef).toBe('acc_1');
  });
});

describe('resolve', () => {
  it('hides the account reference from customers but not from services', async () => {
    const address = await createLinked();
    const pub = await request(app).get(`/resolve/${address}`).set(asUser('usr_meera'));
    expect(pub.body).toEqual({ address: 'ravi@kosh', maskedName: 'Ravi K S', bankCode: 'ALPHA', status: 'ACTIVE' });
    const internal = await request(app).get(`/resolve/${address}`).set(SVC);
    expect(internal.body.accountRef).toBe('acc_1');
    expect((await request(app).get(`/resolve/${address}`).set(GW)).status).toBe(401);
  });

  it('tells services who owns the VPA so the switch can check the payer', async () => {
    const address = await createLinked();
    const internal = await request(app).get(`/resolve/${address}`).set(SVC);
    expect(internal.body.userId).toBe('usr_ravi');
    const pub = await request(app).get(`/resolve/${address}`).set(asUser('usr_meera'));
    expect(pub.body.userId).toBeUndefined();
  });

  it('reports unknown, unlinked, malformed and disabled VPAs', async () => {
    expect((await request(app).get('/resolve/ghost@kosh').set(SVC)).body.error.code).toBe('VPA_NOT_FOUND');
    expect((await request(app).get('/resolve/not-an-address').set(SVC)).body.error.code).toBe('VPA_FORMAT');
    await request(app).post('/vpas').set(asUser('usr_ravi')).send({ handle: 'lonely', pspHandle: 'beta' });
    expect((await request(app).get('/resolve/lonely@beta').set(SVC)).body.error.code).toBe('VPA_NOT_LINKED');
    const address = await createLinked('ravi.pay');
    await request(app).get(`/resolve/${address}`).set(SVC).expect(200);
    await request(app).post(`/vpas/${address}/disable`).set(asUser('usr_ravi')).expect(200);
    expect((await request(app).get(`/resolve/${address}`).set(SVC)).body.error.code).toBe('VPA_DISABLED');
  });

  it('serves repeat lookups from cache and invalidates on account status events', async () => {
    const address = await createLinked();
    await request(app).get(`/resolve/${address}`).set(SVC);
    await request(app).get(`/resolve/${address}`).set(SVC);
    const stats = await request(app).get('/internal/cache-stats').set(SVC);
    expect(stats.body.hits).toBeGreaterThanOrEqual(1);
    svc.applyAccountEvent('AccountStatusChanged', { accountId: 'acc_1', bankCode: 'ALPHA', from: 'PENDING', to: 'ACTIVE' });
    expect((await request(app).get(`/resolve/${address}`).set(SVC)).status).toBe(200);
    svc.applyAccountEvent('AccountStatusChanged', { accountId: 'acc_1', bankCode: 'ALPHA', from: 'ACTIVE', to: 'FROZEN' });
    const frozen = await request(app).get(`/resolve/${address}`).set(SVC);
    expect(frozen.status).toBe(422);
    expect(frozen.body.error.code).toBe('ACCOUNT_INACTIVE');
    svc.applyAccountEvent('AccountStatusChanged', { accountId: 'acc_1', bankCode: 'ALPHA', from: 'FROZEN', to: 'ACTIVE' });
    expect((await request(app).get(`/resolve/${address}`).set(SVC)).status).toBe(200);
  });
});
