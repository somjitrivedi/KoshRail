import type { TxnState } from '@kosh/contracts';

export const TERMINAL_STATES: readonly TxnState[] = ['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'];

const TRANSITIONS: Record<TxnState, readonly TxnState[]> = {
  INITIATED: ['RISK_PASSED', 'MANUAL_REVIEW'],
  RISK_PASSED: ['DEBIT_HELD', 'DEBIT_FAILED', 'DEEMED', 'MANUAL_REVIEW'],
  DEBIT_HELD: ['CREDITED', 'CREDIT_FAILED', 'DEEMED', 'MANUAL_REVIEW'],
  CREDITED: ['COMPLETED', 'REVERSING', 'DEEMED', 'MANUAL_REVIEW'],
  CREDIT_FAILED: ['REVERSING', 'MANUAL_REVIEW'],
  REVERSING: ['REVERSED', 'MANUAL_REVIEW'],
  DEEMED: ['DEBIT_HELD', 'DEBIT_FAILED', 'CREDITED', 'CREDIT_FAILED', 'COMPLETED', 'REVERSING', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['INITIATED', 'RISK_PASSED','DEBIT_HELD', 'CREDITED', 'REVERSING', 'DEEMED'],
  COMPLETED: [],
  DEBIT_FAILED: [],
  REVERSED: [],
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: TxnState,
    readonly to: TxnState,
  ) {
    super(`illegal saga transition ${from} -> ${to}`);
    this.name = 'IllegalTransition';
  }
}

export function canTransition(from: TxnState, to: TxnState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TxnState, to: TxnState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export function isTerminal(state: TxnState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function allowedTargets(from: TxnState): readonly TxnState[] {
  return TRANSITIONS[from];
}

export type CustomerStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export function customerStatus(state: TxnState): CustomerStatus {
  if (state === 'COMPLETED') return 'SUCCESS';
  if (state === 'DEBIT_FAILED' || state === 'REVERSED') return 'FAILED';
  return 'PENDING';
}
