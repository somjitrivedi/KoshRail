import type { AccountStatus, InternalAccount } from '@kosh/contracts';
import { migrationsDir, openDb } from '@kosh/service-kit';
import { FakeClock } from '@kosh/test-kit';
import { BankLedger } from '../src/ledger.ts';

export const MIGRATIONS = migrationsDir(new URL('../src/main.ts', import.meta.url).href);

export function account(id: string, overrides: Partial<InternalAccount> = {}): InternalAccount {
  return {
    id,
    bankCode: 'KOSH',
    accountNumber: '111111111111',
    ifsc: 'KOSH0000001',
    type: 'SAVINGS',
    glCode: null,
    status: 'ACTIVE' as AccountStatus,
    overdraftLimit: 0,
    perTxnLimit: 100_000_000,
    dailyDebitLimit: 1_000_000_000,
    customerId: `cus_${id}`,
    userId: null,
    holderName: `Holder ${id}`,
    ...overrides,
  };
}

export function gl(id: string, glCode: InternalAccount['glCode']): InternalAccount {
  return account(id, { type: 'INTERNAL', glCode, customerId: null, perTxnLimit: Number.MAX_SAFE_INTEGER, dailyDebitLimit: Number.MAX_SAFE_INTEGER });
}

export function setupLedger(clock = new FakeClock()) {
  const db = openDb(':memory:', MIGRATIONS);
  const ledger = new BankLedger('KOSH', db, clock);
  for (const a of [gl('gl_cash', 'CASH'), gl('gl_switch', 'SWITCH_SETTLEMENT'), account('acc_a'), account('acc_b')]) ledger.upsertAccount(a);
  return { db, ledger, clock };
}
