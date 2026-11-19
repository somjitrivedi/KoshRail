import { z } from 'zod';
import type { Bank, InternalAccount } from '@kosh/contracts';
import { badRequest, type Clock, createApp, type Db, getCaller, type Logger, param, parse, queryString, requireCustomer, ServiceClient, unauthorized } from '@kosh/service-kit';
import { VpaService, type AccountLookup } from './service.ts';

const CreateVpa = z.object({ handle: z.string().trim().toLowerCase(), pspHandle: z.string().trim().toLowerCase() });
const LinkBody = z.object({ accountId: z.string().min(1) });

export function httpAccountLookup(accountUrl: string, token: string): AccountLookup {
  const c = new ServiceClient(accountUrl, { token, caller: 'vpa-service' });
  return {
    getAccount: (id) => c.get<InternalAccount>(`/internal/accounts/${encodeURIComponent(id)}`),
    listBanks: async () => (await c.get<{ banks: Bank[] }>('/internal/banks')).banks,
  };
}

export interface VpaDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  internalToken: string;
  accounts: AccountLookup;
  cacheTtlMs?: number;
}

export function buildVpa(deps: VpaDeps) {
  const svc = new VpaService(deps.db, deps.clock, deps.accounts, deps.cacheTtlMs);

  const app = createApp({ name: 'vpa-service', internalToken: deps.internalToken, log: deps.log }, (r) => {
    r.get('/availability', async (req, res) => {
      requireCustomer(req);
      const handle = queryString(req, 'handle');
      const psp = queryString(req, 'psp');
      if (!handle || !psp) throw badRequest('VALIDATION_FAILED', 'handle and psp are required');
      res.json(await svc.availability(handle.toLowerCase(), psp.toLowerCase()));
    });

    r.post('/vpas', async (req, res) => {
      const p = requireCustomer(req);
      const body = parse(CreateVpa, req.body);
      res.status(201).json(await svc.create(p.sub, body.handle, body.pspHandle));
    });

    r.get('/vpas', (req, res) => {
      res.json({ vpas: svc.mine(requireCustomer(req).sub) });
    });

    r.post('/vpas/:address/links', async (req, res) => {
      const p = requireCustomer(req);
      res.status(201).json(await svc.link(p.sub, param(req, 'address'), parse(LinkBody, req.body).accountId));
    });

    r.delete('/vpas/:address/links/:accountId', (req, res) => {
      res.json(svc.unlink(requireCustomer(req).sub, param(req, 'address'), param(req, 'accountId')));
    });

    r.post('/vpas/:address/default', (req, res) => {
      res.json(svc.setDefault(requireCustomer(req).sub, param(req, 'address'), parse(LinkBody, req.body).accountId));
    });

    r.post('/vpas/:address/disable', (req, res) => {
      res.json(svc.disable(requireCustomer(req).sub, param(req, 'address')));
    });

    r.get('/resolve/:address', (req, res) => {
      const c = getCaller(req);
      if (c.kind === 'anonymous') throw unauthorized('AUTH_REQUIRED', 'authentication required');
      res.json(svc.resolve(param(req, 'address'), c.kind === 'service'));
    });

    r.get('/internal/cache-stats', (_req, res) => {
      res.json(svc.cache.stats());
    });
  });

  return { app, svc };
}
