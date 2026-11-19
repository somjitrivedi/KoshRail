import {
  EVENT_TYPES,
  GL_CODES,
  TOPICS,
  type AccountStatus,
  type AccountType,
  type GlCode,
  type InternalAccount,
  type InternalUser,
  type KycTier,
  type Principal,
} from '@kosh/contracts';
import {
  assertBankScope,
  badRequest,
  type Clock,
  conflict,
  type Db,
  emit,
  forbidden,
  newId,
  notFound,
  tx,
  unprocessable,
} from '@kosh/service-kit';
import {
  APPROVAL_TARGET,
  type ApprovalKind,
  canTransition,
  DIRECT_ACTIONS,
  type DirectAction,
  GL_NAMES,
  INTERNAL_LIMIT,
  maskAccountNumber,
  MAX_OVERDRAFT,
  SEED_BANKS,
  TIER_LIMITS,
} from './rules.ts';

export interface UserDirectory {
  getUser(id: string): Promise<InternalUser>;
}

export interface LedgerPort {
  getBalance(bankCode: string, accountId: string): Promise<{ ledgerBalance: number; heldAmount: number }>;
  refresh(bankCode: string, accountId: string): Promise<void>;
}

interface BankRow {
  code: string;
  name: string;
  ifsc_prefix: string;
  vpa_handle: string;
  number_prefix: string;
  status: string;
}

interface CustomerRow {
  id: string;
  bank_code: string;
  user_id: string | null;
  full_name: string;
  phone: string;
  kyc_tier: KycTier;
  created_at: string;
}

interface AccountRow {
  id: string;
  bank_code: string;
  customer_id: string | null;
  account_number: string;
  ifsc: string;
  type: AccountType;
  gl_code: GlCode | null;
  status: AccountStatus;
  overdraft_limit: number;
  per_txn_limit: number;
  daily_debit_limit: number;
  holder_name: string;
  opened_at: string;
  updated_at: string;
  version: number;
}

interface ApprovalRow {
  id: string;
  bank_code: string;
  account_id: string;
  kind: ApprovalKind;
  payload: string;
  reason: string;
  status: string;
  maker_id: string;
  checker_id: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface LimitPatch {
  perTxnLimit?: number;
  dailyDebitLimit?: number;
  overdraftLimit?: number;
}

function bankView(b: BankRow) {
  return { code: b.code, name: b.name, ifscPrefix: b.ifsc_prefix, vpaHandle: b.vpa_handle, status: b.status };
}

function customerView(c: CustomerRow) {
  return { id: c.id, bankCode: c.bank_code, userId: c.user_id, fullName: c.full_name, phone: c.phone, kycTier: c.kyc_tier, createdAt: c.created_at };
}

export function accountView(a: AccountRow, masked = false) {
  return {
    id: a.id,
    bankCode: a.bank_code,
    customerId: a.customer_id,
    accountNumber: masked ? maskAccountNumber(a.account_number) : a.account_number,
    ifsc: a.ifsc,
    type: a.type,
    glCode: a.gl_code,
    status: a.status,
    overdraftLimit: a.overdraft_limit,
    perTxnLimit: a.per_txn_limit,
    dailyDebitLimit: a.daily_debit_limit,
    holderName: a.holder_name,
    openedAt: a.opened_at,
    updatedAt: a.updated_at,
    version: a.version,
  };
}

function approvalView(r: ApprovalRow) {
  return {
    id: r.id,
    bankCode: r.bank_code,
    accountId: r.account_id,
    kind: r.kind,
    payload: JSON.parse(r.payload) as unknown,
    reason: r.reason,
    status: r.status,
    makerId: r.maker_id,
    checkerId: r.checker_id,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly users: UserDirectory,
    private readonly ledger: LedgerPort | null,
  ) {}

  async pushToLedger(bankCode: string, accountId: string): Promise<boolean> {
    if (!this.ledger) return false;
    try {
      await this.ledger.refresh(bankCode, accountId);
      return true;
    } catch {
      return false;
    }
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private nextAccountNumber(bank: BankRow): string {
    const row = this.db.prepare('SELECT next_value FROM account_numbers WHERE bank_code = ?').get(bank.code) as { next_value: number } | undefined;
    const value = row?.next_value ?? 1;
    this.db
      .prepare('INSERT INTO account_numbers (bank_code, next_value) VALUES (?, ?) ON CONFLICT(bank_code) DO UPDATE SET next_value = excluded.next_value')
      .run(bank.code, value + 1);
    return `${bank.number_prefix}${String(value).padStart(8, '0')}`;
  }

  private ifsc(bank: BankRow): string {
    return `${bank.ifsc_prefix}0000001`;
  }

  private insertAccount(a: Omit<AccountRow, 'opened_at' | 'updated_at' | 'version'>): AccountRow {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, bank_code, customer_id, account_number, ifsc, type, gl_code, status, overdraft_limit, per_txn_limit, daily_debit_limit, holder_name, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.bank_code, a.customer_id, a.account_number, a.ifsc, a.type, a.gl_code, a.status, a.overdraft_limit, a.per_txn_limit, a.daily_debit_limit, a.holder_name, now, now);
    emit(
      this.db,
      {
        topic: TOPICS.account,
        type: EVENT_TYPES.AccountOpened,
        key: a.id,
        payload: {
          accountId: a.id,
          bankCode: a.bank_code,
          customerId: a.customer_id,
          type: a.type,
          glCode: a.gl_code,
          status: a.status,
          overdraftLimit: a.overdraft_limit,
          perTxnLimit: a.per_txn_limit,
          dailyDebitLimit: a.daily_debit_limit,
          holderName: a.holder_name,
        },
      },
      this.clock,
    );
    return this.accountRow(a.id);
  }

  ensureBanks(): void {
    tx(this.db, () => {
      for (const b of SEED_BANKS) {
        this.db
          .prepare('INSERT OR IGNORE INTO banks (code, name, ifsc_prefix, vpa_handle, number_prefix, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(b.code, b.name, b.ifscPrefix, b.vpaHandle, b.numberPrefix, 'ACTIVE', this.now());
        const bank = this.bankRow(b.code);
        for (const gl of GL_CODES) {
          if (this.db.prepare('SELECT 1 FROM accounts WHERE bank_code = ? AND gl_code = ?').get(b.code, gl)) continue;
          this.insertAccount({
            id: newId('acc'),
            bank_code: b.code,
            customer_id: null,
            account_number: this.nextAccountNumber(bank),
            ifsc: this.ifsc(bank),
            type: 'INTERNAL',
            gl_code: gl,
            status: 'ACTIVE',
            overdraft_limit: 0,
            per_txn_limit: INTERNAL_LIMIT,
            daily_debit_limit: INTERNAL_LIMIT,
            holder_name: `${b.name} ${GL_NAMES[gl]}`,
          });
        }
      }
    });
  }

  private bankRow(code: string): BankRow {
    const b = this.db.prepare('SELECT * FROM banks WHERE code = ?').get(code) as BankRow | undefined;
    if (!b) throw notFound('BANK_NOT_FOUND', `bank ${code} not found`);
    return b;
  }

  listBanks() {
    return (this.db.prepare('SELECT * FROM banks ORDER BY code').all() as BankRow[]).map(bankView);
  }

  getBank(code: string) {
    return bankView(this.bankRow(code));
  }

  bankByHandle(handle: string) {
    const b = this.db.prepare('SELECT * FROM banks WHERE vpa_handle = ?').get(handle) as BankRow | undefined;
    if (!b) throw notFound('BANK_NOT_FOUND', `no bank uses handle ${handle}`);
    return bankView(b);
  }

  private customerRow(id: string): CustomerRow {
    const c = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined;
    if (!c) throw notFound('CUSTOMER_NOT_FOUND', 'customer not found');
    return c;
  }

  private accountRow(id: string): AccountRow {
    const a = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'account not found');
    return a;
  }

  createCustomer(actor: Principal, input: { bankCode: string; fullName: string; phone: string; kycTier: KycTier }) {
    assertBankScope(actor, input.bankCode);
    return tx(this.db, () => {
      this.bankRow(input.bankCode);
      if (this.db.prepare('SELECT 1 FROM customers WHERE bank_code = ? AND phone = ?').get(input.bankCode, input.phone)) {
        throw conflict('CUSTOMER_EXISTS', 'a customer with this phone already exists at this bank');
      }
      const id = newId('cus');
      this.db
        .prepare('INSERT INTO customers (id, bank_code, user_id, full_name, phone, kyc_tier, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
        .run(id, input.bankCode, input.fullName, input.phone, input.kycTier, this.now());
      return customerView(this.customerRow(id));
    });
  }

  getCustomer(actor: Principal, id: string) {
    const c = this.customerRow(id);
    assertBankScope(actor, c.bank_code);
    const accounts = (this.db.prepare('SELECT * FROM accounts WHERE customer_id = ? ORDER BY opened_at').all(id) as AccountRow[]).map((a) => accountView(a));
    return { ...customerView(c), accounts };
  }

  findCustomers(actor: Principal, bankCode: string, phone?: string) {
    assertBankScope(actor, bankCode);
    const rows = phone
      ? (this.db.prepare('SELECT * FROM customers WHERE bank_code = ? AND phone = ?').all(bankCode, phone) as CustomerRow[])
      : (this.db.prepare('SELECT * FROM customers WHERE bank_code = ? ORDER BY created_at DESC LIMIT 200').all(bankCode) as CustomerRow[]);
    return rows.map(customerView);
  }

  openAccount(actor: Principal, input: { customerId: string; type: 'SAVINGS' | 'CURRENT' }) {
    return tx(this.db, () => {
      const c = this.customerRow(input.customerId);
      assertBankScope(actor, c.bank_code);
      const bank = this.bankRow(c.bank_code);
      const limits = TIER_LIMITS[c.kyc_tier];
      const row = this.insertAccount({
        id: newId('acc'),
        bank_code: c.bank_code,
        customer_id: c.id,
        account_number: this.nextAccountNumber(bank),
        ifsc: this.ifsc(bank),
        type: input.type,
        gl_code: null,
        status: 'PENDING',
        overdraft_limit: 0,
        per_txn_limit: limits.perTxnLimit,
        daily_debit_limit: limits.dailyDebitLimit,
        holder_name: c.full_name,
      });
      return accountView(row);
    });
  }

  getAccount(actor: Principal, id: string) {
    const a = this.accountRow(id);
    if (actor.kind === 'customer') {
      const owner = a.customer_id ? this.customerRow(a.customer_id).user_id : null;
      if (owner !== actor.sub) throw notFound('ACCOUNT_NOT_FOUND', 'account not found');
      return accountView(a, true);
    }
    assertBankScope(actor, a.bank_code);
    return { ...accountView(a), history: this.history(id) };
  }

  private history(accountId: string) {
    return this.db
      .prepare('SELECT from_status AS "from", to_status AS "to", reason, actor, at FROM status_history WHERE account_id = ? ORDER BY id')
      .all(accountId);
  }

  listAccounts(actor: Principal, filter: { bankCode: string; customerId?: string; status?: string; type?: string }) {
    assertBankScope(actor, filter.bankCode);
    const clauses = ['bank_code = ?'];
    const args: unknown[] = [filter.bankCode];
    if (filter.customerId) {
      clauses.push('customer_id = ?');
      args.push(filter.customerId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      args.push(filter.status);
    }
    if (filter.type) {
      clauses.push('type = ?');
      args.push(filter.type);
    }
    return (this.db.prepare(`SELECT * FROM accounts WHERE ${clauses.join(' AND ')} ORDER BY opened_at LIMIT 500`).all(...args) as AccountRow[]).map((a) =>
      accountView(a),
    );
  }

  private changeStatus(a: AccountRow, to: AccountStatus, reason: string | null, actor: string): AccountRow {
    if (!canTransition(a.status, to)) throw conflict('INVALID_TRANSITION', `cannot move account from ${a.status} to ${to}`);
    const now = this.now();
    const r = this.db
      .prepare('UPDATE accounts SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(to, now, a.id, a.version);
    if (r.changes === 0) throw conflict('CONCURRENT_UPDATE', 'account changed concurrently, retry');
    this.db
      .prepare('INSERT INTO status_history (account_id, from_status, to_status, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, a.status, to, reason, actor, now);
    emit(
      this.db,
      { topic: TOPICS.account, type: EVENT_TYPES.AccountStatusChanged, key: a.id, payload: { accountId: a.id, bankCode: a.bank_code, from: a.status, to, reason } },
      this.clock,
    );
    return this.accountRow(a.id);
  }

  async directAndSync(actor: Principal, id: string, action: DirectAction, reason: string | null) {
    const account = this.direct(actor, id, action, reason);
    const ledgerSynced = await this.pushToLedger(account.bankCode, account.id);
    return { ...account, ledgerSynced };
  }

  direct(actor: Principal, id: string, action: DirectAction, reason: string | null) {
    return tx(this.db, () => {
      const a = this.accountRow(id);
      assertBankScope(actor, a.bank_code);
      if (a.type === 'INTERNAL') throw forbidden('INTERNAL_ACCOUNT', 'internal GL accounts cannot change status');
      const rule = DIRECT_ACTIONS[action];
      if (!(rule.from as readonly AccountStatus[]).includes(a.status)) throw conflict('INVALID_TRANSITION', `${action} requires status ${rule.from.join(' or ')}, account is ${a.status}`);
      return accountView(this.changeStatus(a, rule.to, reason, actor.sub));
    });
  }

  private validateLimitPatch(a: AccountRow, patch: LimitPatch): Required<LimitPatch> {
    if (patch.perTxnLimit === undefined && patch.dailyDebitLimit === undefined && patch.overdraftLimit === undefined) {
      throw badRequest('LIMIT_PATCH_EMPTY', 'at least one limit must be provided');
    }
    const next = {
      perTxnLimit: patch.perTxnLimit ?? a.per_txn_limit,
      dailyDebitLimit: patch.dailyDebitLimit ?? a.daily_debit_limit,
      overdraftLimit: patch.overdraftLimit ?? a.overdraft_limit,
    };
    if (next.perTxnLimit > next.dailyDebitLimit) throw unprocessable('LIMIT_INCONSISTENT', 'per transaction limit cannot exceed the daily limit');
    const tier = this.customerRow(a.customer_id!).kyc_tier;
    const cap = TIER_LIMITS[tier];
    if (next.perTxnLimit > cap.perTxnLimit || next.dailyDebitLimit > cap.dailyDebitLimit) {
      throw unprocessable('LIMIT_ABOVE_TIER', `limits exceed the ${tier} KYC tier caps`);
    }
    if (next.overdraftLimit > 0 && a.type !== 'CURRENT') throw unprocessable('OVERDRAFT_NOT_ALLOWED', 'only current accounts can have an overdraft');
    if (next.overdraftLimit > MAX_OVERDRAFT) throw unprocessable('OVERDRAFT_TOO_HIGH', 'overdraft limit exceeds the maximum');
    return next;
  }

  private validateApproval(a: AccountRow, kind: ApprovalKind, payload: LimitPatch): void {
    if (a.type === 'INTERNAL') throw forbidden('INTERNAL_ACCOUNT', 'internal GL accounts cannot be changed');
    if (kind === 'LIMIT_CHANGE') {
      if (a.status === 'CLOSED') throw conflict('INVALID_TRANSITION', 'closed accounts cannot change limits');
      this.validateLimitPatch(a, payload);
      return;
    }
    const target = APPROVAL_TARGET[kind];
    if (!target.from.includes(a.status)) throw conflict('INVALID_TRANSITION', `${kind} is not allowed while the account is ${a.status}`);
  }

  createApproval(actor: Principal, input: { accountId: string; kind: ApprovalKind; payload: LimitPatch; reason: string }) {
    return tx(this.db, () => {
      const a = this.accountRow(input.accountId);
      assertBankScope(actor, a.bank_code);
      this.validateApproval(a, input.kind, input.payload);
      if (this.db.prepare("SELECT 1 FROM approval_requests WHERE account_id = ? AND kind = ? AND status = 'PENDING'").get(a.id, input.kind)) {
        throw conflict('APPROVAL_PENDING', `a ${input.kind} request is already pending for this account`);
      }
      const id = newId('apr');
      this.db
        .prepare(
          "INSERT INTO approval_requests (id, bank_code, account_id, kind, payload, reason, status, maker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)",
        )
        .run(id, a.bank_code, a.id, input.kind, JSON.stringify(input.payload ?? {}), input.reason, actor.sub, this.now());
      return approvalView(this.approvalRow(id));
    });
  }

  private approvalRow(id: string): ApprovalRow {
    const r = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as ApprovalRow | undefined;
    if (!r) throw notFound('APPROVAL_NOT_FOUND', 'approval request not found');
    return r;
  }

  async approve(actor: Principal, id: string, note: string | null) {
    const pre = this.approvalRow(id);
    assertBankScope(actor, pre.bank_code);
    if (pre.kind === 'CLOSE' && this.ledger) {
      const bal = await this.ledger.getBalance(pre.bank_code, pre.account_id);
      if (bal.ledgerBalance !== 0 || bal.heldAmount !== 0) {
        throw unprocessable('BALANCE_NOT_ZERO', 'account must have zero balance and no holds before closing', bal);
      }
    }
    const result = tx(this.db, () => {
      const r = this.approvalRow(id);
      if (r.status !== 'PENDING') throw conflict('APPROVAL_NOT_PENDING', `request is already ${r.status}`);
      if (r.maker_id === actor.sub) throw forbidden('MAKER_CANNOT_APPROVE', 'the maker of a request cannot approve it');
      const a = this.accountRow(r.account_id);
      const payload = JSON.parse(r.payload) as LimitPatch;
      this.validateApproval(a, r.kind, payload);
      let updated: AccountRow;
      if (r.kind === 'LIMIT_CHANGE') {
        const next = this.validateLimitPatch(a, payload);
        const res = this.db
          .prepare('UPDATE accounts SET per_txn_limit = ?, daily_debit_limit = ?, overdraft_limit = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(next.perTxnLimit, next.dailyDebitLimit, next.overdraftLimit, this.now(), a.id, a.version);
        if (res.changes === 0) throw conflict('CONCURRENT_UPDATE', 'account changed concurrently, retry');
        emit(
          this.db,
          { topic: TOPICS.account, type: EVENT_TYPES.LimitChanged, key: a.id, payload: { accountId: a.id, bankCode: a.bank_code, ...next } },
          this.clock,
        );
        updated = this.accountRow(a.id);
      } else {
        updated = this.changeStatus(a, APPROVAL_TARGET[r.kind].to, r.reason, `${r.maker_id}+${actor.sub}`);
      }
      this.db
        .prepare("UPDATE approval_requests SET status = 'APPROVED', checker_id = ?, decision_note = ?, decided_at = ? WHERE id = ?")
        .run(actor.sub, note, this.now(), id);
      return { approval: approvalView(this.approvalRow(id)), account: accountView(updated) };
    });
    const ledgerSynced = await this.pushToLedger(result.account.bankCode, result.account.id);
    return { ...result, ledgerSynced };
  }

  reject(actor: Principal, id: string, note: string) {
    return tx(this.db, () => {
      const r = this.approvalRow(id);
      assertBankScope(actor, r.bank_code);
      if (r.status !== 'PENDING') throw conflict('APPROVAL_NOT_PENDING', `request is already ${r.status}`);
      if (r.maker_id === actor.sub) throw forbidden('MAKER_CANNOT_APPROVE', 'the maker should cancel instead of rejecting');
      this.db
        .prepare("UPDATE approval_requests SET status = 'REJECTED', checker_id = ?, decision_note = ?, decided_at = ? WHERE id = ?")
        .run(actor.sub, note, this.now(), id);
      return approvalView(this.approvalRow(id));
    });
  }

  cancel(actor: Principal, id: string) {
    return tx(this.db, () => {
      const r = this.approvalRow(id);
      assertBankScope(actor, r.bank_code);
      if (r.status !== 'PENDING') throw conflict('APPROVAL_NOT_PENDING', `request is already ${r.status}`);
      if (r.maker_id !== actor.sub) throw forbidden('ONLY_MAKER_CAN_CANCEL', 'only the maker can cancel a request');
      this.db.prepare("UPDATE approval_requests SET status = 'CANCELLED', decided_at = ? WHERE id = ?").run(this.now(), id);
      return approvalView(this.approvalRow(id));
    });
  }

  listApprovals(actor: Principal, bankCode: string, status?: string) {
    assertBankScope(actor, bankCode);
    const rows = status
      ? (this.db.prepare('SELECT * FROM approval_requests WHERE bank_code = ? AND status = ? ORDER BY created_at DESC').all(bankCode, status) as ApprovalRow[])
      : (this.db.prepare('SELECT * FROM approval_requests WHERE bank_code = ? ORDER BY created_at DESC LIMIT 200').all(bankCode) as ApprovalRow[]);
    return rows.map(approvalView);
  }

  async discover(actor: Principal, bankCode: string) {
    this.bankRow(bankCode);
    const user = await this.users.getUser(actor.sub);
    return tx(this.db, () => {
      const c = this.db.prepare('SELECT * FROM customers WHERE bank_code = ? AND phone = ?').get(bankCode, user.phone) as CustomerRow | undefined;
      if (!c) return { bankCode, accounts: [] };
      if (c.user_id && c.user_id !== actor.sub) throw conflict('CUSTOMER_LINKED_ELSEWHERE', 'this bank customer is linked to another user');
      if (!c.user_id) this.db.prepare('UPDATE customers SET user_id = ? WHERE id = ?').run(actor.sub, c.id);
      const accounts = (this.db.prepare("SELECT * FROM accounts WHERE customer_id = ? AND status != 'CLOSED' ORDER BY opened_at").all(c.id) as AccountRow[]).map(
        (a) => accountView(a, true),
      );
      return { bankCode, accounts };
    });
  }

  myAccounts(userId: string) {
    const rows = this.db
      .prepare('SELECT a.* FROM accounts a JOIN customers c ON c.id = a.customer_id WHERE c.user_id = ? ORDER BY a.bank_code, a.opened_at')
      .all(userId) as AccountRow[];
    return rows.map((a) => accountView(a, true));
  }

  internalAccount(id: string): InternalAccount {
    const a = this.accountRow(id);
    const userId = a.customer_id ? this.customerRow(a.customer_id).user_id : null;
    return {
      id: a.id,
      bankCode: a.bank_code,
      accountNumber: a.account_number,
      ifsc: a.ifsc,
      type: a.type,
      glCode: a.gl_code,
      status: a.status,
      overdraftLimit: a.overdraft_limit,
      perTxnLimit: a.per_txn_limit,
      dailyDebitLimit: a.daily_debit_limit,
      customerId: a.customer_id,
      userId,
      holderName: a.holder_name,
    };
  }

  glAccount(bankCode: string, glCode: GlCode): InternalAccount {
    const id = this.db.prepare('SELECT id FROM accounts WHERE bank_code = ? AND gl_code = ?').pluck().get(bankCode, glCode) as string | undefined;
    if (!id) throw notFound('GL_NOT_FOUND', `no ${glCode} account at ${bankCode}`);
    return this.internalAccount(id);
  }
}
