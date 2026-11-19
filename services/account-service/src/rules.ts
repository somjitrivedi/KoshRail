import type { AccountStatus, GlCode, KycTier } from '@kosh/contracts';
import { rupees } from '@kosh/money';

export const TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  PENDING: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['FROZEN', 'DORMANT', 'CLOSED'],
  FROZEN: ['ACTIVE', 'CLOSED'],
  DORMANT: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const DIRECT_ACTIONS = {
  activate: { from: ['PENDING'], to: 'ACTIVE' },
  dormant: { from: ['ACTIVE'], to: 'DORMANT' },
  reactivate: { from: ['DORMANT'], to: 'ACTIVE' },
} as const satisfies Record<string, { from: readonly AccountStatus[]; to: AccountStatus }>;
export type DirectAction = keyof typeof DIRECT_ACTIONS;

export const APPROVAL_KINDS = ['FREEZE', 'UNFREEZE', 'LIMIT_CHANGE', 'CLOSE'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_TARGET: Record<Exclude<ApprovalKind, 'LIMIT_CHANGE'>, { from: readonly AccountStatus[]; to: AccountStatus }> = {
  FREEZE: { from: ['ACTIVE'], to: 'FROZEN' },
  UNFREEZE: { from: ['FROZEN'], to: 'ACTIVE' },
  CLOSE: { from: ['PENDING', 'ACTIVE', 'FROZEN', 'DORMANT'], to: 'CLOSED' },
};

export interface Limits {
  perTxnLimit: number;
  dailyDebitLimit: number;
}

export const TIER_LIMITS: Record<KycTier, Limits> = {
  MIN: { perTxnLimit: rupees(10_000), dailyDebitLimit: rupees(20_000) },
  FULL: { perTxnLimit: rupees(100_000), dailyDebitLimit: rupees(200_000) },
};

export const MAX_OVERDRAFT = rupees(500_000);

export const INTERNAL_LIMIT = Number.MAX_SAFE_INTEGER;

export const GL_NAMES: Record<GlCode, string> = {
  CASH: 'Cash in Vault',
  SWITCH_SETTLEMENT: 'Switch Settlement',
  SUSPENSE: 'Suspense',
  FEES: 'Fee Income',
  CENTRAL_SETTLEMENT: 'Central Bank Settlement',
};

export const SEED_BANKS = [
  { code: 'KOSH', name: 'Kosh Bank', ifscPrefix: 'KOSH', vpaHandle: 'kosh', numberPrefix: '1001' },
  { code: 'ALPHA', name: 'Alpha Bank', ifscPrefix: 'ALPH', vpaHandle: 'alpha', numberPrefix: '2002' },
  { code: 'BETA', name: 'Beta Bank', ifscPrefix: 'BETA', vpaHandle: 'beta', numberPrefix: '3003' },
] as const;

export function maskAccountNumber(n: string): string {
  return `${'X'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
}
