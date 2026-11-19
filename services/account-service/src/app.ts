import { z } from 'zod';
import { BankCodeSchema, GL_CODES, type GlCode, type InternalUser } from '@kosh/contracts';
import {
  type Clock,
  createApp,
  type Db,
  type Logger,
  param,
  parse,
  queryString,
  requireCustomer,
  requireStaff,
  requireUser,
  ServiceClient,
  badRequest,
} from '@kosh/service-kit';
import { APPROVAL_KINDS, DIRECT_ACTIONS, type DirectAction } from './rules.ts';
import { AccountService, type LedgerPort, type UserDirectory } from './service.ts';

const Paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const CreateCustomer = z.object({
  bankCode: BankCodeSchema,
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'phone must be a 10 digit Indian mobile number'),
  kycTier: z.enum(['MIN', 'FULL']).default('MIN'),
});
const OpenAccount = z.object({ customerId: z.string().min(1), type: z.enum(['SAVINGS', 'CURRENT']).default('SAVINGS') });
const DirectBody = z.object({ reason: z.string().max(200).nullable().default(null) });
const CreateApproval = z.object({
  accountId: z.string().min(1),
  kind: z.enum(APPROVAL_KINDS),
  reason: z.string().trim().min(3).max(200),
  payload: z.object({ perTxnLimit: Paise.optional(), dailyDebitLimit: Paise.optional(), overdraftLimit: Paise.optional() }).strict().default({}),
});
const Decision = z.object({ note: z.string().max(200).nullable().default(null) });
const Reject = z.object({ note: z.string().trim().min(3).max(200) });

export interface AccountDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  internalToken: string;
  users: UserDirectory;
  ledger: LedgerPort | null;
}

export function httpUserDirectory(identityUrl: string, token: string): UserDirectory {
  const client = new ServiceClient(identityUrl, { token, caller: 'account-service' });
  return { getUser: (id) => client.get<InternalUser>(`/internal/users/${encodeURIComponent(id)}`) };
}

export function httpLedgerPort(ledgerUrl: string, token: string): LedgerPort {
  const client = new ServiceClient(ledgerUrl, { token, caller: 'account-service', timeoutMs: 2000 });
  return {
    getBalance: (bankCode, accountId) =>
      client.get<{ ledgerBalance: number; heldAmount: number }>(`/internal/banks/${bankCode}/accounts/${encodeURIComponent(accountId)}/balance`),
    refresh: async (bankCode, accountId) => {
      await client.post(`/internal/banks/${bankCode}/accounts/${encodeURIComponent(accountId)}/refresh`, {});
    },
  };
}

export function buildAccounts(deps: AccountDeps) {
  const svc = new AccountService(deps.db, deps.clock, deps.users, deps.ledger);
  svc.ensureBanks();

  const app = createApp({ name: 'account-service', internalToken: deps.internalToken, log: deps.log }, (r) => {
    r.get('/banks', (req, res) => {
      requireUser(req);
      res.json({ banks: svc.listBanks() });
    });

    r.get('/banks/:code', (req, res) => {
      requireUser(req);
      res.json(svc.getBank(param(req, 'code')));
    });

    r.post('/customers', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      res.status(201).json(svc.createCustomer(actor, parse(CreateCustomer, req.body)));
    });

    r.get('/customers', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      const bankCode = queryString(req, 'bankCode') ?? actor.bankCode;
      if (!bankCode) throw badRequest('BANK_CODE_REQUIRED', 'bankCode query parameter is required');
      res.json({ customers: svc.findCustomers(actor, bankCode, queryString(req, 'phone')) });
    });

    r.get('/customers/:id', (req, res) => {
      res.json(svc.getCustomer(requireStaff(req, ['BANK_OPS']), param(req, 'id')));
    });

    r.post('/accounts', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      res.status(201).json(svc.openAccount(actor, parse(OpenAccount, req.body)));
    });

    r.get('/accounts', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      const bankCode = queryString(req, 'bankCode') ?? actor.bankCode;
      if (!bankCode) throw badRequest('BANK_CODE_REQUIRED', 'bankCode query parameter is required');
      res.json({
        accounts: svc.listAccounts(actor, {
          bankCode,
          customerId: queryString(req, 'customerId'),
          status: queryString(req, 'status'),
          type: queryString(req, 'type'),
        }),
      });
    });

    r.get('/accounts/:id', (req, res) => {
      res.json(svc.getAccount(requireUser(req), param(req, 'id')));
    });

    r.post('/accounts/:id/:action', async (req, res) => {
      const action = param(req, 'action');
      if (!(action in DIRECT_ACTIONS)) throw badRequest('UNKNOWN_ACTION', `unknown account action ${action}`);
      const actor = requireStaff(req, ['BANK_OPS']);
      res.json(await svc.directAndSync(actor, param(req, 'id'), action as DirectAction, parse(DirectBody, req.body ?? {}).reason));
    });

    r.post('/approvals', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      res.status(201).json(svc.createApproval(actor, parse(CreateApproval, req.body)));
    });

    r.get('/approvals', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      const bankCode = queryString(req, 'bankCode') ?? actor.bankCode;
      if (!bankCode) throw badRequest('BANK_CODE_REQUIRED', 'bankCode query parameter is required');
      res.json({ approvals: svc.listApprovals(actor, bankCode, queryString(req, 'status')) });
    });

    r.post('/approvals/:id/approve', async (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      res.json(await svc.approve(actor, param(req, 'id'), parse(Decision, req.body ?? {}).note));
    });

    r.post('/approvals/:id/reject', (req, res) => {
      const actor = requireStaff(req, ['BANK_OPS']);
      res.json(svc.reject(actor, param(req, 'id'), parse(Reject, req.body).note));
    });

    r.post('/approvals/:id/cancel', (req, res) => {
      res.json(svc.cancel(requireStaff(req, ['BANK_OPS']), param(req, 'id')));
    });

    r.get('/discover', async (req, res) => {
      const actor = requireCustomer(req);
      const bankCode = queryString(req, 'bankCode');
      if (!bankCode) throw badRequest('BANK_CODE_REQUIRED', 'bankCode query parameter is required');
      res.json(await svc.discover(actor, bankCode));
    });

    r.get('/me/accounts', (req, res) => {
      res.json({ accounts: svc.myAccounts(requireCustomer(req).sub) });
    });

    r.get('/internal/banks', (_req, res) => {
      res.json({ banks: svc.listBanks() });
    });

    r.get('/internal/banks/by-handle/:handle', (req, res) => {
      res.json(svc.bankByHandle(param(req, 'handle')));
    });

    r.get('/internal/banks/:code/gl/:glCode', (req, res) => {
      const gl = param(req, 'glCode');
      if (!(GL_CODES as readonly string[]).includes(gl)) throw badRequest('GL_UNKNOWN', `unknown GL code ${gl}`);
      res.json(svc.glAccount(param(req, 'code'), gl as GlCode));
    });

    r.get('/internal/accounts/:id', (req, res) => {
      res.json(svc.internalAccount(param(req, 'id')));
    });
  });

  return { app, svc };
}
