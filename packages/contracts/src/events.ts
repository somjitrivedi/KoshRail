import type { AccountStatus, AccountType, GlCode } from './domain.ts';

export type UserRegistered = { userId: string; name: string };
export type DeviceBound = { userId: string; deviceId: string };
export type MpinLocked = { userId: string; lockedUntil: string };

export type AccountOpened = {
  accountId: string;
  bankCode: string;
  customerId: string | null;
  type: AccountType;
  glCode: GlCode | null;
  status: AccountStatus;
  overdraftLimit: number;
  perTxnLimit: number;
  dailyDebitLimit: number;
  holderName: string;
};
export type AccountStatusChanged = { accountId: string; bankCode: string; from: AccountStatus; to: AccountStatus; reason: string | null };
export type LimitChanged = { accountId: string; bankCode: string; perTxnLimit: number; dailyDebitLimit: number; overdraftLimit: number };

export type EntryPosted = { entryId: string; bankCode: string; kind: string; reference: string; postings: { accountId: string; amount: number }[] };
export type HoldEvent = { holdId: string; bankCode: string; accountId: string; amount: number; reference: string };

export type VpaCreated = { vpaId: string; address: string; userId: string };
export type VpaLinked = { vpaId: string; address: string; accountId: string; bankCode: string; isDefault: boolean };
export type VpaDisabled = { vpaId: string; address: string };

export type TxnInitiated = { txnId: string; rrn: string; payerVpa: string; payeeVpa: string; payerBank: string; payeeBank: string; amount: number };
export type TxnStepCompleted = { txnId: string; rrn: string; from: string; to: string; step: string | null; bankCode: string | null };
export type TxnFinished = { txnId: string; rrn: string; state: string; amount: number; payerBank: string; payeeBank: string; code: string | null };

export const EVENT_TYPES = {
  UserRegistered: 'UserRegistered',
  DeviceBound: 'DeviceBound',
  MpinLocked: 'MpinLocked',
  AccountOpened: 'AccountOpened',
  AccountStatusChanged: 'AccountStatusChanged',
  LimitChanged: 'LimitChanged',
  EntryPosted: 'EntryPosted',
  HoldPlaced: 'HoldPlaced',
  HoldCaptured: 'HoldCaptured',
  HoldReleased: 'HoldReleased',
  HoldExpired: 'HoldExpired',
  VpaCreated: 'VpaCreated',
  VpaLinked: 'VpaLinked',
  VpaUnlinked: 'VpaUnlinked',
  VpaDisabled: 'VpaDisabled',
  TxnInitiated: 'TxnInitiated',
  TxnStepCompleted: 'TxnStepCompleted',
  TxnCompleted: 'TxnCompleted',
  TxnFailed: 'TxnFailed',
  TxnDeemed: 'TxnDeemed',
  TxnReversed: 'TxnReversed',
  TxnManualReview: 'TxnManualReview',
} as const;
