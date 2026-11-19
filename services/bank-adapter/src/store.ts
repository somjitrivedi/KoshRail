import type { AdapterStep, FaultMode } from '@kosh/contracts';
import { type Clock, conflict, type Db, sha256, stableStringify, tx } from '@kosh/service-kit';

export interface StoredStep {
  status: 'IN_PROGRESS' | 'DONE' | 'FAILED';
  httpStatus: number | null;
  response: unknown;
  attempts: number;
}

export interface FaultRule {
  op: string;
  mode: FaultMode;
  latencyMs: number;
  errorRate: number;
  remaining: number | null;
}

interface RequestRow {
  request_hash: string;
  status: StoredStep['status'];
  http_status: number | null;
  response: string | null;
  attempts: number;
}

export class AdapterStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private now(): string {
    return this.clock.now().toISOString();
  }

  begin(bank: string, txnId: string, step: AdapterStep, request: unknown): { replay: StoredStep | null } {
    const hash = sha256(stableStringify(request));
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM adapter_requests WHERE bank_code = ? AND txn_id = ? AND step = ?').get(bank, txnId, step) as RequestRow | undefined;
      if (row && row.request_hash !== hash) throw conflict('ADAPTER_REQUEST_MISMATCH', `${step} for ${txnId} was already requested with different parameters`);
      if (row && row.status !== 'IN_PROGRESS') {
        return {
          replay: { status: row.status, httpStatus: row.http_status, response: row.response ? (JSON.parse(row.response) as unknown) : null, attempts: row.attempts },
        };
      }
      if (row) {
        this.db.prepare('UPDATE adapter_requests SET attempts = attempts + 1, updated_at = ? WHERE bank_code = ? AND txn_id = ? AND step = ?').run(this.now(), bank, txnId, step);
      } else {
        this.db
          .prepare("INSERT INTO adapter_requests (bank_code, txn_id, step, request_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, ?)")
          .run(bank, txnId, step, hash, this.now(), this.now());
      }
      return { replay: null };
    });
  }

  finish(bank: string, txnId: string, step: AdapterStep, status: 'DONE' | 'FAILED', httpStatus: number, response: unknown): void {
    this.db
      .prepare('UPDATE adapter_requests SET status = ?, http_status = ?, response = ?, updated_at = ? WHERE bank_code = ? AND txn_id = ? AND step = ?')
      .run(status, httpStatus, JSON.stringify(response), this.now(), bank, txnId, step);
  }

  steps(bank: string, txnId: string) {
    return (
      this.db
        .prepare('SELECT step, status, http_status, response, attempts, updated_at FROM adapter_requests WHERE bank_code = ? AND txn_id = ? ORDER BY created_at, step')
        .all(bank, txnId) as { step: string; status: string; http_status: number | null; response: string | null; attempts: number; updated_at: string }[]
    ).map((r) => ({
      step: r.step,
      status: r.status,
      httpStatus: r.http_status,
      response: r.response ? (JSON.parse(r.response) as unknown) : null,
      attempts: r.attempts,
      updatedAt: r.updated_at,
    }));
  }

  fault(bank: string, op: string): FaultRule | null {
    const row = this.db.prepare('SELECT * FROM fault_rules WHERE bank_code = ? AND op = ?').get(bank, op) as
      | { op: string; mode: FaultMode; latency_ms: number; error_rate: number; remaining: number | null }
      | undefined;
    if (!row || row.mode === 'NONE') return null;
    if (row.remaining !== null && row.remaining <= 0) return null;
    return { op: row.op, mode: row.mode, latencyMs: row.latency_ms, errorRate: row.error_rate, remaining: row.remaining };
  }

  consumeFault(bank: string, op: string): void {
    this.db.prepare('UPDATE fault_rules SET remaining = remaining - 1 WHERE bank_code = ? AND op = ? AND remaining IS NOT NULL AND remaining > 0').run(bank, op);
  }

  setFault(bank: string, rule: FaultRule): void {
    this.db
      .prepare(
        `INSERT INTO fault_rules (bank_code, op, mode, latency_ms, error_rate, remaining, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bank_code, op) DO UPDATE SET mode = excluded.mode, latency_ms = excluded.latency_ms, error_rate = excluded.error_rate,
           remaining = excluded.remaining, updated_at = excluded.updated_at`,
      )
      .run(bank, rule.op, rule.mode, rule.latencyMs, rule.errorRate, rule.remaining, this.now());
  }

  listFaults(bank: string): FaultRule[] {
    return (
      this.db.prepare('SELECT op, mode, latency_ms, error_rate, remaining FROM fault_rules WHERE bank_code = ? ORDER BY op').all(bank) as {
        op: string;
        mode: FaultMode;
        latency_ms: number;
        error_rate: number;
        remaining: number | null;
      }[]
    ).map((r) => ({ op: r.op, mode: r.mode, latencyMs: r.latency_ms, errorRate: r.error_rate, remaining: r.remaining }));
  }

  clearFaults(bank: string): number {
    return this.db.prepare('DELETE FROM fault_rules WHERE bank_code = ?').run(bank).changes;
  }
}
