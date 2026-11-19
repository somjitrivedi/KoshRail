import { EVENT_TYPES, TOPICS, type Bank, type InternalAccount, type ResolveResult } from '@kosh/contracts';
import {
  AppError,
  badRequest,
  type Clock,
  conflict,
  type Db,
  emit,
  forbidden,
  isAppError,
  newId,
  notFound,
  tx,
  unprocessable,
} from '@kosh/service-kit';
import { TtlLru } from './cache.ts';
import { handleProblem, maskName, MAX_VPAS_PER_USER, parseAddress } from './rules.ts';

export interface AccountLookup {
  getAccount(id: string): Promise<InternalAccount>;
  listBanks(): Promise<Bank[]>;
}

interface VpaRow {
  id: string;
  address: string;
  handle: string;
  psp_handle: string;
  user_id: string;
  status: 'ACTIVE' | 'DISABLED';
  created_at: string;
}

interface LinkRow {
  id: string;
  vpa_id: string;
  account_id: string;
  bank_code: string;
  is_default: number;
  status: string;
  linked_at: string;
}

type CachedResolve = { ok: Required<ResolveResult> } | { err: { status: number; code: string; message: string } };

export class VpaService {
  readonly cache: TtlLru<CachedResolve>;
  private banks: Bank[] | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly accounts: AccountLookup,
    cacheTtlMs = 60000,
  ) {
    this.cache = new TtlLru(10000, cacheTtlMs);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private async pspHandles(): Promise<Set<string>> {
    if (!this.banks) this.banks = await this.accounts.listBanks();
    return new Set(this.banks.map((b) => b.vpaHandle));
  }

  private vpaRow(address: string): VpaRow | undefined {
    return this.db.prepare('SELECT * FROM vpas WHERE address = ?').get(address.toLowerCase()) as VpaRow | undefined;
  }

  private ownedVpa(userId: string, address: string): VpaRow {
    const v = this.vpaRow(address);
    if (!v || v.user_id !== userId) throw notFound('VPA_NOT_FOUND', 'VPA not found');
    return v;
  }

  private links(vpaId: string): LinkRow[] {
    return this.db.prepare("SELECT * FROM vpa_links WHERE vpa_id = ? AND status = 'ACTIVE' ORDER BY linked_at, id").all(vpaId) as LinkRow[];
  }

  private view(v: VpaRow) {
    return {
      id: v.id,
      address: v.address,
      status: v.status,
      createdAt: v.created_at,
      links: this.links(v.id).map((l) => ({ accountId: l.account_id, bankCode: l.bank_code, isDefault: l.is_default === 1, linkedAt: l.linked_at })),
    };
  }

  async availability(handle: string, psp: string) {
    const problem = handleProblem(handle);
    if (problem) return { address: `${handle}@${psp}`, available: false, reason: problem };
    if (!(await this.pspHandles()).has(psp)) return { address: `${handle}@${psp}`, available: false, reason: 'unknown PSP handle' };
    const taken = Boolean(this.vpaRow(`${handle}@${psp}`));
    return { address: `${handle}@${psp}`, available: !taken, reason: taken ? 'already taken' : null };
  }

  async create(userId: string, handle: string, psp: string) {
    const problem = handleProblem(handle);
    if (problem) throw badRequest('VPA_HANDLE_INVALID', problem);
    if (!(await this.pspHandles()).has(psp)) throw badRequest('PSP_UNKNOWN', `unknown PSP handle ${psp}`);
    const address = `${handle}@${psp}`;
    return tx(this.db, () => {
      if (this.vpaRow(address)) throw conflict('VPA_TAKEN', `${address} is already taken`);
      const count = this.db.prepare("SELECT COUNT(*) FROM vpas WHERE user_id = ? AND status = 'ACTIVE'").pluck().get(userId) as number;
      if (count >= MAX_VPAS_PER_USER) throw unprocessable('VPA_LIMIT', `a user can hold at most ${MAX_VPAS_PER_USER} active VPAs`);
      const id = newId('vpa');
      this.db.prepare("INSERT INTO vpas (id, address, handle, psp_handle, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)").run(id, address, handle, psp, userId, this.now());
      emit(this.db, { topic: TOPICS.vpa, type: EVENT_TYPES.VpaCreated, key: address, payload: { vpaId: id, address, userId } }, this.clock);
      return this.view(this.vpaRow(address)!);
    });
  }

  mine(userId: string) {
    return (this.db.prepare('SELECT * FROM vpas WHERE user_id = ? ORDER BY created_at').all(userId) as VpaRow[]).map((v) => this.view(v));
  }

  private upsertAccountView(a: InternalAccount): void {
    this.db
      .prepare(
        `INSERT INTO account_view (account_id, bank_code, status, holder_name, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, holder_name = excluded.holder_name, user_id = excluded.user_id, updated_at = excluded.updated_at`,
      )
      .run(a.id, a.bankCode, a.status, a.holderName, a.userId, this.now());
  }

  async link(userId: string, address: string, accountId: string) {
    this.ownedVpa(userId, address);
    let account: InternalAccount;
    try {
      account = await this.accounts.getAccount(accountId);
    } catch (err) {
      if (isAppError(err) && err.status === 404) throw notFound('ACCOUNT_NOT_FOUND', 'account not found');
      throw err;
    }
    if (account.type === 'INTERNAL' || account.userId !== userId) throw forbidden('ACCOUNT_NOT_OWNED', 'account does not belong to this user; discover it from the bank first');
    if (account.status !== 'ACTIVE') throw unprocessable('ACCOUNT_INACTIVE', `account is ${account.status}`);
    return tx(this.db, () => {
      const v = this.ownedVpa(userId, address);
      if (v.status !== 'ACTIVE') throw unprocessable('VPA_DISABLED', 'VPA is disabled');
      this.upsertAccountView(account);
      const existing = this.links(v.id);
      if (existing.some((l) => l.account_id === accountId)) throw conflict('ALREADY_LINKED', 'account is already linked to this VPA');
      const isDefault = existing.length === 0;
      this.db
        .prepare("INSERT INTO vpa_links (id, vpa_id, account_id, bank_code, is_default, status, linked_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)")
        .run(newId('lnk'), v.id, accountId, account.bankCode, isDefault ? 1 : 0, this.now());
      emit(
        this.db,
        { topic: TOPICS.vpa, type: EVENT_TYPES.VpaLinked, key: v.address, payload: { vpaId: v.id, address: v.address, accountId, bankCode: account.bankCode, isDefault } },
        this.clock,
      );
      this.cache.delete(v.address);
      return this.view(v);
    });
  }

  setDefault(userId: string, address: string, accountId: string) {
    return tx(this.db, () => {
      const v = this.ownedVpa(userId, address);
      const links = this.links(v.id);
      const target = links.find((l) => l.account_id === accountId);
      if (!target) throw notFound('LINK_NOT_FOUND', 'account is not linked to this VPA');
      this.db.prepare("UPDATE vpa_links SET is_default = 0 WHERE vpa_id = ? AND status = 'ACTIVE'").run(v.id);
      this.db.prepare('UPDATE vpa_links SET is_default = 1 WHERE id = ?').run(target.id);
      emit(
        this.db,
        { topic: TOPICS.vpa, type: EVENT_TYPES.VpaLinked, key: v.address, payload: { vpaId: v.id, address: v.address, accountId, bankCode: target.bank_code, isDefault: true } },
        this.clock,
      );
      this.cache.delete(v.address);
      return this.view(v);
    });
  }

  unlink(userId: string, address: string, accountId: string) {
    return tx(this.db, () => {
      const v = this.ownedVpa(userId, address);
      const links = this.links(v.id);
      const target = links.find((l) => l.account_id === accountId);
      if (!target) throw notFound('LINK_NOT_FOUND', 'account is not linked to this VPA');
      this.db.prepare("UPDATE vpa_links SET status = 'UNLINKED', is_default = 0, unlinked_at = ? WHERE id = ?").run(this.now(), target.id);
      if (target.is_default === 1) {
        const next = links.find((l) => l.id !== target.id);
        if (next) this.db.prepare('UPDATE vpa_links SET is_default = 1 WHERE id = ?').run(next.id);
      }
      emit(this.db, { topic: TOPICS.vpa, type: EVENT_TYPES.VpaUnlinked, key: v.address, payload: { vpaId: v.id, address: v.address, accountId } }, this.clock);
      this.cache.delete(v.address);
      return this.view(v);
    });
  }

  disable(userId: string, address: string) {
    return tx(this.db, () => {
      const v = this.ownedVpa(userId, address);
      if (v.status === 'DISABLED') return this.view(v);
      this.db.prepare("UPDATE vpas SET status = 'DISABLED', disabled_at = ? WHERE id = ?").run(this.now(), v.id);
      emit(this.db, { topic: TOPICS.vpa, type: EVENT_TYPES.VpaDisabled, key: v.address, payload: { vpaId: v.id, address: v.address } }, this.clock);
      this.cache.delete(v.address);
      return this.view(this.vpaRow(v.address)!);
    });
  }

  private resolveUncached(address: string): CachedResolve {
    const parsed = parseAddress(address);
    if (!parsed) return { err: { status: 400, code: 'VPA_FORMAT', message: 'address must look like handle@psp' } };
    const v = this.vpaRow(address);
    if (!v) return { err: { status: 404, code: 'VPA_NOT_FOUND', message: 'VPA not found' } };
    if (v.status !== 'ACTIVE') return { err: { status: 422, code: 'VPA_DISABLED', message: 'VPA is disabled' } };
    const link = this.links(v.id).find((l) => l.is_default === 1);
    if (!link) return { err: { status: 422, code: 'VPA_NOT_LINKED', message: 'VPA has no linked account' } };
    const acct = this.db.prepare('SELECT * FROM account_view WHERE account_id = ?').get(link.account_id) as
      | { status: string; holder_name: string; bank_code: string }
      | undefined;
    if (!acct || acct.status !== 'ACTIVE') return { err: { status: 422, code: 'ACCOUNT_INACTIVE', message: 'linked account cannot receive or send payments' } };
    return { ok: { address: v.address, maskedName: maskName(acct.holder_name), bankCode: acct.bank_code, accountRef: link.account_id, userId: v.user_id, status: 'ACTIVE' } };
  }

  resolve(address: string, includeAccountRef: boolean): ResolveResult {
    const key = address.toLowerCase();
    let r = this.cache.get(key);
    if (!r) {
      r = this.resolveUncached(key);
      if ('ok' in r) this.cache.set(key, r);
    }
    if ('err' in r) throw new AppError(r.err.status, r.err.code, r.err.message);
    if (includeAccountRef) return r.ok;
    const { accountRef: _hiddenAccount, userId: _hiddenUser, ...pub } = r.ok;
    return pub;
  }

  applyAccountEvent(type: string, payload: Record<string, unknown>): void {
    const accountId = String(payload.accountId);
    if (type === EVENT_TYPES.AccountOpened) {
      this.db
        .prepare('INSERT OR IGNORE INTO account_view (account_id, bank_code, status, holder_name, user_id, updated_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(accountId, String(payload.bankCode), String(payload.status), String(payload.holderName), this.now());
    } else if (type === EVENT_TYPES.AccountStatusChanged) {
      const r = this.db
        .prepare('UPDATE account_view SET status = ?, updated_at = ? WHERE account_id = ? AND status = ?')
        .run(String(payload.to), this.now(), accountId, String(payload.from));
      if (r.changes === 0) return;
    } else {
      return;
    }
    const addresses = this.db
      .prepare("SELECT v.address FROM vpa_links l JOIN vpas v ON v.id = l.vpa_id WHERE l.account_id = ? AND l.status = 'ACTIVE'")
      .pluck()
      .all(accountId) as string[];
    for (const a of addresses) this.cache.delete(a);
  }
}
