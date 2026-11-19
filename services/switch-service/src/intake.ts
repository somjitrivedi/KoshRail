import { z } from 'zod';
import { EVENT_TYPES, type Principal, type ResolveResult, TOPICS } from '@kosh/contracts';
import {
  AppError,
  type Db,
  forbidden,
  idempotent,
  isAppError,
  newId,
  notFound,
  sha256,
  stableStringify,
  type StoredResponse,
  unauthorized,
  unprocessable,
} from '@kosh/service-kit';
import type { SwitchConfig } from './config.ts';
import { customerStatus } from './machine.ts';
import type { SwitchStore, Txn } from './store.ts';

export interface MpinClaims {
  userId: string;
  purpose: string;
  jti: string;
}

export interface IdentityPort {
  verifyMpinToken(token: string): Promise<MpinClaims>;
}

export interface VpaPort {
  resolve(address: string): Promise<ResolveResult>;
}

const Vpa = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$/, 'must look like handle@psp');

export const PayBody = z.object({
  payerVpa: Vpa,
  payeeVpa: Vpa,
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  note: z.string().trim().max(80).optional(),
  mpinToken: z.string().min(10).max(4096),
});
export type PayRequest = z.infer<typeof PayBody>;

export function customerView(t: Txn) {
  return {
    id: t.id,
    rrn: t.rrn,
    status: customerStatus(t.state),
    state: t.state,
    amount: t.amount,
    payerVpa: t.payerVpa,
    payeeVpa: t.payeeVpa,
    payeeName: t.payeeName,
    note: t.note,
    failureCode: customerStatus(t.state) === 'FAILED' ? t.failureCode : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    finishedAt: t.finishedAt,
  };
}

export type CustomerTxnView = ReturnType<typeof customerView>;

function payScope(userId: string): string {
  return `pay:${userId}`;
}

function priorResponse(db: Db, scope: string, key: string, fingerprint: unknown): StoredResponse<CustomerTxnView> | null {
  const row = db.prepare('SELECT request_hash, status, response FROM _idempotency WHERE scope = ? AND key = ?').get(scope, key) as
    | { request_hash: string; status: number; response: string }
    | undefined;
  if (!row) return null;
  if (row.request_hash !== sha256(stableStringify(fingerprint))) {
    throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'idempotency key was already used with a different request');
  }
  return { status: row.status, body: JSON.parse(row.response) as CustomerTxnView, replayed: true };
}

async function resolveSide(vpa: VpaPort, address: string, side: 'PAYER' | 'PAYEE'): Promise<ResolveResult & { accountRef: string }> {
  let r: ResolveResult;
  try {
    r = await vpa.resolve(address);
  } catch (err) {
    if (!isAppError(err) || err.status >= 500) throw err;
    if (err.status === 404) throw notFound(`${side}_VPA_NOT_FOUND`, `${side.toLowerCase()} VPA ${address} was not found`);
    throw new AppError(err.status, `${side}_${err.code}`, err.message);
  }
  if (!r.accountRef) throw new AppError(502, 'VPA_RESOLVE_INCOMPLETE', 'vpa-service did not return an account reference');
  return { ...r, accountRef: r.accountRef };
}

export class PaymentIntake {
  constructor(
    private readonly store: SwitchStore,
    private readonly identity: IdentityPort,
    private readonly vpa: VpaPort,
    private readonly config: SwitchConfig,
  ) {}

  async pay(principal: Principal, key: string, body: PayRequest): Promise<StoredResponse<CustomerTxnView>> {
    const db = this.store.db;
    const scope = payScope(principal.sub);
    const fingerprint = { payerVpa: body.payerVpa, payeeVpa: body.payeeVpa, amount: body.amount, note: body.note ?? null };
    const prior = priorResponse(db, scope, key, fingerprint);
    if (prior) return prior;

    if (body.amount > this.config.maxTxnAmount) {
      throw unprocessable('AMOUNT_LIMIT_EXCEEDED', `a single payment can be at most ${this.config.maxTxnAmount} paise`, { max: this.config.maxTxnAmount });
    }
    if (body.payerVpa === body.payeeVpa) throw unprocessable('SAME_VPA', 'payer and payee VPA must differ');

    let claims: MpinClaims;
    try {
      claims = await this.identity.verifyMpinToken(body.mpinToken);
    } catch (err) {
      if (isAppError(err) && err.status === 401) throw unauthorized('MPIN_TOKEN_INVALID', 'MPIN token is invalid or expired; verify the MPIN again');
      throw err;
    }
    if (claims.userId !== principal.sub) throw forbidden('MPIN_TOKEN_NOT_YOURS', 'MPIN token belongs to a different user');
    if (claims.purpose !== 'PAYMENT') throw forbidden('MPIN_TOKEN_PURPOSE', `MPIN token was issued for ${claims.purpose}, not PAYMENT`);

    const payer = await resolveSide(this.vpa, body.payerVpa, 'PAYER');
    if (payer.userId !== principal.sub) throw forbidden('PAYER_VPA_NOT_OWNED', 'you can only pay from your own VPA');
    const payee = await resolveSide(this.vpa, body.payeeVpa, 'PAYEE');
    if (payer.accountRef === payee.accountRef) throw unprocessable('SAME_ACCOUNT', 'payer and payee resolve to the same bank account');

    return idempotent(db, scope, key, fingerprint, () => {
      const id = newId('txn');
      if (!this.store.consumeMpinToken(claims.jti, principal.sub, id)) {
        throw unauthorized('MPIN_TOKEN_USED', 'this MPIN token was already used for another payment');
      }
      const txn = this.store.createTxn(
        {
          id,
          payerUserId: principal.sub,
          payerVpa: body.payerVpa,
          payerBank: payer.bankCode,
          payerAccount: payer.accountRef,
          payeeUserId: payee.userId ?? null,
          payeeVpa: body.payeeVpa,
          payeeBank: payee.bankCode,
          payeeAccount: payee.accountRef,
          payeeName: payee.maskedName,
          amount: body.amount,
          note: body.note ?? null,
          holdTtlSeconds: this.config.holdTtlSeconds,
        },
        (t) => [
          {
            topic: TOPICS.switch,
            type: EVENT_TYPES.TxnInitiated,
            key: t.id,
            payload: { txnId: t.id, rrn: t.rrn, payerVpa: t.payerVpa, payeeVpa: t.payeeVpa, payerBank: t.payerBank, payeeBank: t.payeeBank, amount: t.amount },
          },
        ],
      );
      return { status: 202, body: customerView(txn) };
    });
  }
}
