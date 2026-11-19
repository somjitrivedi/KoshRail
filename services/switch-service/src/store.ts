import type { AdapterStep, TxnState } from '@kosh/contracts';
import { type Clock, type Db, emit, newId, type OutgoingEvent, tx } from '@kosh/service-kit';
import type { OutcomeKind } from './classify.ts';
import { assertTransition, TERMINAL_STATES } from './machine.ts';
import { nextRrn } from './rrn.ts';

export type SagaStep = 'risk' | AdapterStep | 'inquiry';

export interface Txn {
  id: string;
  rrn: string;
  payerUserId: string;
  payerVpa: string;
  payerBank: string;
  payerAccount: string;
  payeeUserId: string | null;
  payeeVpa: string;
  payeeBank: string;
  payeeAccount: string;
  payeeName: string;
  amount: number;
  note: string | null;
  state: TxnState;
  holdTtlSeconds: number;
  holdId: string | null;
  creditEntryId: string | null;
  captureEntryId: string | null;
  reversalEntryId: string | null;
  holdReleased: boolean;
  deemedStep: AdapterStep | null;
  deemedPolls: number;
  parkCount: number;
  reviewFrom: TxnState | null;
  failureCode: string | null;
  failureMessage: string | null;
  version: number;
  fence: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface TxnRow {
  id: string;
  rrn: string;
  payer_user_id: string;
  payer_vpa: string;
  payer_bank: string;
  payer_account: string;
  payee_user_id: string | null;
  payee_vpa: string;
  payee_bank: string;
  payee_account: string;
  payee_name: string;
  amount: number;
  note: string | null;
  state: TxnState;
  hold_ttl_seconds: number;
  hold_id: string | null;
  credit_entry_id: string | null;
  capture_entry_id: string | null;
  reversal_entry_id: string | null;
  hold_released: number;
  deemed_step: AdapterStep | null;
  deemed_polls: number;
  park_count: number;
  review_from: TxnState | null;
  failure_code: string | null;
  failure_message: string | null;
  version: number;
  fence: number;
  lease_owner: string | null;
  lease_until: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function toTxn(r: TxnRow): Txn {
  return {
    id: r.id,
    rrn: r.rrn,
    payerUserId: r.payer_user_id,
    payerVpa: r.payer_vpa,
    payerBank: r.payer_bank,
    payerAccount: r.payer_account,
    payeeUserId: r.payee_user_id,
    payeeVpa: r.payee_vpa,
    payeeBank: r.payee_bank,
    payeeAccount: r.payee_account,
    payeeName: r.payee_name,
    amount: r.amount,
    note: r.note,
    state: r.state,
    holdTtlSeconds: r.hold_ttl_seconds,
    holdId: r.hold_id,
    creditEntryId: r.credit_entry_id,
    captureEntryId: r.capture_entry_id,
    reversalEntryId: r.reversal_entry_id,
    holdReleased: r.hold_released === 1,
    deemedStep: r.deemed_step,
    deemedPolls: r.deemed_polls,
    parkCount: r.park_count,
    reviewFrom: r.review_from,
    failureCode: r.failure_code,
    failureMessage: r.failure_message,
    version: r.version,
    fence: r.fence,
    leaseOwner: r.lease_owner,
    leaseUntil: r.lease_until,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

export interface TxnPatch {
  holdId?: string | null;
  creditEntryId?: string | null;
  captureEntryId?: string | null;
  reversalEntryId?: string | null;
  holdReleased?: boolean;
  deemedStep?: AdapterStep | null;
  deemedPolls?: number;
  parkCount?: number;
  reviewFrom?: TxnState | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  nextRunAt?: string;
}

const PATCH_COLUMNS: Record<keyof TxnPatch, string> = {
  holdId: 'hold_id',
  creditEntryId: 'credit_entry_id',
  captureEntryId: 'capture_entry_id',
  reversalEntryId: 'reversal_entry_id',
  holdReleased: 'hold_released',
  deemedStep: 'deemed_step',
  deemedPolls: 'deemed_polls',
  parkCount: 'park_count',
  reviewFrom: 'review_from',
  failureCode: 'failure_code',
  failureMessage: 'failure_message',
  nextRunAt: 'next_run_at',
};

export class LeaseLost extends Error {
  constructor(
    readonly txnId: string,
    readonly fence: number,
  ) {
    super(`lease on ${txnId} with fence ${fence} is no longer held`);
    this.name = 'LeaseLost';
  }
}

export class OpsConflict extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpsConflict';
  }
}

export interface NewTxn {
  id: string;
  payerUserId: string;
  payerVpa: string;
  payerBank: string;
  payerAccount: string;
  payeeUserId: string | null;
  payeeVpa: string;
  payeeBank: string;
  payeeAccount: string;
  payeeName: string;
  amount: number;
  note: string | null;
  holdTtlSeconds: number;
}

export interface StepRecord {
  id: number;
  step: SagaStep;
  bankCode: string | null;
  attempt: number;
  fence: number;
  owner: string;
  status: 'STARTED' | OutcomeKind;
  httpStatus: number | null;
  code: string | null;
  request: unknown;
  response: unknown;
  startedAt: string;
  finishedAt: string | null;
}

const TERMINAL_SQL = TERMINAL_STATES.map((s) => `'${s}'`).join(', ');

function parseJson(value: string | null): unknown {
  return value === null ? null : (JSON.parse(value) as unknown);
}

export class SwitchStore {
  constructor(
    readonly db: Db,
    private readonly clock: Clock,
  ) {}

  now(): string {
    return this.clock.now().toISOString();
  }

  private later(ms: number): string {
    return new Date(this.clock.now().getTime() + ms).toISOString();
  }

  createTxn(input: NewTxn, events: (txn: Txn) => OutgoingEvent[]): Txn {
    return tx(this.db, () => {
      const now = this.now();
      const rrn = nextRrn(this.db, this.clock.now());
      this.db
        .prepare(
          `INSERT INTO txns (id, rrn, payer_user_id, payer_vpa, payer_bank, payer_account, payee_user_id, payee_vpa, payee_bank, payee_account, payee_name,
             amount, note, state, hold_ttl_seconds, next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIATED', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          rrn,
          input.payerUserId,
          input.payerVpa,
          input.payerBank,
          input.payerAccount,
          input.payeeUserId,
          input.payeeVpa,
          input.payeeBank,
          input.payeeAccount,
          input.payeeName,
          input.amount,
          input.note,
          input.holdTtlSeconds,
          now,
          now,
          now,
        );
      const txn = this.get(input.id)!;
      for (const e of events(txn)) emit(this.db, e, this.clock);
      return txn;
    });
  }

  get(id: string): Txn | null {
    const r = this.db.prepare('SELECT * FROM txns WHERE id = ?').get(id) as TxnRow | undefined;
    return r ? toTxn(r) : null;
  }

  mustGet(id: string): Txn {
    const t = this.get(id);
    if (!t) throw new Error(`txn ${id} not found`);
    return t;
  }

  acquireLease(id: string, owner: string, leaseMs: number): number | null {
    const now = this.now();
    const row = this.db
      .prepare(
        `UPDATE txns SET lease_owner = ?, lease_until = ?, fence = fence + 1
         WHERE id = ? AND state NOT IN (${TERMINAL_SQL}) AND (lease_owner IS NULL OR lease_until <= ?)
         RETURNING fence`,
      )
      .get(owner, this.later(leaseMs), id, now) as { fence: number } | undefined;
    return row ? row.fence : null;
  }

  renewLease(id: string, owner: string, fence: number, leaseMs: number): void {
    const r = this.db.prepare('UPDATE txns SET lease_until = ? WHERE id = ? AND fence = ? AND lease_owner = ?').run(this.later(leaseMs), id, fence, owner);
    if (r.changes === 0) throw new LeaseLost(id, fence);
  }

  releaseLease(id: string, owner: string, fence: number): void {
    this.db.prepare('UPDATE txns SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND fence = ? AND lease_owner = ?').run(id, fence, owner);
  }

  private assertFence(id: string, fence: number, owner: string): void {
    const ok = this.db.prepare('SELECT 1 FROM txns WHERE id = ? AND fence = ? AND lease_owner = ?').get(id, fence, owner);
    if (!ok) throw new LeaseLost(id, fence);
  }

  stepStarted(txnId: string, step: SagaStep, bankCode: string | null, fence: number, owner: string, request: unknown): { id: number; attempt: number } {
    return tx(this.db, () => {
      this.assertFence(txnId, fence, owner);
      const attempt = (this.db.prepare('SELECT COUNT(*) FROM saga_steps WHERE txn_id = ? AND step = ?').pluck().get(txnId, step) as number) + 1;
      const r = this.db
        .prepare(
          "INSERT INTO saga_steps (txn_id, step, bank_code, attempt, fence, owner, status, request, started_at) VALUES (?, ?, ?, ?, ?, ?, 'STARTED', ?, ?)",
        )
        .run(txnId, step, bankCode, attempt, fence, owner, request === undefined ? null : JSON.stringify(request), this.now());
      return { id: Number(r.lastInsertRowid), attempt };
    });
  }

  stepFinished(
    txnId: string,
    stepId: number,
    fence: number,
    owner: string,
    result: { status: OutcomeKind; httpStatus: number | null; code: string | null; response: unknown },
  ): void {
    tx(this.db, () => {
      this.assertFence(txnId, fence, owner);
      this.db
        .prepare("UPDATE saga_steps SET status = ?, http_status = ?, code = ?, response = ?, finished_at = ? WHERE id = ? AND status = 'STARTED'")
        .run(result.status, result.httpStatus, result.code, result.response === undefined ? null : JSON.stringify(result.response), this.now(), stepId);
    });
  }

  mayHaveHappened(txnId: string, step: SagaStep): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM saga_steps WHERE txn_id = ? AND step = ? AND status IN ('STARTED', 'UNKNOWN') LIMIT 1").get(txnId, step));
  }

  transition(
    txnId: string,
    fence: number,
    owner: string,
    from: TxnState,
    to: TxnState,
    patch: TxnPatch,
    reason: string | null,
    events: OutgoingEvent[],
  ): Txn {
    assertTransition(from, to);
    return tx(this.db, () => {
      const now = this.now();
      const sets = ['state = ?', 'version = version + 1', 'updated_at = ?'];
      const values: unknown[] = [to, now];
      const fullPatch: TxnPatch = { nextRunAt: now, ...patch };
      for (const [k, v] of Object.entries(fullPatch) as [keyof TxnPatch, unknown][]) {
        sets.push(`${PATCH_COLUMNS[k]} = ?`);
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (TERMINAL_STATES.includes(to)) {
        sets.push('finished_at = ?');
        values.push(now);
      } else {
        sets.push('finished_at = NULL');
      }
      const r = this.db
        .prepare(`UPDATE txns SET ${sets.join(', ')} WHERE id = ? AND fence = ? AND lease_owner = ? AND state = ?`)
        .run(...values, txnId, fence, owner, from);
      if (r.changes === 0) throw new LeaseLost(txnId, fence);
      this.db
        .prepare('INSERT INTO txn_transitions (txn_id, from_state, to_state, reason, fence, owner, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(txnId, from, to, reason, fence, owner, now);
      for (const e of events) emit(this.db, e, this.clock);
      return this.mustGet(txnId);
    });
  }

  update(txnId: string, fence: number, owner: string, patch: TxnPatch): Txn {
    return tx(this.db, () => {
      const sets = ['version = version + 1', 'updated_at = ?'];
      const values: unknown[] = [this.now()];
      for (const [k, v] of Object.entries(patch) as [keyof TxnPatch, unknown][]) {
        sets.push(`${PATCH_COLUMNS[k]} = ?`);
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      const r = this.db.prepare(`UPDATE txns SET ${sets.join(', ')} WHERE id = ? AND fence = ? AND lease_owner = ?`).run(...values, txnId, fence, owner);
      if (r.changes === 0) throw new LeaseLost(txnId, fence);
      return this.mustGet(txnId);
    });
  }

  runnable(limit: number): string[] {
    const now = this.now();
    return this.db
      .prepare(
        `SELECT id FROM txns WHERE state NOT IN (${TERMINAL_SQL}) AND next_run_at <= ? AND (lease_owner IS NULL OR lease_until <= ?)
         ORDER BY next_run_at LIMIT ?`,
      )
      .pluck()
      .all(now, now, limit) as string[];
  }

  nonTerminalCount(): number {
    return this.db.prepare(`SELECT COUNT(*) FROM txns WHERE state NOT IN (${TERMINAL_SQL})`).pluck().get() as number;
  }

  steps(txnId: string): StepRecord[] {
    const rows = this.db.prepare('SELECT * FROM saga_steps WHERE txn_id = ? ORDER BY id').all(txnId) as {
      id: number;
      step: SagaStep;
      bank_code: string | null;
      attempt: number;
      fence: number;
      owner: string;
      status: StepRecord['status'];
      http_status: number | null;
      code: string | null;
      request: string | null;
      response: string | null;
      started_at: string;
      finished_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      step: r.step,
      bankCode: r.bank_code,
      attempt: r.attempt,
      fence: r.fence,
      owner: r.owner,
      status: r.status,
      httpStatus: r.http_status,
      code: r.code,
      request: parseJson(r.request),
      response: parseJson(r.response),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  transitions(txnId: string) {
    return this.db
      .prepare('SELECT from_state AS "from", to_state AS "to", reason, fence, owner, at FROM txn_transitions WHERE txn_id = ? ORDER BY id')
      .all(txnId) as { from: TxnState; to: TxnState; reason: string | null; fence: number; owner: string; at: string }[];
  }

  listForUser(userId: string, limit: number): Txn[] {
    return (
      this.db
        .prepare('SELECT * FROM txns WHERE payer_user_id = ? OR payee_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(userId, userId, limit) as TxnRow[]
    ).map(toTxn);
  }

  listByState(state: TxnState | null, limit: number): Txn[] {
    const rows = state
      ? (this.db.prepare('SELECT * FROM txns WHERE state = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(state, limit) as TxnRow[])
      : (this.db.prepare('SELECT * FROM txns ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as TxnRow[]);
    return rows.map(toTxn);
  }

  countsByState(): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM txns GROUP BY state').all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  finishedSince(sinceIso: string): { state: TxnState; createdAt: string; finishedAt: string }[] {
    return this.db
      .prepare("SELECT state, created_at AS createdAt, finished_at AS finishedAt FROM txns WHERE finished_at IS NOT NULL AND finished_at >= ?")
      .all(sinceIso) as { state: TxnState; createdAt: string; finishedAt: string }[];
  }

  stepOutcomeCounts(sinceIso: string): { bankCode: string; step: string; status: string; n: number }[] {
    return this.db
      .prepare(
        `SELECT bank_code AS bankCode, step, status, COUNT(*) AS n FROM saga_steps
         WHERE bank_code IS NOT NULL AND started_at >= ? GROUP BY bank_code, step, status ORDER BY bank_code, step, status`,
      )
      .all(sinceIso) as { bankCode: string; step: string; status: string; n: number }[];
  }

  consumeMpinToken(jti: string, userId: string, txnId: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO used_mpin_tokens (jti, user_id, txn_id, used_at) VALUES (?, ?, ?, ?)').run(jti, userId, txnId, this.now());
    return r.changes === 1;
  }

  opsTransition(
    txnId: string,
    input: { action: 'RETRY' | 'REVERSE'; staffId: string; reason: string; to: TxnState; patch: TxnPatch; events: (t: Txn) => OutgoingEvent[] },
  ): Txn {
    return tx(this.db, () => {
      const t = this.mustGet(txnId);
      if (t.state !== 'MANUAL_REVIEW') throw new OpsConflict('TXN_NOT_IN_REVIEW', `transaction is ${t.state}, not MANUAL_REVIEW`);
      assertTransition(t.state, input.to);
      const now = this.now();
      const owner = `ops:${input.staffId}`;
      const sets = ['state = ?', 'fence = fence + 1', 'lease_owner = NULL', 'lease_until = NULL', 'version = version + 1', 'updated_at = ?', 'finished_at = NULL'];
      const values: unknown[] = [input.to, now];
      for (const [k, v] of Object.entries({ nextRunAt: now, ...input.patch }) as [keyof TxnPatch, unknown][]) {
        sets.push(`${PATCH_COLUMNS[k]} = ?`);
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      this.db.prepare(`UPDATE txns SET ${sets.join(', ')} WHERE id = ? AND state = 'MANUAL_REVIEW'`).run(...values, txnId);
      const fence = this.db.prepare('SELECT fence FROM txns WHERE id = ?').pluck().get(txnId) as number;
      this.db
        .prepare('INSERT INTO txn_transitions (txn_id, from_state, to_state, reason, fence, owner, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(txnId, t.state, input.to, `${input.action}: ${input.reason}`, fence, owner, now);
      this.db
        .prepare('INSERT INTO ops_actions (id, txn_id, action, staff_id, reason, from_state, to_state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId('opa'), txnId, input.action, input.staffId, input.reason, t.state, input.to, now);
      for (const e of input.events(t)) emit(this.db, e, this.clock);
      return this.mustGet(txnId);
    });
  }

  opsActions(txnId: string) {
    return this.db
      .prepare('SELECT id, action, staff_id AS staffId, reason, from_state AS "from", to_state AS "to", at FROM ops_actions WHERE txn_id = ? ORDER BY at, id')
      .all(txnId);
  }
}
