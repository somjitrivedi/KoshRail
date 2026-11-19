import { EVENT_TYPES, TOPICS, type TxnState } from '@kosh/contracts';
import { type Clock, conflict, notFound, unavailable } from '@kosh/service-kit';
import type { BankPort } from './banks.ts';
import type { SwitchConfig } from './config.ts';
import { customerStatus } from './machine.ts';
import type { BankGuards } from './resilience.ts';
import { type SagaEngine, stepBank } from './saga.ts';
import { OpsConflict, type SwitchStore, type Txn, type TxnPatch } from './store.ts';

export function opsView(t: Txn) {
  return {
    id: t.id,
    rrn: t.rrn,
    state: t.state,
    status: customerStatus(t.state),
    amount: t.amount,
    payer: { userId: t.payerUserId, vpa: t.payerVpa, bankCode: t.payerBank, accountId: t.payerAccount },
    payee: { userId: t.payeeUserId, vpa: t.payeeVpa, bankCode: t.payeeBank, accountId: t.payeeAccount, name: t.payeeName },
    note: t.note,
    holdId: t.holdId,
    creditEntryId: t.creditEntryId,
    captureEntryId: t.captureEntryId,
    reversalEntryId: t.reversalEntryId,
    holdReleased: t.holdReleased,
    deemedStep: t.deemedStep,
    deemedPolls: t.deemedPolls,
    parkCount: t.parkCount,
    reviewFrom: t.reviewFrom,
    failureCode: t.failureCode,
    failureMessage: t.failureMessage,
    fence: t.fence,
    leaseOwner: t.leaseOwner,
    leaseUntil: t.leaseUntil,
    nextRunAt: t.nextRunAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    finishedAt: t.finishedAt,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface OpsDeps {
  store: SwitchStore;
  engine: SagaEngine;
  banks: BankPort;
  guards: BankGuards;
  clock: Clock;
  config: SwitchConfig;
}

export class OpsService {
  constructor(private readonly deps: OpsDeps) {}

  private find(id: string): Txn {
    const t = this.deps.store.get(id);
    if (!t) throw notFound('TXN_NOT_FOUND', 'transaction not found');
    return t;
  }

  async detail(id: string, inquire: boolean) {
    const { store, banks, config } = this.deps;
    const t = this.find(id);
    const detail = { txn: opsView(t), steps: store.steps(id), transitions: store.transitions(id), opsActions: store.opsActions(id) };
    if (!inquire) return detail;
    const bankCodes = [...new Set([stepBank(t, 'hold'), stepBank(t, 'credit')])];
    const inquiries = await Promise.all(
      bankCodes.map(async (bankCode) => {
        try {
          return { bankCode, ok: true, status: await banks.status(bankCode, id, config.inquiryTimeoutMs) };
        } catch (err) {
          return { bankCode, ok: false, error: (err as Error).message };
        }
      }),
    );
    return { ...detail, inquiries };
  }

  private act(id: string, action: 'RETRY' | 'REVERSE', staffId: string, reason: string, to: TxnState, patch: TxnPatch): Txn {
    try {
      const t = this.deps.store.opsTransition(id, {
        action,
        staffId,
        reason,
        to,
        patch,
        events: (before) => [
          {
            topic: TOPICS.switch,
            type: EVENT_TYPES.TxnStepCompleted,
            key: before.id,
            payload: { txnId: before.id, rrn: before.rrn, from: before.state, to, step: null, bankCode: null, opsAction: action, staffId },
          },
        ],
      });
      void this.deps.engine.drive(id).catch(() => undefined);
      return t;
    } catch (err) {
      if (err instanceof OpsConflict) throw conflict(err.code, err.message);
      throw err;
    }
  }

  retry(id: string, staffId: string, reason: string): Txn {
    const t = this.find(id);
    if (t.state !== 'MANUAL_REVIEW') throw conflict('TXN_NOT_IN_REVIEW', `transaction is ${t.state}, not MANUAL_REVIEW`);
    if (!t.reviewFrom) throw conflict('REVIEW_ORIGIN_UNKNOWN', 'transaction has no recorded state to resume from');
    return this.act(id, 'RETRY', staffId, reason, t.reviewFrom, { reviewFrom: null, parkCount: 0, deemedPolls: 0 });
  }

  async reverse(id: string, staffId: string, reason: string): Promise<Txn> {
    const t = this.find(id);
    if (t.state !== 'MANUAL_REVIEW') throw conflict('TXN_NOT_IN_REVIEW', `transaction is ${t.state}, not MANUAL_REVIEW`);
    if (t.captureEntryId) throw conflict('TXN_ALREADY_CAPTURED', 'payer money was already captured; this payment cannot be reversed by the switch');
    if (t.reviewFrom === 'DEEMED' && t.deemedStep) {
      const bank = stepBank(t, t.deemedStep);
      let status;
      try {
        status = await this.deps.banks.status(bank, id, this.deps.config.inquiryTimeoutMs);
      } catch {
        throw unavailable('BANK_INQUIRY_FAILED', `cannot confirm the ${t.deemedStep} outcome at ${bank}; try again when the bank answers`);
      }
      const pending = status.steps.find((s) => s.step === t.deemedStep);
      if (pending?.status === 'DONE') {
        throw conflict('DEEMED_STEP_SUCCEEDED', `${bank} reports the ${t.deemedStep} as done; use retry so the payment completes instead`);
      }
      if (pending?.status === 'IN_PROGRESS') {
        throw conflict('DEEMED_STEP_IN_PROGRESS', `${bank} is still processing the ${t.deemedStep}; wait and inquire again`);
      }
    }
    return this.act(id, 'REVERSE', staffId, reason, 'REVERSING', { reviewFrom: null, deemedStep: null, deemedPolls: 0, parkCount: 0 });
  }

  metrics(windowMinutes: number) {
    const { store, engine, guards, clock } = this.deps;
    const since = new Date(clock.now().getTime() - windowMinutes * 60000).toISOString();
    const finished = store.finishedSince(since);
    const count = (s: TxnState) => finished.filter((f) => f.state === s).length;
    const completed = count('COMPLETED');
    const failed = count('DEBIT_FAILED') + count('REVERSED');
    const latencies = finished
      .filter((f) => f.state === 'COMPLETED')
      .map((f) => Date.parse(f.finishedAt) - Date.parse(f.createdAt))
      .sort((a, b) => a - b);
    return {
      at: clock.now().toISOString(),
      owner: engine.owner,
      states: store.countsByState(),
      inFlight: store.nonTerminalCount(),
      window: {
        minutes: windowMinutes,
        finished: finished.length,
        completed,
        debitFailed: count('DEBIT_FAILED'),
        reversed: count('REVERSED'),
        manualReview: count('MANUAL_REVIEW'),
        successRate: completed + failed === 0 ? null : Math.round((completed / (completed + failed)) * 10000) / 10000,
      },
      latencyMs: { count: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies.at(-1) ?? null },
      bankOutcomes: store.stepOutcomeCounts(since),
      breakers: guards.snapshot(),
      engine: { ...engine.stats, driving: engine.inflightCount },
    };
  }
}
