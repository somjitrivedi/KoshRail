import { z } from 'zod';
import { TXN_STATES, type ResolveResult, type TxnState } from '@kosh/contracts';
import {
  badRequest,
  type Clock,
  createApp,
  type Db,
  getCaller,
  hasRole,
  idempotencyKey,
  type Logger,
  notFound,
  param,
  parse,
  queryInt,
  queryString,
  requireCustomer,
  requireStaff,
  sendStored,
  ServiceClient,
  unauthorized,
} from '@kosh/service-kit';
import type { BankPort } from './banks.ts';
import type { SwitchConfig } from './config.ts';
import { customerView, type IdentityPort, type MpinClaims, PayBody, PaymentIntake, type VpaPort } from './intake.ts';
import { OpsService, opsView } from './ops.ts';
import { Recovery } from './recovery.ts';
import { BankGuards, type Random } from './resilience.ts';
import { allowAllRisk, type CrashHook, type RiskPort, SagaEngine } from './saga.ts';
import { SwitchStore, type Txn } from './store.ts';

export function httpIdentityPort(identityUrl: string, token: string): IdentityPort {
  const c = new ServiceClient(identityUrl, { token, caller: 'switch-service', timeoutMs: 3000 });
  return { verifyMpinToken: (mpinToken) => c.post<MpinClaims>('/internal/mpin-tokens/verify', { token: mpinToken }) };
}

export function httpVpaPort(vpaUrl: string, token: string): VpaPort {
  const c = new ServiceClient(vpaUrl, { token, caller: 'switch-service', timeoutMs: 3000 });
  return { resolve: (address) => c.get<ResolveResult>(`/resolve/${encodeURIComponent(address)}`) };
}

export class ChaosControl {
  private point: string | null = null;
  private txnId: string | null = null;

  constructor(
    private readonly log: Logger,
    private readonly onCrash: (point: string) => void,
  ) {}

  arm(point: string | null, txnId: string | null): void {
    this.point = point;
    this.txnId = txnId;
  }

  state() {
    return { crashAt: this.point, txnId: this.txnId };
  }

  readonly hook: CrashHook = (point, txn) => {
    if (!this.point || this.point !== point) return;
    if (this.txnId && this.txnId !== txn.id) return;
    this.log.warn('chaos: crashing switch-service at step boundary', { point, txnId: txn.id });
    this.point = null;
    this.onCrash(point);
  };
}

export interface SwitchDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  internalToken: string;
  config: SwitchConfig;
  owner: string;
  banks: BankPort;
  identity: IdentityPort;
  vpa: VpaPort;
  risk?: RiskPort;
  sleep: (ms: number) => Promise<void>;
  random: Random;
  crash?: CrashHook;
  chaos?: ChaosControl;
  autoDrive?: boolean;
}

const OpsReason = z.object({ reason: z.string().trim().min(5).max(300) });
const ChaosBody = z.object({ crashAt: z.string().min(3).max(64).nullable(), txnId: z.string().min(3).max(64).nullable().default(null) });

function canSeeAsCustomer(t: Txn, userId: string): boolean {
  return t.payerUserId === userId || t.payeeUserId === userId;
}

export function buildSwitch(deps: SwitchDeps) {
  const store = new SwitchStore(deps.db, deps.clock);
  const guards = new BankGuards(deps.clock, {
    failureThreshold: deps.config.breakerFailureThreshold,
    cooldownMs: deps.config.breakerCooldownMs,
    bulkheadLimit: deps.config.bulkheadLimit,
  });
  const crash: CrashHook | undefined = deps.crash ?? deps.chaos?.hook;
  const engine = new SagaEngine({
    store,
    banks: deps.banks,
    risk: deps.risk ?? allowAllRisk,
    guards,
    clock: deps.clock,
    log: deps.log,
    config: deps.config,
    owner: deps.owner,
    sleep: deps.sleep,
    random: deps.random,
    crash,
  });
  const recovery = new Recovery(store, engine, { batch: deps.config.recoveryBatch, maxConcurrent: Math.max(4, deps.config.bulkheadLimit) }, deps.log);
  const intake = new PaymentIntake(store, deps.identity, deps.vpa, deps.config);
  const ops = new OpsService({ store, engine, banks: deps.banks, guards, clock: deps.clock, config: deps.config });
  const autoDrive = deps.autoDrive ?? true;

  const kick = (id: string) => {
    if (!autoDrive) return;
    void engine.drive(id).catch((err: unknown) => deps.log.error('saga drive failed', { txnId: id, err: err as Error }));
  };

  const app = createApp({ name: 'switch-service', internalToken: deps.internalToken, log: deps.log }, (r) => {
    r.post('/pay', async (req, res) => {
      const p = requireCustomer(req);
      const key = idempotencyKey(req)!;
      const body = parse(PayBody, req.body);
      const stored = await intake.pay(p, key, body);
      sendStored(res, stored);
      if (!stored.replayed && stored.status === 202) kick(stored.body.id);
    });

    r.get('/txn/:id', (req, res) => {
      const id = param(req, 'id');
      const c = getCaller(req);
      if (c.kind === 'anonymous') throw unauthorized('AUTH_REQUIRED', 'authentication required');
      const t = store.get(id);
      if (c.kind === 'user' && c.principal.kind === 'customer') {
        if (!t || !canSeeAsCustomer(t, c.principal.sub)) throw notFound('TXN_NOT_FOUND', 'transaction not found');
        res.json(customerView(t));
        return;
      }
      if (c.kind === 'user') requireStaff(req, ['SWITCH_OPS']);
      if (!t) throw notFound('TXN_NOT_FOUND', 'transaction not found');
      res.json(opsView(t));
    });

    r.get('/txns', (req, res) => {
      const p = requireCustomer(req);
      res.json({ txns: store.listForUser(p.sub, queryInt(req, 'limit', 20, 100)).map(customerView) });
    });

    r.get('/ops/txns', (req, res) => {
      requireStaff(req, ['SWITCH_OPS']);
      const raw = queryString(req, 'state');
      if (raw && !(TXN_STATES as readonly string[]).includes(raw)) throw badRequest('VALIDATION_FAILED', `unknown state ${raw}`);
      res.json({ txns: store.listByState((raw as TxnState | undefined) ?? null, queryInt(req, 'limit', 50, 500)).map(opsView) });
    });

    r.get('/ops/txns/:id', async (req, res) => {
      requireStaff(req, ['SWITCH_OPS']);
      res.json(await ops.detail(param(req, 'id'), queryString(req, 'inquire') === 'true'));
    });

    r.post('/ops/txns/:id/retry', (req, res) => {
      const p = requireStaff(req, ['SWITCH_OPS']);
      res.json(opsView(ops.retry(param(req, 'id'), p.sub, parse(OpsReason, req.body).reason)));
    });

    r.post('/ops/txns/:id/reverse', async (req, res) => {
      const p = requireStaff(req, ['SWITCH_OPS']);
      res.json(opsView(await ops.reverse(param(req, 'id'), p.sub, parse(OpsReason, req.body).reason)));
    });

    r.get('/ops/metrics', (req, res) => {
      requireStaff(req, ['SWITCH_OPS']);
      res.json(ops.metrics(queryInt(req, 'windowMinutes', 15, 1440)));
    });

    r.get('/ops/breakers', (req, res) => {
      const c = getCaller(req);
      if (c.kind !== 'service') requireStaff(req, ['SWITCH_OPS']);
      res.json({ banks: guards.snapshot() });
    });

    r.get('/internal/txns/:id', (req, res) => {
      const c = getCaller(req);
      if (c.kind === 'user' && !hasRole(c.principal, ['SWITCH_OPS'])) throw notFound('ROUTE_NOT_FOUND', 'not found');
      const id = param(req, 'id');
      const t = store.get(id);
      if (!t) throw notFound('TXN_NOT_FOUND', 'transaction not found');
      res.json({ txn: opsView(t), steps: store.steps(id), transitions: store.transitions(id) });
    });

    if (deps.chaos) {
      const chaos = deps.chaos;
      r.get('/internal/chaos', (_req, res) => {
        res.json(chaos.state());
      });
      r.put('/internal/chaos', (req, res) => {
        const body = parse(ChaosBody, req.body);
        chaos.arm(body.crashAt, body.txnId);
        res.json(chaos.state());
      });
    }
  });

  return { app, store, engine, recovery, guards, intake, ops };
}
