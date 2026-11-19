import { z } from 'zod';

export const ACCOUNT_TYPES = ['SAVINGS', 'CURRENT', 'INTERNAL'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_STATUSES = ['PENDING', 'ACTIVE', 'FROZEN', 'DORMANT', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const GL_CODES = ['CASH', 'SWITCH_SETTLEMENT', 'SUSPENSE', 'FEES', 'CENTRAL_SETTLEMENT'] as const;
export type GlCode = (typeof GL_CODES)[number];

export const KYC_TIERS = ['MIN', 'FULL'] as const;
export type KycTier = (typeof KYC_TIERS)[number];

export const InternalAccountSchema = z.object({
  id: z.string(),
  bankCode: z.string(),
  accountNumber: z.string(),
  ifsc: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  glCode: z.enum(GL_CODES).nullable(),
  status: z.enum(ACCOUNT_STATUSES),
  overdraftLimit: z.number().int(),
  perTxnLimit: z.number().int(),
  dailyDebitLimit: z.number().int(),
  customerId: z.string().nullable(),
  userId: z.string().nullable(),
  holderName: z.string(),
});
export type InternalAccount = z.infer<typeof InternalAccountSchema>;

export const BankSchema = z.object({
  code: z.string(),
  name: z.string(),
  ifscPrefix: z.string(),
  vpaHandle: z.string(),
  status: z.string(),
});
export type Bank = z.infer<typeof BankSchema>;

export const InternalUserSchema = z.object({
  id: z.string(),
  phone: z.string(),
  name: z.string(),
  status: z.string(),
});
export type InternalUser = z.infer<typeof InternalUserSchema>;

export const ResolveResultSchema = z.object({
  address: z.string(),
  maskedName: z.string(),
  bankCode: z.string(),
  accountRef: z.string().optional(),
  userId: z.string().optional(),
  status: z.literal('ACTIVE'),
});
export type ResolveResult = z.infer<typeof ResolveResultSchema>;

export const BalanceSchema = z.object({
  accountId: z.string(),
  bankCode: z.string(),
  ledgerBalance: z.number().int(),
  heldAmount: z.number().int(),
  availableBalance: z.number().int(),
  asOf: z.string(),
});
export type Balance = z.infer<typeof BalanceSchema>;

export const HoldSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  amount: z.number().int(),
  status: z.enum(['ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED']),
  reference: z.string(),
  expiresAt: z.string(),
  captureEntryId: z.string().nullable(),
});
export type Hold = z.infer<typeof HoldSchema>;

export const ADAPTER_STEPS = ['hold', 'credit', 'capture', 'release', 'reverse'] as const;
export type AdapterStep = (typeof ADAPTER_STEPS)[number];

export const FAULT_MODES = ['NONE', 'LATENCY', 'ERROR', 'TIMEOUT_AFTER_COMMIT', 'DROP_RESPONSE'] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export const TXN_STATES = [
  'INITIATED',
  'RISK_PASSED',
  'DEBIT_HELD',
  'CREDITED',
  'COMPLETED',
  'DEBIT_FAILED',
  'CREDIT_FAILED',
  'REVERSING',
  'REVERSED',
  'DEEMED',
  'MANUAL_REVIEW',
] as const;
export type TxnState = (typeof TXN_STATES)[number];
