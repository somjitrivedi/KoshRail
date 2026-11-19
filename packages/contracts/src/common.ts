import { z } from 'zod';

export const ROLES = ['ADMIN', 'BANK_OPS', 'SWITCH_OPS', 'FRAUD_ANALYST'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

export const PrincipalSchema = z.object({
  sub: z.string(),
  kind: z.enum(['customer', 'staff']),
  roles: z.array(RoleSchema),
  bankCode: z.string().nullable(),
  deviceId: z.string().nullable(),
  sid: z.string(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  type: z.string().min(1),
  key: z.string().min(1),
  occurredAt: z.string(),
  source: z.string().min(1),
  payload: z.unknown(),
});
export type EventEnvelope<P = unknown> = Omit<z.infer<typeof EventEnvelopeSchema>, 'payload'> & { payload: P };
export type DeliveredEvent<P = unknown> = EventEnvelope<P> & { offset: number };

export const TOPICS = {
  identity: 'identity.events',
  account: 'account.events',
  ledger: 'ledger.events',
  vpa: 'vpa.events',
  switch: 'switch.txn',
} as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export const HEADERS = {
  internalToken: 'x-kosh-internal-token',
  caller: 'x-kosh-caller',
  principal: 'x-kosh-principal',
  requestId: 'x-request-id',
  idempotencyKey: 'idempotency-key',
  replayed: 'idempotent-replayed',
} as const;

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const BANK_CODES = ['KOSH', 'ALPHA', 'BETA'] as const;
export const BankCodeSchema = z.string().regex(/^[A-Z]{3,8}$/);
