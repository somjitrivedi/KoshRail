import type { Request } from 'express';
import { z } from 'zod';
import type { InternalAccount } from '@kosh/contracts';
import {
  assertBankScope,
  type Clock,
  createApp,
  type Db,
  getCaller,
  idempotencyKey,
  idempotent,
  isAppError,
  type Logger,
  notFound,
  param,
  parse,
  queryInt,
  queryString,
  requireServiceOrStaff,
  requireStaff,
  sendStored,
  ServiceClient,
  unprocessable,
} from '@kosh/service-kit';
import { BankLedger, ENTRY_KINDS } from './ledger.ts';

const Amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Reference = z.string().trim().min(3).max(120);
const PostEntry = z.object({
  kind: z.enum(ENTRY_KINDS),
  reference: Reference,
  description: z.string().max(200).nullable().optional(),
  postings: z.array(z.object({ accountId: z.string().min(1), amount: z.number().int() })).min(2).max(20),
});
const CashBody = z.object({ accountId: z.string().min(1), amount: Amount, reference: Reference });
const HoldBody = z.object({ accountId: z.string().min(1), amount: Amount, reference: Reference, ttlSeconds: z.number().int().default(300) });
const CaptureBody = z.object({ counterAccountId: z.string().min(1), description: z.string().max(200).nullable().optional() });
const ReverseBody = z.object({ reason: z.string().trim().min(3).max(200) });

export interface AccountDirectory {
  getAccount(id: string): Promise<InternalAccount>;
  getGlAccount(bankCode: string, glCode: string): Promise<InternalAccount>;
}

export function httpAccountDirectory(accountUrl: string, token: string): AccountDirectory {
  const client = new ServiceClient(accountUrl, { token, caller: 'ledger-service' });
  return {
    getAccount: (id) => client.get<InternalAccount>(`/internal/accounts/${encodeURIComponent(id)}`),
    getGlAccount: (bankCode, glCode) => client.get<InternalAccount>(`/internal/banks/${bankCode}/gl/${glCode}`),
  };
}

export interface LedgerDeps {
  dbs: Map<string, Db>;
  clock: Clock;
  log: Logger;
  internalToken: string;
  accounts: AccountDirectory;
}

export function buildLedgers(dbs: Map<string, Db>, clock: Clock): Map<string, BankLedger> {
  return new Map([...dbs].map(([code, db]) => [code, new BankLedger(code, db, clock)]));
}

export function buildLedgerApp(deps: LedgerDeps) {
  const ledgers = buildLedgers(deps.dbs, deps.clock);

  function ledgerFor(code: string): BankLedger {
    const l = ledgers.get(code);
    if (!l) throw notFound('BANK_NOT_FOUND', `no ledger for bank ${code}`);
    return l;
  }

  async function sync(l: BankLedger, ids: string[]): Promise<void> {
    const { unknown, inactive } = l.accountsToRefresh(ids);
    for (const id of unknown) {
      let a: InternalAccount;
      try {
        a = await deps.accounts.getAccount(id);
      } catch (err) {
        if (isAppError(err) && err.status === 404) throw unprocessable('ACCOUNT_UNKNOWN', `account ${id} does not exist`);
        throw err;
      }
      l.upsertAccount(a);
    }
    for (const id of inactive) {
      try {
        l.upsertAccount(await deps.accounts.getAccount(id));
      } catch (err) {
        deps.log.warn('could not refresh inactive account; using local projection', { accountId: id, err: err as Error });
      }
    }
  }

  async function syncGl(l: BankLedger, glCode: string): Promise<void> {
    if (l.hasGl(glCode)) return;
    try {
      l.upsertAccount(await deps.accounts.getGlAccount(l.bankCode, glCode));
    } catch (err) {
      if (isAppError(err) && err.status === 404) throw unprocessable('GL_UNKNOWN', `${glCode} GL does not exist for ${l.bankCode}`);
      throw err;
    }
  }

  function actor(req: Request): string {
    const c = getCaller(req);
    if (c.kind === 'user') return `staff:${c.principal.sub}`;
    if (c.kind === 'service') return `svc:${c.name}`;
    return 'anonymous';
  }

  function readAccess(req: Request, bankCode: string): void {
    const c = requireServiceOrStaff(req, ['BANK_OPS', 'SWITCH_OPS']);
    if (c.kind === 'user') assertBankScope(c.principal, bankCode);
  }

  function writeAccess(req: Request): void {
    requireServiceOrStaff(req, ['ADMIN']);
  }

  function cashAccess(req: Request, bankCode: string): void {
    const c = getCaller(req);
    if (c.kind === 'service') return;
    const p = requireStaff(req, ['BANK_OPS']);
    assertBankScope(p, bankCode);
  }

  const app = createApp({ name: 'ledger-service', internalToken: deps.internalToken, log: deps.log }, (r) => {
    r.post('/banks/:bank/entries', async (req, res) => {
      writeAccess(req);
      const l = ledgerFor(param(req, 'bank'));
      const body = parse(PostEntry, req.body);
      const key = idempotencyKey(req)!;
      await sync(l, body.postings.map((p) => p.accountId));
      const createdBy = actor(req);
      sendStored(res, idempotent(l.db, 'entries', key, body, () => ({ status: 201, body: l.post({ ...body, createdBy }) })));
    });

    r.post('/banks/:bank/deposits', async (req, res) => {
      const bank = param(req, 'bank');
      cashAccess(req, bank);
      const l = ledgerFor(bank);
      const body = parse(CashBody, req.body);
      const key = idempotencyKey(req)!;
      await sync(l, [body.accountId]);
      await syncGl(l, 'CASH');
      const createdBy = actor(req);
      sendStored(res, idempotent(l.db, 'deposits', key, body, () => ({ status: 201, body: l.deposit(body.accountId, body.amount, body.reference, createdBy) })));
    });

    r.post('/banks/:bank/withdrawals', async (req, res) => {
      const bank = param(req, 'bank');
      cashAccess(req, bank);
      const l = ledgerFor(bank);
      const body = parse(CashBody, req.body);
      const key = idempotencyKey(req)!;
      await sync(l, [body.accountId]);
      await syncGl(l, 'CASH');
      const createdBy = actor(req);
      sendStored(res, idempotent(l.db, 'withdrawals', key, body, () => ({ status: 201, body: l.withdraw(body.accountId, body.amount, body.reference, createdBy) })));
    });

    r.post('/banks/:bank/holds', async (req, res) => {
      writeAccess(req);
      const l = ledgerFor(param(req, 'bank'));
      const body = parse(HoldBody, req.body);
      const key = idempotencyKey(req)!;
      await sync(l, [body.accountId]);
      sendStored(res, idempotent(l.db, 'holds', key, body, () => ({ status: 201, body: l.placeHold(body) })));
    });

    r.post('/banks/:bank/holds/:id/capture', async (req, res) => {
      writeAccess(req);
      const l = ledgerFor(param(req, 'bank'));
      const body = parse(CaptureBody, req.body);
      await sync(l, [body.counterAccountId]);
      res.json(l.capture(param(req, 'id'), { ...body, createdBy: actor(req) }));
    });

    r.post('/banks/:bank/holds/:id/release', (req, res) => {
      writeAccess(req);
      res.json(ledgerFor(param(req, 'bank')).releaseHold(param(req, 'id')));
    });

    r.get('/banks/:bank/holds/:id', (req, res) => {
      const bank = param(req, 'bank');
      readAccess(req, bank);
      res.json(ledgerFor(bank).getHold(param(req, 'id')));
    });

    r.get('/banks/:bank/holds', (req, res) => {
      const bank = param(req, 'bank');
      readAccess(req, bank);
      res.json({
        holds: ledgerFor(bank).listHolds({ accountId: queryString(req, 'accountId'), status: queryString(req, 'status'), reference: queryString(req, 'reference') }),
      });
    });

    r.post('/banks/:bank/entries/:id/reverse', (req, res) => {
      writeAccess(req);
      const l = ledgerFor(param(req, 'bank'));
      const body = parse(ReverseBody, req.body);
      const key = idempotencyKey(req)!;
      const entryId = param(req, 'id');
      const createdBy = actor(req);
      sendStored(res, idempotent(l.db, 'reversals', key, { entryId, ...body }, () => ({ status: 201, body: l.reverse(entryId, body.reason, createdBy) })));
    });

    r.get('/banks/:bank/entries/:id', (req, res) => {
      const bank = param(req, 'bank');
      readAccess(req, bank);
      res.json(ledgerFor(bank).entry(param(req, 'id')));
    });

    r.get('/banks/:bank/entries', (req, res) => {
      const bank = param(req, 'bank');
      readAccess(req, bank);
      const reference = queryString(req, 'reference');
      if (!reference) throw unprocessable('REFERENCE_REQUIRED', 'reference query parameter is required');
      res.json({ entries: ledgerFor(bank).entriesByReference(reference) });
    });

    r.get('/banks/:bank/accounts/:id/balance', async (req, res) => {
      const bank = param(req, 'bank');
      readAccess(req, bank);
      const l = ledgerFor(bank);
      await sync(l, [param(req, 'id')]);
      res.json(l.balance(param(req, 'id'), queryString(req, 'asOf')));
    });

    r.get('/banks/:bank/accounts/:id/statement', async (req, res) => {
      const bank = param(req, 'bank');
      readAccess(req, bank);
      const l = ledgerFor(bank);
      await sync(l, [param(req, 'id')]);
      res.json(l.statement(param(req, 'id'), { from: queryString(req, 'from'), to: queryString(req, 'to'), limit: queryInt(req, 'limit', 200, 500) }));
    });

    r.get('/admin/invariants', (req, res) => {
      requireServiceOrStaff(req, ['SWITCH_OPS']);
      const only = queryString(req, 'bank');
      const reports = [...ledgers.values()].filter((l) => !only || l.bankCode === only).map((l) => l.invariants());
      res.json({ ok: reports.every((x) => x.ok), banks: reports });
    });

    r.post('/internal/banks/:bank/accounts/:id/refresh', async (req, res) => {
      const l = ledgerFor(param(req, 'bank'));
      const a = await deps.accounts.getAccount(param(req, 'id'));
      l.upsertAccount(a);
      res.json({ accountId: a.id, status: l.account(a.id).status });
    });

    r.get('/internal/banks/:bank/accounts/:id/balance', async (req, res) => {
      const l = ledgerFor(param(req, 'bank'));
      await sync(l, [param(req, 'id')]);
      res.json(l.balance(param(req, 'id')));
    });
  });

  return { app, ledgers };
}
