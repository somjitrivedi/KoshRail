import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATUSES } from '@kosh/contracts';
import { canTransition, maskAccountNumber, TIER_LIMITS } from '../src/rules.ts';

const LEGAL = new Set([
  'PENDING>ACTIVE',
  'PENDING>CLOSED',
  'ACTIVE>FROZEN',
  'ACTIVE>DORMANT',
  'ACTIVE>CLOSED',
  'FROZEN>ACTIVE',
  'FROZEN>CLOSED',
  'DORMANT>ACTIVE',
  'DORMANT>CLOSED',
]);

describe('account lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    for (const from of ACCOUNT_STATUSES) {
      for (const to of ACCOUNT_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(LEGAL.has(`${from}>${to}`));
      }
    }
  });

  it('treats CLOSED as terminal', () => {
    expect(ACCOUNT_STATUSES.filter((s) => canTransition('CLOSED', s))).toEqual([]);
  });

  it('keeps tier limits consistent', () => {
    for (const t of Object.values(TIER_LIMITS)) expect(t.perTxnLimit).toBeLessThanOrEqual(t.dailyDebitLimit);
    expect(TIER_LIMITS.MIN.dailyDebitLimit).toBeLessThan(TIER_LIMITS.FULL.dailyDebitLimit);
  });

  it('masks account numbers', () => {
    expect(maskAccountNumber('111111111111')).toBe('XXXXXXXX1111');
  });
});
