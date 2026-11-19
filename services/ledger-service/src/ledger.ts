import { EVENT_TYPES, TOPICS, type AccountStatus, type InternalAccount } from '@kosh/contracts';
import { assertPositive, isPaise } from '@kosh/money';
import {
  addSeconds,
  AppError,
  badRequest,
  businessDayStartIso,
  type Clock,
  conflict,
  type Db,
  emit,
  newId,
  notFound,
  tx,
  unprocessable,
} from '@kosh/service-kit';

export const ENTRY_KINDS = ['TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'HOLD_CAPTURE', 'CREDIT', 'REVERSAL', 'ADJUSTMENT'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
const LIMITED_KINDS: readonly EntryKind[] = ['TRANSFER'];

export interface PostingInput {
  accountId: string;
  amount: number;
}

export interface LedgerAccountRow {
  account_id: string;
  bank_code: string;
  type: 'SAVINGS' | 'CURRENT' | 'INTERNAL';
  gl_code: string | null;
  status: AccountStatus;
  overdraft_limit: number;
  per_txn_limit: number;
  daily_debit_limit: number;
  holder_name: string;
}

interface EntryRow {
  id: string;
  kind: EntryKind;
  status: string;
  reference: string;
  description: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  created_by: string;
  created_at: string;
}

interface HoldRow {
  id: string;
  account_id: string;
  amount: number;
  status: 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED';
  reference: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  capture_entry_id: string | null;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  violations: unknown[];
}

export const MAX_HOLD_TTL_SECONDS = 86400;

function holdView(h: HoldRow) {
  return {
    id: h.id,
    accountId: h.account_id,
    amount: h.amount,
    status: h.status,
    reference: h.reference,
    createdAt: h.created_at,
    expiresAt: h.expires_at,
    resolvedAt: h.resolved_at,
    captureEntryId: h.capture_entry_id,
  };
}
export type HoldView = ReturnType<typeof holdView>;

export class BankLedger {
  constructor(
    readonly bankCode: string,
    readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private now(): string {
    return this.clock.now().toISOString();
  }

  upsertAccount(a: InternalAccount): void {
    if (a.bankCode !== this.bankCode) throw unprocessable('ACCOUNT_WRONG_BANK', `account ${a.id} belongs to ${a.bankCode}, not ${this.bankCode}`);
    const now = this.now();
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO ledger_accounts (account_id, bank_code, type, gl_code, status, overdraft_limit, per_txn_limit, daily_debit_limit, holder_name, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, overdraft_limit = excluded.overdraft_limit,
             per_txn_limit = excluded.per_txn_limit, daily_debit_limit = excluded.daily_debit_limit, holder_name = excluded.holder_name, synced_at = excluded.synced_at`,
        )
        .run(a.id, a.bankCode, a.type, a.glCode, a.status, a.overdraftLimit, a.perTxnLimit, a.dailyDebitLimit, a.holderName, now);
      this.db.prepare('INSERT OR IGNORE INTO balances (account_id, ledger_balance, held_amount, version, updated_at) VALUES (?, 0, 0, 0, ?)').run(a.id, now);
    });
  }

  applyAccountEvent(type: string, payload: Record<string, unknown>): void {
    const id = String(payload.accountId);
    if (type === EVENT_TYPES.AccountOpened) {
      const exists = this.db.prepare('SELECT 1 FROM ledger_accounts WHERE account_id = ?').get(id);
      if (exists) return;
      this.upsertAccount({
        id,
        bankCode: String(payload.bankCode),
        accountNumber: '',
        ifsc: '',
        type: payload.type as InternalAccount['type'],
        glCode: (payload.glCode as InternalAccount['glCode']) ?? null,
        status: payload.status as AccountStatus,
        overdraftLimit: Number(payload.overdraftLimit),
        perTxnLimit: Number(payload.perTxnLimit),
        dailyDebitLimit: Number(payload.dailyDebitLimit),
        customerId: (payload.customerId as string | null) ?? null,
        userId: null,
        holderName: String(payload.holderName),
      });
    } else if (type === EVENT_TYPES.AccountStatusChanged) {
      this.db
        .prepare('UPDATE ledger_accounts SET status = ?, synced_at = ? WHERE account_id = ? AND status = ?')
        .run(String(payload.to), this.now(), id, String(payload.from));
    } else if (type === EVENT_TYPES.LimitChanged) {
      this.db
        .prepare('UPDATE ledger_accounts SET per_txn_limit = ?, daily_debit_limit = ?, overdraft_limit = ?, synced_at = ? WHERE account_id = ?')
        .run(Number(payload.perTxnLimit), Number(payload.dailyDebitLimit), Number(payload.overdraftLimit), this.now(), id);
    }
  }

  accountsToRefresh(ids: string[]): { unknown: string[]; inactive: string[] } {
    const stmt = this.db.prepare('SELECT status FROM ledger_accounts WHERE account_id = ?');
    const unknown: string[] = [];
    const inactive: string[] = [];
    for (const id of new Set(ids)) {
      const row = stmt.get(id) as { status: string } | undefined;
      if (!row) unknown.push(id);
      else if (row.status !== 'ACTIVE') inactive.push(id);
    }
    return { unknown, inactive };
  }

  account(id: string): LedgerAccountRow {
    const a = this.db.prepare('SELECT * FROM ledger_accounts WHERE account_id = ?').get(id) as LedgerAccountRow | undefined;
    if (!a) throw unprocessable('ACCOUNT_UNKNOWN', `account ${id} is not known to the ${this.bankCode} ledger`);
    return a;
  }

  private balanceRow(id: string): { ledger_balance: number; held_amount: number } {
    return this.db.prepare('SELECT ledger_balance, held_amount FROM balances WHERE account_id = ?').get(id) as { ledger_balance: number; held_amount: number };
  }

  private dailyDebitUsage(accountId: string): number {
    const since = businessDayStartIso(this.clock.now());
    const debits = this.db
      .prepare(
        `SELECT COALESCE(-SUM(p.amount), 0) FROM postings p JOIN journal_entries e ON e.id = p.entry_id
         WHERE p.account_id = ? AND p.amount < 0 AND e.kind IN ('TRANSFER', 'HOLD_CAPTURE') AND p.created_at >= ?`,
      )
      .pluck()
      .get(accountId, since) as number;
    const held = this.db.prepare("SELECT COALESCE(SUM(amount), 0) FROM holds WHERE account_id = ? AND status = 'ACTIVE'").pluck().get(accountId) as number;
    return debits + held;
  }

  private checkDebit(a: LedgerAccountRow, amount: number, opts: { limits: boolean; status: boolean }): void {
    if (a.type === 'INTERNAL') return;
    if (opts.status && a.status !== 'ACTIVE') throw unprocessable('ACCOUNT_NOT_ACTIVE', `account ${a.account_id} is ${a.status} and cannot be debited`);
    const bal = this.balanceRow(a.account_id);
    const available = bal.ledger_balance - bal.held_amount;
    if (available - amount < -a.overdraft_limit) {
      throw unprocessable('INSUFFICIENT_FUNDS', 'insufficient available balance', { accountId: a.account_id, available, requested: amount });
    }
    if (opts.limits) {
      if (amount > a.per_txn_limit) throw unprocessable('LIMIT_PER_TXN_EXCEEDED', 'amount exceeds the per transaction limit', { limit: a.per_txn_limit });
      const used = this.dailyDebitUsage(a.account_id);
      if (used + amount > a.daily_debit_limit) {
        throw unprocessable('LIMIT_DAILY_EXCEEDED', 'amount exceeds the remaining daily limit', { limit: a.daily_debit_limit, used });
      }
    }
  }

  private checkCredit(a: LedgerAccountRow, enforceStatus: boolean): void {
    if (a.type === 'INTERNAL' || !enforceStatus) return;
    if (a.status === 'PENDING' || a.status === 'CLOSED') throw unprocessable('ACCOUNT_NOT_OPEN', `account ${a.account_id} is ${a.status} and cannot be credited`);
  }

  private applyBalance(accountId: string, ledgerDelta: number, heldDelta: number): void {
    this.db
      .prepare('UPDATE balances SET ledger_balance = ledger_balance + ?, held_amount = held_amount + ?, version = version + 1, updated_at = ? WHERE account_id = ?')
      .run(ledgerDelta, heldDelta, this.now(), accountId);
  }

  private validatePostings(postings: PostingInput[]): void {
    if (postings.length < 2) throw badRequest('ENTRY_TOO_FEW_POSTINGS', 'an entry needs at least two postings');
    const seen = new Set<string>();
    let total = 0;
    for (const p of postings) {
      if (!isPaise(p.amount) || p.amount === 0) throw badRequest('INVALID_AMOUNT', 'posting amounts must be non-zero integer paise');
      if (seen.has(p.accountId)) throw badRequest('ENTRY_DUPLICATE_ACCOUNT', 'each account may appear only once per entry');
      seen.add(p.accountId);
      total += p.amount;
      if (!Number.isSafeInteger(total)) throw badRequest('AMOUNT_OVERFLOW', 'posting total overflows');
    }
    if (total !== 0) throw badRequest('ENTRY_UNBALANCED', `postings must sum to zero, got ${total}`);
  }

  private writeEntry(
    kind: EntryKind,
    reference: string,
    description: string | null,
    postings: PostingInput[],
    createdBy: string,
    reversesId: string | null = null,
  ): string {
    const id = newId('jrn');
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO journal_entries (id, kind, status, reference, description, reverses_entry_id, created_by, created_at) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?)",
      )
      .run(id, kind, reference, description, reversesId, createdBy, now);
    const insert = this.db.prepare('INSERT INTO postings (entry_id, account_id, amount, created_at) VALUES (?, ?, ?, ?)');
    for (const p of postings) {
      insert.run(id, p.accountId, p.amount, now);
      this.applyBalance(p.accountId, p.amount, 0);
    }
    this.db.prepare("UPDATE journal_entries SET status = 'POSTED', posted_at = ? WHERE id = ?").run(now, id);
    emit(
      this.db,
      { topic: TOPICS.ledger, type: EVENT_TYPES.EntryPosted, key: id, payload: { entryId: id, bankCode: this.bankCode, kind, reference, postings } },
      this.clock,
    );
    return id;
  }

  post(input: { kind: EntryKind; reference: string; description?: string | null; postings: PostingInput[]; createdBy: string }) {
    if (input.kind === 'REVERSAL' || input.kind === 'HOLD_CAPTURE') throw badRequest('ENTRY_KIND_RESERVED', `${input.kind} entries are created by dedicated operations`);
    this.validatePostings(input.postings);
    return tx(this.db, () => {
      const accounts = input.postings.map((p) => ({ p, a: this.account(p.accountId) }));
      for (const { p, a } of accounts) {
        if (p.amount < 0) this.checkDebit(a, -p.amount, { limits: LIMITED_KINDS.includes(input.kind), status: true });
        else this.checkCredit(a, true);
      }
      const id = this.writeEntry(input.kind, input.reference, input.description ?? null, input.postings, input.createdBy);
      return this.entry(id);
    });
  }

  hasGl(glCode: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM ledger_accounts WHERE gl_code = ?').get(glCode));
  }

  glAccountId(glCode: string): string {
    const id = this.db.prepare('SELECT account_id FROM ledger_accounts WHERE gl_code = ?').pluck().get(glCode) as string | undefined;
    if (!id) throw unprocessable('GL_UNKNOWN', `${glCode} GL is not known to the ${this.bankCode} ledger`);
    return id;
  }

  deposit(accountId: string, amount: number, reference: string, createdBy: string) {
    assertPositive(amount);
    return this.post({
      kind: 'DEPOSIT',
      reference,
      description: 'Cash deposit',
      postings: [
        { accountId: this.glAccountId('CASH'), amount: -amount },
        { accountId, amount },
      ],
      createdBy,
    });
  }

  withdraw(accountId: string, amount: number, reference: string, createdBy: string) {
    assertPositive(amount);
    return this.post({
      kind: 'WITHDRAWAL',
      reference,
      description: 'Cash withdrawal',
      postings: [
        { accountId, amount: -amount },
        { accountId: this.glAccountId('CASH'), amount },
      ],
      createdBy,
    });
  }

  placeHold(input: { accountId: string; amount: number; reference: string; ttlSeconds: number }): HoldView {
    assertPositive(input.amount);
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_HOLD_TTL_SECONDS) {
      throw badRequest('HOLD_TTL_INVALID', `ttlSeconds must be between 1 and ${MAX_HOLD_TTL_SECONDS}`);
    }
    return tx(this.db, () => {
      const a = this.account(input.accountId);
      if (a.type === 'INTERNAL') throw unprocessable('HOLD_ON_INTERNAL', 'holds can only be placed on customer accounts');
      this.checkDebit(a, input.amount, { limits: true, status: true });
      const id = newId('hld');
      const now = this.clock.now();
      this.db
        .prepare("INSERT INTO holds (id, account_id, amount, status, reference, created_at, expires_at) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)")
        .run(id, a.account_id, input.amount, input.reference, now.toISOString(), addSeconds(now, input.ttlSeconds).toISOString());
      this.applyBalance(a.account_id, 0, input.amount);
      emit(
        this.db,
        { topic: TOPICS.ledger, type: EVENT_TYPES.HoldPlaced, key: id, payload: { holdId: id, bankCode: this.bankCode, accountId: a.account_id, amount: input.amount, reference: input.reference } },
        this.clock,
      );
      return holdView(this.holdRow(id));
    });
  }

  private holdRow(id: string): HoldRow {
    const h = this.db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as HoldRow | undefined;
    if (!h) throw notFound('HOLD_NOT_FOUND', 'hold not found');
    return h;
  }

  getHold(id: string): HoldView {
    return holdView(this.holdRow(id));
  }

  private resolveHold(h: HoldRow, status: 'RELEASED' | 'EXPIRED' | 'CAPTURED', captureEntryId: string | null): void {
    this.db
      .prepare("UPDATE holds SET status = ?, resolved_at = ?, capture_entry_id = ? WHERE id = ? AND status = 'ACTIVE'")
      .run(status, this.now(), captureEntryId, h.id);
    this.applyBalance(h.account_id, 0, -h.amount);
    const type = status === 'CAPTURED' ? EVENT_TYPES.HoldCaptured : status === 'RELEASED' ? EVENT_TYPES.HoldReleased : EVENT_TYPES.HoldExpired;
    emit(
      this.db,
      { topic: TOPICS.ledger, type, key: h.id, payload: { holdId: h.id, bankCode: this.bankCode, accountId: h.account_id, amount: h.amount, reference: h.reference } },
      this.clock,
    );
  }

  captureHold(holdId: string, input: { counterAccountId: string; description?: string | null; createdBy: string }) {
    return tx(this.db, () => {
      const h = this.holdRow(holdId);
      if (h.status === 'CAPTURED') {
        const entry = this.entry(h.capture_entry_id!);
        const counter = entry.postings.find((p) => p.amount > 0)?.accountId;
        if (counter !== input.counterAccountId) throw conflict('HOLD_CAPTURED_DIFFERENTLY', 'hold was already captured to a different account');
        return { hold: holdView(h), entry };
      }
      if (h.status !== 'ACTIVE') throw conflict('HOLD_NOT_ACTIVE', `hold is ${h.status}`);
      if (h.expires_at <= this.now()) {
        this.resolveHold(h, 'EXPIRED', null);
        return { expired: true as const };
      }
      const counter = this.account(input.counterAccountId);
      if (counter.account_id === h.account_id) throw badRequest('ENTRY_DUPLICATE_ACCOUNT', 'cannot capture a hold to the same account');
      this.checkCredit(counter, true);
      const postings = [
        { accountId: h.account_id, amount: -h.amount },
        { accountId: counter.account_id, amount: h.amount },
      ];
      const entryId = this.writeEntry('HOLD_CAPTURE', h.reference, input.description ?? null, postings, input.createdBy);
      this.resolveHold(h, 'CAPTURED', entryId);
      return { hold: holdView(this.holdRow(holdId)), entry: this.entry(entryId) };
    });
  }

  capture(holdId: string, input: { counterAccountId: string; description?: string | null; createdBy: string }) {
    const r = this.captureHold(holdId, input);
    if ('expired' in r) throw conflict('HOLD_EXPIRED', 'hold expired before capture');
    return r;
  }

  releaseHold(holdId: string): HoldView {
    return tx(this.db, () => {
      const h = this.holdRow(holdId);
      if (h.status === 'RELEASED' || h.status === 'EXPIRED') return holdView(h);
      if (h.status === 'CAPTURED') throw conflict('HOLD_ALREADY_CAPTURED', 'a captured hold cannot be released');
      this.resolveHold(h, 'RELEASED', null);
      return holdView(this.holdRow(holdId));
    });
  }

  expireHolds(): number {
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM holds WHERE status = 'ACTIVE' AND expires_at <= ? ORDER BY expires_at LIMIT 500").all(this.now()) as HoldRow[];
      for (const h of rows) this.resolveHold(h, 'EXPIRED', null);
      return rows.length;
    });
  }

  reverse(entryId: string, reason: string, createdBy: string) {
    return tx(this.db, () => {
      const e = this.entryRow(entryId);
      if (e.kind === 'REVERSAL') throw unprocessable('CANNOT_REVERSE_REVERSAL', 'a reversal entry cannot itself be reversed');
      if (e.reversed_by_entry_id) throw conflict('ENTRY_ALREADY_REVERSED', 'entry has already been reversed', { reversalEntryId: e.reversed_by_entry_id });
      const original = this.postingsOf(entryId);
      const postings = original.map((p) => ({ accountId: p.accountId, amount: -p.amount }));
      for (const p of postings) {
        const a = this.account(p.accountId);
        if (p.amount < 0) this.checkDebit(a, -p.amount, { limits: false, status: false });
        else if (a.status === 'CLOSED') throw unprocessable('ACCOUNT_NOT_OPEN', `account ${a.account_id} is CLOSED`);
      }
      const id = this.writeEntry('REVERSAL', e.reference, reason, postings, createdBy, entryId);
      this.db.prepare('UPDATE journal_entries SET reversed_by_entry_id = ? WHERE id = ?').run(id, entryId);
      return this.entry(id);
    });
  }

  private entryRow(id: string): EntryRow {
    const e = this.db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id) as EntryRow | undefined;
    if (!e) throw notFound('ENTRY_NOT_FOUND', 'journal entry not found');
    return e;
  }

  private postingsOf(entryId: string): PostingInput[] {
    return this.db.prepare('SELECT account_id AS accountId, amount FROM postings WHERE entry_id = ? ORDER BY id').all(entryId) as PostingInput[];
  }

  entry(id: string) {
    const e = this.entryRow(id);
    return {
      id: e.id,
      bankCode: this.bankCode,
      kind: e.kind,
      status: e.status,
      reference: e.reference,
      description: e.description,
      reversesEntryId: e.reverses_entry_id,
      reversedByEntryId: e.reversed_by_entry_id,
      createdBy: e.created_by,
      createdAt: e.created_at,
      postings: this.postingsOf(id),
    };
  }

  entriesByReference(reference: string) {
    const ids = this.db.prepare('SELECT id FROM journal_entries WHERE reference = ? ORDER BY created_at, id').pluck().all(reference) as string[];
    return ids.map((id) => this.entry(id));
  }

  balance(accountId: string, asOf?: string) {
    const a = this.account(accountId);
    if (!asOf) {
      const b = this.balanceRow(a.account_id);
      return {
        accountId,
        bankCode: this.bankCode,
        status: a.status,
        ledgerBalance: b.ledger_balance,
        heldAmount: b.held_amount,
        availableBalance: b.ledger_balance - b.held_amount,
        overdraftLimit: a.overdraft_limit,
        asOf: this.now(),
      };
    }
    const ledger = this.db.prepare('SELECT COALESCE(SUM(amount), 0) FROM postings WHERE account_id = ? AND created_at <= ?').pluck().get(accountId, asOf) as number;
    const held = this.db
      .prepare('SELECT COALESCE(SUM(amount), 0) FROM holds WHERE account_id = ? AND created_at <= ? AND (resolved_at IS NULL OR resolved_at > ?)')
      .pluck()
      .get(accountId, asOf, asOf) as number;
    return { accountId, bankCode: this.bankCode, status: a.status, ledgerBalance: ledger, heldAmount: held, availableBalance: ledger - held, overdraftLimit: a.overdraft_limit, asOf };
  }

  statement(accountId: string, opts: { from?: string; to?: string; limit: number }) {
    this.account(accountId);
    const from = opts.from ?? '0000';
    const to = opts.to ?? '9999';
    const opening = this.db.prepare('SELECT COALESCE(SUM(amount), 0) FROM postings WHERE account_id = ? AND created_at < ?').pluck().get(accountId, from) as number;
    const rows = this.db
      .prepare(
        `SELECT p.id AS postingId, p.entry_id AS entryId, e.kind, e.reference, e.description, p.amount, p.created_at AS at
         FROM postings p JOIN journal_entries e ON e.id = p.entry_id
         WHERE p.account_id = ? AND p.created_at >= ? AND p.created_at <= ? ORDER BY p.id LIMIT ?`,
      )
      .all(accountId, from, to, opts.limit) as { postingId: number; entryId: string; kind: string; reference: string; description: string | null; amount: number; at: string }[];
    let running = opening;
    const lines = rows.map((r) => {
      running += r.amount;
      return { ...r, direction: r.amount > 0 ? 'CREDIT' : 'DEBIT', balanceAfter: running };
    });
    return { accountId, bankCode: this.bankCode, openingBalance: opening, closingBalance: running, lines };
  }

  listHolds(filter: { accountId?: string; status?: string; reference?: string }) {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.accountId) {
      clauses.push('account_id = ?');
      args.push(filter.accountId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      args.push(filter.status);
    }
    if (filter.reference) {
      clauses.push('reference = ?');
      args.push(filter.reference);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM holds ${where} ORDER BY created_at DESC LIMIT 500`).all(...args) as HoldRow[]).map(holdView);
  }

  invariants() {
    const checks: CheckResult[] = [];
    const add = (name: string, violations: unknown[]) => checks.push({ name, ok: violations.length === 0, violations: violations.slice(0, 20) });
    add('entries_balance', this.db.prepare('SELECT entry_id AS entryId, SUM(amount) AS total FROM postings GROUP BY entry_id HAVING SUM(amount) != 0').all());
    add('no_pending_entries', this.db.prepare("SELECT id FROM journal_entries WHERE status != 'POSTED'").all());
    add('entries_have_two_postings', this.db.prepare('SELECT e.id FROM journal_entries e WHERE (SELECT COUNT(*) FROM postings p WHERE p.entry_id = e.id) < 2').all());
    const total = this.db.prepare('SELECT COALESCE(SUM(amount), 0) FROM postings').pluck().get() as number;
    add('ledger_sums_to_zero', total === 0 ? [] : [{ total }]);
    add(
      'balance_matches_postings',
      this.db
        .prepare(
          `SELECT b.account_id AS accountId, b.ledger_balance AS cached, COALESCE((SELECT SUM(amount) FROM postings p WHERE p.account_id = b.account_id), 0) AS actual
           FROM balances b WHERE b.ledger_balance != COALESCE((SELECT SUM(amount) FROM postings p WHERE p.account_id = b.account_id), 0)`,
        )
        .all(),
    );
    add(
      'held_matches_active_holds',
      this.db
        .prepare(
          `SELECT b.account_id AS accountId, b.held_amount AS cached, COALESCE((SELECT SUM(amount) FROM holds h WHERE h.account_id = b.account_id AND h.status = 'ACTIVE'), 0) AS actual
           FROM balances b WHERE b.held_amount != COALESCE((SELECT SUM(amount) FROM holds h WHERE h.account_id = b.account_id AND h.status = 'ACTIVE'), 0)`,
        )
        .all(),
    );
    add(
      'available_within_overdraft',
      this.db
        .prepare(
          `SELECT b.account_id AS accountId, b.ledger_balance - b.held_amount AS available, a.overdraft_limit AS overdraftLimit
           FROM balances b JOIN ledger_accounts a ON a.account_id = b.account_id
           WHERE a.type != 'INTERNAL' AND b.ledger_balance - b.held_amount < -a.overdraft_limit`,
        )
        .all(),
    );
    add(
      'reversals_net_to_zero',
      this.db
        .prepare(
          `SELECT e.id AS entryId FROM journal_entries e WHERE e.reversed_by_entry_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM postings p WHERE p.entry_id IN (e.id, e.reversed_by_entry_id) GROUP BY p.account_id HAVING SUM(p.amount) != 0)`,
        )
        .all(),
    );
    add(
      'captured_holds_have_entries',
      this.db.prepare("SELECT id FROM holds WHERE status = 'CAPTURED' AND (capture_entry_id IS NULL OR capture_entry_id NOT IN (SELECT id FROM journal_entries))").all(),
    );
    const stale = this.db.prepare("SELECT COUNT(*) FROM holds WHERE status = 'ACTIVE' AND expires_at <= ?").pluck().get(this.now()) as number;
    const counts = this.db
      .prepare('SELECT (SELECT COUNT(*) FROM journal_entries) AS entries, (SELECT COUNT(*) FROM postings) AS postings, (SELECT COUNT(*) FROM holds WHERE status = \'ACTIVE\') AS activeHolds')
      .get() as { entries: number; postings: number; activeHolds: number };
    return { bankCode: this.bankCode, ok: checks.every((c) => c.ok), checks, totals: { ...counts, staleActiveHolds: stale } };
  }
}

export function isLedgerError(err: unknown): err is AppError {
  return err instanceof AppError;
}
