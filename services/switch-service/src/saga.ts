import { type AdapterStep, EVENT_TYPES, TOPICS, type TxnState } from '@kosh/contracts';
import type { Clock, Logger, OutgoingEvent } from '@kosh/service-kit';
import type { BankPort } from './banks.ts';
import { classifyError, type OutcomeKind, type StepFailure } from './classify.ts';
import type { SwitchConfig } from './config.ts';
import { isTerminal } from './machine.ts';
import { backoffMs, type BankGuards, type Random } from './resilience.ts';
import { LeaseLost, type SagaStep, type SwitchStore, type Txn, type TxnPatch } from './store.ts';

export interface RiskDecision {
  decision: 'ALLOW';
  score: number;
}

export interface RiskPort {
  assess(txn: Txn): Promise<RiskDecision>;
}

export const allowAllRisk: RiskPort = {
  assess: async () => ({ decision: 'ALLOW', score: 0 }),
};

export class CrashSignal extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashSignal';
  }
}

export type CrashHook = (point: string, txn: Txn) => void;

export interface EngineDeps {
  store: SwitchStore;
  banks: BankPort;
  risk: RiskPort;
  guards: BankGuards;
  clock: Clock;
  log: Logger;
  config: SwitchConfig;
  owner: string;
  sleep: (ms: number) => Promise<void>;
  random: Random;
  crash?: CrashHook;
}

type CallOutcome =
  | { kind: 'OK'; response: Record<string, unknown> }
  | { kind: 'BUSINESS'; httpStatus: number | null; code: string; message: string }
  | { kind: 'MISMATCH'; httpStatus: number | null; code: string; message: string }
  | { kind: 'EXHAUSTED'; mayHaveHappened: boolean; last: StepFailure };

type ForwardStep = 'hold' | 'credit' | 'capture';

const FORWARD: Record<ForwardStep, { from: TxnState; ok: TxnState; business: TxnState }> = {
  hold: { from: 'RISK_PASSED', ok: 'DEBIT_HELD', business: 'DEBIT_FAILED' },
  credit: { from: 'DEBIT_HELD', ok: 'CREDITED', business: 'CREDIT_FAILED' },
  capture: { from: 'CREDITED', ok: 'COMPLETED', business: 'REVERSING' },
};

const FINISH_EVENTS: Partial<Record<TxnState, string>> = {
  COMPLETED: EVENT_TYPES.TxnCompleted,
  DEBIT_FAILED: EVENT_TYPES.TxnFailed,
  REVERSED: EVENT_TYPES.TxnReversed,
  DEEMED: EVENT_TYPES.TxnDeemed,
  MANUAL_REVIEW: EVENT_TYPES.TxnManualReview,
};

export function stepBank(txn: Txn, step: AdapterStep): string {
  return step === 'credit' || step === 'reverse' ? txn.payeeBank : txn.payerBank;
}

export function stepRequest(txn: Txn, step: AdapterStep): Record<string, unknown> {
  switch (step) {
    case 'hold':
      return { txnId: txn.id, accountId: txn.payerAccount, amount: txn.amount, ttlSeconds: txn.holdTtlSeconds };
    case 'credit':
      return { txnId: txn.id, accountId: txn.payeeAccount, amount: txn.amount, description: `UPI ${txn.rrn} from ${txn.payerVpa}`.slice(0, 200) };
    case 'capture':
    case 'release':
      if (!txn.holdId) throw new Error(`${step} needs a hold id on ${txn.id}`);
      return { txnId: txn.id, holdId: txn.holdId };
    case 'reverse':
      if (!txn.creditEntryId) throw new Error(`reverse needs a credit entry id on ${txn.id}`);
      return { txnId: txn.id, entryId: txn.creditEntryId, reason: `UPI ${txn.rrn} reversal` };
  }
}

export function transitionEvents(txn: Txn, to: TxnState, step: SagaStep | null, code: string | null): OutgoingEvent[] {
  const bankCode = step && step !== 'risk' && step !== 'inquiry' ? stepBank(txn, step) : null;
  const events: OutgoingEvent[] = [
    {
      topic: TOPICS.switch,
      type: EVENT_TYPES.TxnStepCompleted,
      key: txn.id,
      payload: { txnId: txn.id, rrn: txn.rrn, from: txn.state, to, step, bankCode },
    },
  ];
  const finish = FINISH_EVENTS[to];
  if (finish) {
    events.push({
      topic: TOPICS.switch,
      type: finish,
      key: txn.id,
      payload: { txnId: txn.id, rrn: txn.rrn, state: to, amount: txn.amount, payerBank: txn.payerBank, payeeBank: txn.payeeBank, code },
    });
  }
  return events;
}

export interface EngineStats {
  drives: number;
  transitions: number;
  leaseLost: number;
  parked: number;
  unexpectedErrors: number;
  outcomes: Record<string, Record<OutcomeKind, number>>;
}

function emptyOutcomes(): Record<OutcomeKind, number> {
  return { OK: 0, BUSINESS: 0, TRANSIENT: 0, UNKNOWN: 0, MISMATCH: 0 };
}

export class SagaEngine {
  private readonly inflight = new Set<string>();
  readonly stats: EngineStats = { drives: 0, transitions: 0, leaseLost: 0, parked: 0, unexpectedErrors: 0, outcomes: {} };

  constructor(private readonly deps: EngineDeps) {}

  get owner(): string {
    return this.deps.owner;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  isDriving(txnId: string): boolean {
    return this.inflight.has(txnId);
  }

  async drive(txnId: string): Promise<Txn | null> {
    if (this.inflight.has(txnId)) return null;
    this.inflight.add(txnId);
    try {
      const { store, owner, config, log } = this.deps;
      const fence = store.acquireLease(txnId, owner, config.leaseMs);
      if (fence === null) return null;
      this.stats.drives++;
      try {
        await this.run(txnId, fence);
      } catch (err) {
        if (err instanceof CrashSignal) throw err;
        if (err instanceof LeaseLost) {
          this.stats.leaseLost++;
          log.warn('saga lease lost; another switch instance owns this transaction now', { txnId, fence });
          return store.get(txnId);
        }
        this.stats.unexpectedErrors++;
        log.error('saga step failed unexpectedly; parking for recovery', { txnId, err: err as Error });
        this.tryPark(txnId, fence);
      }
      store.releaseLease(txnId, owner, fence);
      return store.get(txnId);
    } finally {
      this.inflight.delete(txnId);
    }
  }

  private tryPark(txnId: string, fence: number): void {
    try {
      const t = this.deps.store.mustGet(txnId);
      this.park(t, fence);
    } catch (err) {
      this.deps.log.warn('could not park transaction', { txnId, err: err as Error });
    }
  }

  private async run(txnId: string, fence: number): Promise<void> {
    const { store, owner, config } = this.deps;
    for (let round = 0; round < 64; round++) {
      const t = store.mustGet(txnId);
      if (isTerminal(t.state) || t.nextRunAt > store.now()) return;
      store.renewLease(txnId, owner, fence, config.leaseMs);
      await this.advance(t, fence);
    }
  }

  private crash(point: string, txn: Txn): void {
    this.deps.crash?.(point, txn);
  }

  private move(t: Txn, fence: number, to: TxnState, patch: TxnPatch, step: SagaStep | null, reason: string | null): Txn {
    const next = this.deps.store.transition(t.id, fence, this.deps.owner, t.state, to, patch, reason, transitionEvents(t, to, step, patch.failureCode ?? null));
    this.stats.transitions++;
    this.crash(`after:${to}`, next);
    return next;
  }

  private park(t: Txn, fence: number): void {
    const { store, owner, config, random } = this.deps;
    const parkCount = t.parkCount + 1;
    const delay = backoffMs(parkCount, config.parkBaseMs, config.parkCapMs, random);
    store.update(t.id, fence, owner, { parkCount, nextRunAt: new Date(this.deps.clock.now().getTime() + delay).toISOString() });
    this.stats.parked++;
  }

  private review(t: Txn, fence: number, step: SagaStep | null, code: string, message: string): void {
    const level = code === 'ADAPTER_REQUEST_MISMATCH' ? 'error' : 'warn';
    this.deps.log[level]('saga sent to manual review', { txnId: t.id, state: t.state, step, code, message });
    this.move(t, fence, 'MANUAL_REVIEW', { reviewFrom: t.state, failureCode: code, failureMessage: message }, step, code);
  }

  private deem(t: Txn, fence: number, step: ForwardStep, last: StepFailure): void {
    const nextRunAt = new Date(this.deps.clock.now().getTime() + this.deps.config.deemedPollMs).toISOString();
    this.move(t, fence, 'DEEMED', { deemedStep: step, deemedPolls: 0, failureCode: last.code, failureMessage: last.message, nextRunAt }, step, last.code);
  }

  private async advance(t: Txn, fence: number): Promise<void> {
    switch (t.state) {
      case 'INITIATED':
        return this.assessRisk(t, fence);
      case 'RISK_PASSED':
        return this.forward(t, fence, 'hold');
      case 'DEBIT_HELD':
        return this.forward(t, fence, 'credit');
      case 'CREDITED':
        return this.forward(t, fence, 'capture');
      case 'CREDIT_FAILED':
        this.move(t, fence, 'REVERSING', {}, null, t.failureCode);
        return;
      case 'REVERSING':
        return this.compensate(t, fence);
      case 'DEEMED':
        return this.resolveDeemed(t, fence);
      default:
        return;
    }
  }

  private async assessRisk(t: Txn, fence: number): Promise<void> {
    const { store, owner, risk } = this.deps;
    const started = store.stepStarted(t.id, 'risk', null, fence, owner, { amount: t.amount });
    const decision = await risk.assess(t);
    store.stepFinished(t.id, started.id, fence, owner, { status: 'OK', httpStatus: null, code: decision.decision, response: decision });
    this.move(t, fence, 'RISK_PASSED', {}, 'risk', null);
  }

  private okPatch(step: ForwardStep, response: Record<string, unknown>): TxnPatch {
    const clearDeemed: TxnPatch = { deemedStep: null, deemedPolls: 0, parkCount: 0 };
    if (step === 'hold') return { ...clearDeemed, holdId: String(response.holdId), failureCode: null, failureMessage: null };
    if (step === 'credit') return { ...clearDeemed, creditEntryId: String(response.entryId), failureCode: null, failureMessage: null };
    return { ...clearDeemed, captureEntryId: String(response.entryId), failureCode: null, failureMessage: null };
  }

  private applyOk(t: Txn, fence: number, step: ForwardStep, response: Record<string, unknown>): void {
    this.move(t, fence, FORWARD[step].ok, this.okPatch(step, response), step, null);
  }

  private applyBusiness(t: Txn, fence: number, step: ForwardStep, code: string, message: string): void {
    this.move(t, fence, FORWARD[step].business, { deemedStep: null, deemedPolls: 0, failureCode: code, failureMessage: message }, step, code);
  }

  private async forward(t: Txn, fence: number, step: ForwardStep): Promise<void> {
    const r = await this.callBank(t, fence, step, this.deps.config.maxAttempts);
    if (r.kind === 'OK') return this.applyOk(t, fence, step, r.response);
    if (r.kind === 'BUSINESS') return this.applyBusiness(t, fence, step, r.code, r.message);
    if (r.kind === 'MISMATCH') return this.review(t, fence, step, r.code, r.message);
    if (r.mayHaveHappened) return this.deem(t, fence, step, r.last);
    if (step === 'capture') return this.park(t, fence);
    return this.applyBusiness(t, fence, step, r.last.code, r.last.message);
  }

  private async compensate(t: Txn, fence: number): Promise<void> {
    const { store, owner } = this.deps;
    if (t.captureEntryId) return this.review(t, fence, null, 'CAPTURED_DURING_REVERSAL', 'payer hold was captured; reversal needs a person');
    if (t.creditEntryId && !t.reversalEntryId) {
      const r = await this.callBank(t, fence, 'reverse', this.deps.config.maxAttempts);
      if (r.kind === 'OK') {
        store.update(t.id, fence, owner, { reversalEntryId: String(r.response.entryId), parkCount: 0 });
        return;
      }
      if (r.kind === 'EXHAUSTED') return this.park(t, fence);
      return this.review(t, fence, 'reverse', r.code, r.message);
    }
    if (t.holdId && !t.holdReleased) {
      const r = await this.callBank(t, fence, 'release', this.deps.config.maxAttempts);
      if (r.kind === 'OK') {
        store.update(t.id, fence, owner, { holdReleased: true, parkCount: 0 });
        return;
      }
      if (r.kind === 'EXHAUSTED') return this.park(t, fence);
      return this.review(t, fence, 'release', r.code, r.message);
    }
    this.move(t, fence, 'REVERSED', { parkCount: 0 }, null, t.failureCode);
  }

  private async resolveDeemed(t: Txn, fence: number): Promise<void> {
    const { store, owner, banks, config } = this.deps;
    const step = t.deemedStep as ForwardStep | null;
    if (!step || !(step in FORWARD)) return this.review(t, fence, null, 'DEEMED_STEP_MISSING', 'deemed transaction has no pending step');
    const bank = stepBank(t, step);
    const inquiry = store.stepStarted(t.id, 'inquiry', bank, fence, owner, { step });
    let found: { status: string; response: unknown } | undefined;
    try {
      const status = await banks.status(bank, t.id, config.inquiryTimeoutMs);
      found = status.steps.find((s) => s.step === step);
      store.stepFinished(t.id, inquiry.id, fence, owner, { status: 'OK', httpStatus: 200, code: found?.status ?? 'NOT_FOUND', response: status.steps });
    } catch (err) {
      const f = classifyError(err);
      store.stepFinished(t.id, inquiry.id, fence, owner, { status: f.kind, httpStatus: f.httpStatus, code: f.code, response: { message: f.message } });
      return this.pollAgain(t, fence);
    }
    if (found?.status === 'DONE') return this.applyOk(t, fence, step, (found.response ?? {}) as Record<string, unknown>);
    if (found?.status === 'FAILED') {
      const error = (found.response as { error?: { code?: string; message?: string } } | null)?.error;
      return this.applyBusiness(t, fence, step, error?.code ?? 'BANK_DECLINED', error?.message ?? 'bank reported the step as failed');
    }
    const r = await this.callBank(t, fence, step, 1);
    if (r.kind === 'OK') return this.applyOk(t, fence, step, r.response);
    if (r.kind === 'BUSINESS') return this.applyBusiness(t, fence, step, r.code, r.message);
    if (r.kind === 'MISMATCH') return this.review(t, fence, step, r.code, r.message);
    return this.pollAgain(t, fence);
  }

  private pollAgain(t: Txn, fence: number): void {
    const { store, owner, config, clock } = this.deps;
    const polls = t.deemedPolls + 1;
    if (polls >= config.deemedMaxPolls) {
      return this.review(t, fence, t.deemedStep, 'DEEMED_UNRESOLVED', `outcome of ${t.deemedStep} still unknown after ${polls} status inquiries`);
    }
    store.update(t.id, fence, owner, { deemedPolls: polls, nextRunAt: new Date(clock.now().getTime() + config.deemedPollMs).toISOString() });
  }

  private recordOutcome(bank: string, kind: OutcomeKind): void {
    const byBank = (this.stats.outcomes[bank] ??= emptyOutcomes());
    byBank[kind]++;
  }

  private async callBank(t: Txn, fence: number, step: AdapterStep, maxAttempts: number): Promise<CallOutcome> {
    const { store, owner, config, guards, banks, sleep, random } = this.deps;
    const bank = stepBank(t, step);
    const body = stepRequest(t, step);
    let last: StepFailure = { kind: 'TRANSIENT', httpStatus: null, code: 'NOT_ATTEMPTED', message: 'no attempt was made' };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(backoffMs(attempt - 1, config.retryBaseMs, config.retryCapMs, random));
      store.renewLease(t.id, owner, fence, config.leaseMs);
      const started = store.stepStarted(t.id, step, bank, fence, owner, body);
      this.crash(`${step}:before-call`, t);
      const guard = guards.for(bank);
      let response: Record<string, unknown> | null = null;
      let failure: StepFailure | null = null;
      if (!guard.bulkhead.tryEnter()) {
        failure = { kind: 'TRANSIENT', httpStatus: null, code: 'BULKHEAD_FULL', message: `too many concurrent calls to ${bank}` };
      } else if (!guard.breaker.tryAcquire()) {
        guard.bulkhead.leave();
        failure = { kind: 'TRANSIENT', httpStatus: null, code: 'CIRCUIT_OPEN', message: `circuit to ${bank} is open` };
      } else {
        try {
          response = await banks.call(bank, step, body, config.stepTimeoutMs);
          guard.breaker.onSuccess();
        } catch (err) {
          failure = classifyError(err);
          if (failure.kind === 'TRANSIENT' || failure.kind === 'UNKNOWN') guard.breaker.onFailure();
          else guard.breaker.onSuccess();
        } finally {
          guard.bulkhead.leave();
        }
      }
      this.crash(`${step}:after-call`, t);
      const kind: OutcomeKind = failure ? failure.kind : 'OK';
      this.recordOutcome(bank, kind);
      store.stepFinished(t.id, started.id, fence, owner, {
        status: kind,
        httpStatus: failure ? failure.httpStatus : 200,
        code: failure ? failure.code : null,
        response: failure ? { code: failure.code, message: failure.message } : response,
      });
      if (!failure && response) return { kind: 'OK', response };
      if (failure?.kind === 'BUSINESS') return { kind: 'BUSINESS', httpStatus: failure.httpStatus, code: failure.code, message: failure.message };
      if (failure?.kind === 'MISMATCH') return { kind: 'MISMATCH', httpStatus: failure.httpStatus, code: failure.code, message: failure.message };
      if (failure) last = failure;
    }
    return { kind: 'EXHAUSTED', mayHaveHappened: store.mayHaveHappened(t.id, step), last };
  }
}
