import { join } from 'node:path';
import type { ResolveResult } from '@kosh/contracts';
import { AppError, type Db, migrationsDir, openDb } from '@kosh/service-kit';
import { FakeClock, TEST_TOKEN, tempDir, testLogger } from '@kosh/test-kit';
import { buildSwitch } from '../src/app.ts';
import { DEFAULT_CONFIG, type SwitchConfig } from '../src/config.ts';
import type { IdentityPort, MpinClaims, VpaPort } from '../src/intake.ts';
import { seededRandom } from '../src/resilience.ts';
import type { CrashHook, RiskPort } from '../src/saga.ts';
import { FakeBankNetwork } from './fake-banks.ts';

export const MIGRATIONS = migrationsDir(new URL('../src/main.ts', import.meta.url).href);

export const TEST_CONFIG: SwitchConfig = {
  ...DEFAULT_CONFIG,
  holdTtlSeconds: 600,
  stepTimeoutMs: 1000,
  maxAttempts: 3,
  retryBaseMs: 50,
  retryCapMs: 400,
  parkBaseMs: 200,
  parkCapMs: 2000,
  breakerFailureThreshold: 5,
  breakerCooldownMs: 1000,
  leaseMs: 5000,
  deemedPollMs: 1000,
  deemedMaxPolls: 5,
};

export class FakeIdentity implements IdentityPort {
  private readonly tokens = new Map<string, MpinClaims>();
  private seq = 0;

  issue(userId: string, purpose = 'PAYMENT'): string {
    this.seq++;
    const token = `mpin-token-${userId}-${this.seq}`;
    this.tokens.set(token, { userId, purpose, jti: `jti-${this.seq}` });
    return token;
  }

  async verifyMpinToken(token: string): Promise<MpinClaims> {
    const claims = this.tokens.get(token);
    if (!claims) throw new AppError(401, 'MPIN_TOKEN_INVALID', 'invalid token');
    return claims;
  }
}

export class FakeVpa implements VpaPort {
  readonly entries = new Map<string, ResolveResult | AppError>();

  add(address: string, userId: string, bankCode: string, accountRef: string, name = 'Test Person'): void {
    this.entries.set(address, { address, maskedName: name, bankCode, accountRef, userId, status: 'ACTIVE' });
  }

  fail(address: string, err: AppError): void {
    this.entries.set(address, err);
  }

  async resolve(address: string): Promise<ResolveResult> {
    const e = this.entries.get(address);
    if (!e) throw new AppError(404, 'VPA_NOT_FOUND', 'VPA not found');
    if (e instanceof AppError) throw e;
    return e;
  }
}

export interface HarnessOptions {
  config?: Partial<SwitchConfig>;
  db?: Db;
  clock?: FakeClock;
  banks?: FakeBankNetwork;
  identity?: FakeIdentity;
  vpa?: FakeVpa;
  owner?: string;
  crash?: CrashHook;
  risk?: RiskPort;
  seed?: number;
}

export function harness(opts: HarnessOptions = {}) {
  const dir = opts.db ? null : tempDir('kosh-switch-');
  const db = opts.db ?? openDb(join(dir!.path, 'switch.db'), MIGRATIONS);
  const clock = opts.clock ?? new FakeClock('2026-11-18T04:30:00.000Z');
  const banks = opts.banks ?? new FakeBankNetwork(clock);
  const identity = opts.identity ?? new FakeIdentity();
  const vpa = opts.vpa ?? new FakeVpa();
  const config = { ...TEST_CONFIG, ...(opts.config ?? {}) };
  const built = buildSwitch({
    db,
    clock,
    log: testLogger('switch-test'),
    internalToken: TEST_TOKEN,
    config,
    owner: opts.owner ?? 'owner-a',
    banks,
    identity,
    vpa,
    risk: opts.risk,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    random: seededRandom(opts.seed ?? 7),
    crash: opts.crash,
    autoDrive: false,
  });
  return {
    ...built,
    db,
    dbPath: dir ? join(dir.path, 'switch.db') : null,
    clock,
    banks,
    identity,
    vpa,
    config,
    cleanup: () => {
      if (dir) {
        db.close();
        dir.cleanup();
      }
    },
  };
}

export type Harness = ReturnType<typeof harness>;

export interface Party {
  userId: string;
  vpa: string;
  bank: string;
  accountId: string;
}

let partySeq = 0;
export function party(h: Pick<Harness, 'banks' | 'vpa'>, bank: string, deposit: number, name = 'Test Person'): Party {
  partySeq++;
  const userId = `usr_${partySeq}`;
  const accountId = `acc_${bank.toLowerCase()}_${partySeq}`;
  const vpa = `p${partySeq}@${bank.toLowerCase()}`;
  h.banks.open(bank, accountId, deposit);
  h.vpa.add(vpa, userId, bank, accountId, name);
  return { userId, vpa, bank, accountId };
}

let txnSeq = 0;
export function createPayment(h: Harness, payer: Party, payee: Party, amount: number) {
  txnSeq++;
  return h.store.createTxn(
    {
      id: `txn_test_${String(txnSeq).padStart(8, '0')}`,
      payerUserId: payer.userId,
      payerVpa: payer.vpa,
      payerBank: payer.bank,
      payerAccount: payer.accountId,
      payeeUserId: payee.userId,
      payeeVpa: payee.vpa,
      payeeBank: payee.bank,
      payeeAccount: payee.accountId,
      payeeName: 'Test P',
      amount,
      note: null,
      holdTtlSeconds: h.config.holdTtlSeconds,
    },
    () => [],
  );
}

export function outboxTypes(db: Db, txnId: string): string[] {
  return db.prepare('SELECT type FROM _outbox WHERE key = ? ORDER BY seq').pluck().all(txnId) as string[];
}
