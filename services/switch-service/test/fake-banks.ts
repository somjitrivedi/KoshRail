import type { AdapterStep } from '@kosh/contracts';
import { AppError, type Clock, sha256, stableStringify } from '@kosh/service-kit';
import type { BankPort, BankStatus } from '../src/banks.ts';

export type FakeFault = 'ERROR' | 'REFUSED' | 'TIMEOUT_BEFORE' | 'TIMEOUT_AFTER_COMMIT' | 'DROP_AFTER_COMMIT';

interface Account {
  bank: string;
  balance: number;
  held: number;
  closed: boolean;
}

interface Hold {
  id: string;
  bank: string;
  accountId: string;
  amount: number;
  status: 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED';
  expiresAt: number;
  txnId: string;
  captureEntryId: string | null;
}

interface Entry {
  id: string;
  bank: string;
  txnId: string;
  kind: 'CREDIT' | 'HOLD_CAPTURE' | 'REVERSAL';
  postings: { accountId: string; amount: number }[];
  reversedBy: string | null;
}

interface StoredRequest {
  hash: string;
  status: 'DONE' | 'FAILED';
  httpStatus: number;
  response: unknown;
}

export interface CallLog {
  bank: string;
  step: AdapterStep;
  txnId: string;
  executed: boolean;
  fault: FakeFault | null;
}

export class FakeBankNetwork implements BankPort {
  readonly accounts = new Map<string, Account>();
  readonly holds = new Map<string, Hold>();
  readonly entries = new Map<string, Entry>();
  private readonly requests = new Map<string, StoredRequest>();
  private readonly faults = new Map<string, FakeFault[]>();
  private readonly persistentFaults = new Map<string, FakeFault>();
  private readonly down = new Set<string>();
  readonly calls: CallLog[] = [];
  private seq = 0;
  onCall: ((bank: string, step: AdapterStep, body: Record<string, unknown>) => Promise<void>) | null = null;

  constructor(
    private readonly clock: Clock,
    readonly banks: string[] = ['KOSH', 'ALPHA', 'BETA'],
  ) {
    for (const b of banks) {
      this.accounts.set(this.gl(b, 'SWITCH'), { bank: b, balance: 0, held: 0, closed: false });
      this.accounts.set(this.gl(b, 'CASH'), { bank: b, balance: 0, held: 0, closed: false });
    }
  }

  gl(bank: string, kind: 'SWITCH' | 'CASH'): string {
    return `gl_${kind.toLowerCase()}_${bank}`;
  }

  open(bank: string, accountId: string, deposit: number): void {
    this.accounts.set(accountId, { bank, balance: deposit, held: 0, closed: false });
    this.account(this.gl(bank, 'CASH')).balance -= deposit;
  }

  close(accountId: string): void {
    this.account(accountId).closed = true;
  }

  spend(accountId: string, amount: number): void {
    const a = this.account(accountId);
    a.balance -= amount;
    this.account(this.gl(a.bank, 'CASH')).balance += amount;
  }

  balance(accountId: string): number {
    return this.account(accountId).balance;
  }

  held(accountId: string): number {
    return this.account(accountId).held;
  }

  inject(bank: string, step: AdapterStep, ...faults: FakeFault[]): void {
    const key = `${bank}|${step}`;
    this.faults.set(key, [...(this.faults.get(key) ?? []), ...faults]);
  }

  injectAlways(bank: string, step: AdapterStep, fault: FakeFault | null): void {
    const key = `${bank}|${step}`;
    if (fault) this.persistentFaults.set(key, fault);
    else this.persistentFaults.delete(key);
  }

  setDown(bank: string, isDown: boolean): void {
    if (isDown) this.down.add(bank);
    else this.down.delete(bank);
  }

  clearFaults(): void {
    this.faults.clear();
    this.persistentFaults.clear();
    this.down.clear();
  }

  preRecord(bank: string, txnId: string, step: AdapterStep, body: Record<string, unknown>): void {
    this.requests.set(`${bank}|${txnId}|${step}`, { hash: sha256(stableStringify(body)), status: 'DONE', httpStatus: 200, response: { status: 'PRE' } });
  }

  executed(txnId: string, step: AdapterStep): number {
    return this.calls.filter((c) => c.txnId === txnId && c.step === step && c.executed).length;
  }

  private account(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `account ${id} not found`);
    return a;
  }

  private nextId(prefix: string): string {
    this.seq++;
    return `${prefix}_${String(this.seq).padStart(6, '0')}`;
  }

  private takeFault(bank: string, step: AdapterStep): FakeFault | null {
    const key = `${bank}|${step}`;
    const queue = this.faults.get(key);
    if (queue && queue.length > 0) return queue.shift() ?? null;
    return this.persistentFaults.get(key) ?? null;
  }

  async call(bank: string, step: AdapterStep, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.onCall) await this.onCall(bank, step, body);
    const txnId = String(body.txnId);
    if (this.down.has(bank)) {
      this.calls.push({ bank, step, txnId, executed: false, fault: 'REFUSED' });
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'connect ECONNREFUSED', { cause: 'ECONNREFUSED' });
    }
    const fault = this.takeFault(bank, step);
    if (fault === 'ERROR') {
      this.calls.push({ bank, step, txnId, executed: false, fault });
      throw new AppError(503, 'ADAPTER_FAULT_INJECTED', `injected ${step} failure at ${bank}`);
    }
    if (fault === 'REFUSED') {
      this.calls.push({ bank, step, txnId, executed: false, fault });
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'connect ECONNREFUSED', { cause: 'ECONNREFUSED' });
    }
    if (fault === 'TIMEOUT_BEFORE') {
      this.calls.push({ bank, step, txnId, executed: false, fault });
      throw new AppError(504, 'UPSTREAM_TIMEOUT', `${step} timed out`);
    }
    const key = `${bank}|${txnId}|${step}`;
    const hash = sha256(stableStringify(body));
    const existing = this.requests.get(key);
    if (existing && existing.hash !== hash) {
      this.calls.push({ bank, step, txnId, executed: false, fault });
      throw new AppError(409, 'ADAPTER_REQUEST_MISMATCH', `${step} for ${txnId} was already requested with different parameters`);
    }
    let result: Record<string, unknown> | null = null;
    let failure: AppError | null = null;
    if (existing) {
      this.calls.push({ bank, step, txnId, executed: false, fault });
      if (existing.status === 'FAILED') {
        const e = (existing.response as { error: { code: string; message: string } }).error;
        failure = new AppError(existing.httpStatus, e.code, e.message);
      } else {
        result = existing.response as Record<string, unknown>;
      }
    } else {
      try {
        result = { txnId, bankCode: bank, step, ...this.execute(bank, step, body) };
        this.requests.set(key, { hash, status: 'DONE', httpStatus: 200, response: result });
        this.calls.push({ bank, step, txnId, executed: true, fault });
      } catch (err) {
        if (!(err instanceof AppError) || err.status >= 500) throw err;
        this.requests.set(key, { hash, status: 'FAILED', httpStatus: err.status, response: err.toBody() });
        this.calls.push({ bank, step, txnId, executed: false, fault });
        failure = err;
      }
    }
    if (fault === 'TIMEOUT_AFTER_COMMIT') throw new AppError(504, 'UPSTREAM_TIMEOUT', `${step} timed out after the bank decided`);
    if (fault === 'DROP_AFTER_COMMIT') throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'other side closed', { cause: 'UND_ERR_SOCKET' });
    if (failure) throw failure;
    return result!;
  }

  async status(bank: string, txnId: string): Promise<BankStatus> {
    if (this.down.has(bank)) throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'connect ECONNREFUSED', { cause: 'ECONNREFUSED' });
    const steps = [...this.requests.entries()]
      .filter(([k]) => k.startsWith(`${bank}|${txnId}|`))
      .map(([k, v]) => ({ step: k.split('|')[2] ?? '', status: v.status, httpStatus: v.httpStatus, response: v.response }));
    return { txnId, bankCode: bank, steps };
  }

  private execute(bank: string, step: AdapterStep, body: Record<string, unknown>): Record<string, unknown> {
    const now = this.clock.now().getTime();
    switch (step) {
      case 'hold': {
        const a = this.account(String(body.accountId));
        if (a.bank !== bank) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'account is not at this bank');
        if (a.closed) throw new AppError(422, 'ACCOUNT_NOT_ACTIVE', 'account is closed');
        const amount = Number(body.amount);
        if (a.balance - a.held < amount) throw new AppError(422, 'INSUFFICIENT_FUNDS', 'insufficient available balance');
        const id = this.nextId('hold');
        a.held += amount;
        this.holds.set(id, { id, bank, accountId: String(body.accountId), amount, status: 'ACTIVE', expiresAt: now + Number(body.ttlSeconds) * 1000, txnId: String(body.txnId), captureEntryId: null });
        return { status: 'HELD', holdId: id, accountId: body.accountId, amount };
      }
      case 'credit': {
        const a = this.account(String(body.accountId));
        if (a.closed) throw new AppError(422, 'ACCOUNT_NOT_OPEN', 'account is closed');
        const amount = Number(body.amount);
        const gl = this.gl(bank, 'SWITCH');
        this.account(gl).balance -= amount;
        a.balance += amount;
        const id = this.nextId('ent');
        this.entries.set(id, {
          id,
          bank,
          txnId: String(body.txnId),
          kind: 'CREDIT',
          postings: [
            { accountId: gl, amount: -amount },
            { accountId: String(body.accountId), amount },
          ],
          reversedBy: null,
        });
        return { status: 'CREDITED', entryId: id, accountId: body.accountId, amount };
      }
      case 'capture': {
        const h = this.holds.get(String(body.holdId));
        if (!h || h.bank !== bank) throw new AppError(404, 'HOLD_NOT_FOUND', 'hold not found');
        if (h.txnId !== body.txnId) throw new AppError(409, 'HOLD_TXN_MISMATCH', 'hold does not belong to this transaction');
        if (h.status === 'CAPTURED') return { status: 'CAPTURED', holdId: h.id, entryId: h.captureEntryId };
        if (h.status === 'ACTIVE' && h.expiresAt <= now) this.expire(h);
        if (h.status === 'EXPIRED') throw new AppError(409, 'HOLD_EXPIRED', 'hold expired before capture');
        if (h.status !== 'ACTIVE') throw new AppError(409, 'HOLD_NOT_ACTIVE', `hold is ${h.status}`);
        const a = this.account(h.accountId);
        const gl = this.gl(bank, 'SWITCH');
        a.held -= h.amount;
        a.balance -= h.amount;
        this.account(gl).balance += h.amount;
        const id = this.nextId('ent');
        this.entries.set(id, {
          id,
          bank,
          txnId: h.txnId,
          kind: 'HOLD_CAPTURE',
          postings: [
            { accountId: h.accountId, amount: -h.amount },
            { accountId: gl, amount: h.amount },
          ],
          reversedBy: null,
        });
        h.status = 'CAPTURED';
        h.captureEntryId = id;
        return { status: 'CAPTURED', holdId: h.id, entryId: id, accountId: h.accountId, amount: h.amount };
      }
      case 'release': {
        const h = this.holds.get(String(body.holdId));
        if (!h || h.bank !== bank) throw new AppError(404, 'HOLD_NOT_FOUND', 'hold not found');
        if (h.status === 'CAPTURED') throw new AppError(409, 'HOLD_ALREADY_CAPTURED', 'a captured hold cannot be released');
        if (h.status === 'ACTIVE') {
          this.account(h.accountId).held -= h.amount;
          h.status = 'RELEASED';
        }
        return { status: 'RELEASED', holdId: h.id, holdStatus: h.status };
      }
      case 'reverse': {
        const e = this.entries.get(String(body.entryId));
        if (!e || e.bank !== bank) throw new AppError(404, 'ENTRY_NOT_FOUND', 'entry not found');
        if (e.reversedBy) throw new AppError(409, 'ENTRY_ALREADY_REVERSED', 'entry has already been reversed');
        for (const p of e.postings) {
          const a = this.account(p.accountId);
          if (p.amount > 0 && !p.accountId.startsWith('gl_') && a.balance - a.held < p.amount) {
            throw new AppError(422, 'INSUFFICIENT_FUNDS', 'payee no longer has the money');
          }
        }
        for (const p of e.postings) this.account(p.accountId).balance -= p.amount;
        const id = this.nextId('ent');
        this.entries.set(id, { id, bank, txnId: e.txnId, kind: 'REVERSAL', postings: e.postings.map((p) => ({ accountId: p.accountId, amount: -p.amount })), reversedBy: null });
        e.reversedBy = id;
        return { status: 'REVERSED', entryId: id, reversedEntryId: e.id };
      }
    }
  }

  private expire(h: Hold): void {
    if (h.status !== 'ACTIVE') return;
    this.account(h.accountId).held -= h.amount;
    h.status = 'EXPIRED';
  }

  sweepExpired(): void {
    const now = this.clock.now().getTime();
    for (const h of this.holds.values()) if (h.status === 'ACTIVE' && h.expiresAt <= now) this.expire(h);
  }

  activeHolds(txnId: string): Hold[] {
    return [...this.holds.values()].filter((h) => h.txnId === txnId && h.status === 'ACTIVE');
  }

  invariants(): string[] {
    const problems: string[] = [];
    for (const bank of this.banks) {
      const total = [...this.accounts.values()].filter((a) => a.bank === bank).reduce((s, a) => s + a.balance, 0);
      if (total !== 0) problems.push(`${bank} does not balance: ${total}`);
    }
    for (const [id, a] of this.accounts) {
      if (id.startsWith('gl_')) continue;
      if (a.held < 0) problems.push(`${id} has negative held ${a.held}`);
      if (a.balance - a.held < 0) problems.push(`${id} available is negative`);
      const activeHeld = [...this.holds.values()].filter((h) => h.accountId === id && h.status === 'ACTIVE').reduce((s, h) => s + h.amount, 0);
      if (activeHeld !== a.held) problems.push(`${id} held ${a.held} != active holds ${activeHeld}`);
    }
    return problems;
  }

  customerTotal(): number {
    return [...this.accounts.entries()].filter(([id]) => !id.startsWith('gl_')).reduce((s, [, a]) => s + a.balance, 0);
  }

  switchGlTotal(): number {
    return this.banks.reduce((s, b) => s + this.account(this.gl(b, 'SWITCH')).balance, 0);
  }
}
