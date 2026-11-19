import { randomInt } from 'node:crypto';
import type { Request, Response } from 'express';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { ADAPTER_STEPS, FAULT_MODES, HEADERS, type AdapterStep, type InternalAccount } from '@kosh/contracts';
import {
  AppError,
  type Clock,
  createApp,
  type Db,
  type Logger,
  notFound,
  param,
  parse,
  requireServiceOrStaff,
  ServiceClient,
  sleep,
  toAppError,
  unavailable,
} from '@kosh/service-kit';
import { AdapterStore } from './store.ts';

const TxnId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
const Amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const HoldReq = z.object({ txnId: TxnId, accountId: z.string().min(1), amount: Amount, ttlSeconds: z.number().int().min(1).max(86400).default(300) });
const CreditReq = z.object({ txnId: TxnId, accountId: z.string().min(1), amount: Amount, description: z.string().max(200).optional() });
const HoldRef = z.object({ txnId: TxnId, holdId: z.string().min(1) });
const ReverseReq = z.object({ txnId: TxnId, entryId: z.string().min(1), reason: z.string().trim().min(3).max(200) });
const FaultReq = z.object({
  mode: z.enum(FAULT_MODES),
  latencyMs: z.number().int().min(0).max(60000).default(0),
  errorRate: z.number().int().min(0).max(100).default(100),
  remaining: z.number().int().min(1).nullable().default(null),
});

export interface LedgerApi {
  placeHold(bank: string, body: { accountId: string; amount: number; reference: string; ttlSeconds: number }, key: string): Promise<{ id: string; expiresAt: string }>;
  postEntry(bank: string, body: { kind: string; reference: string; description?: string; postings: { accountId: string; amount: number }[] }, key: string): Promise<{ id: string }>;
  capture(bank: string, holdId: string, counterAccountId: string): Promise<{ entry: { id: string }; hold: { accountId: string; amount: number; reference: string } }>;
  release(bank: string, holdId: string): Promise<{ id: string; status: string; accountId: string; amount: number }>;
  getHold(bank: string, holdId: string): Promise<{ id: string; status: string; reference: string; accountId: string; amount: number }>;
  reverse(bank: string, entryId: string, reason: string, key: string): Promise<{ id: string }>;
  byReference(bank: string, reference: string): Promise<{ entries: unknown[]; holds: unknown[] }>;
}

export interface GlDirectory {
  switchSettlement(bank: string): Promise<string>;
}

export function httpLedgerApi(ledgerUrl: string, token: string): LedgerApi {
  const c = new ServiceClient(ledgerUrl, { token, caller: 'bank-adapter', timeoutMs: 5000 });
  return {
    placeHold: (bank, body, key) => c.post(`/banks/${bank}/holds`, body, { idempotencyKey: key }),
    postEntry: (bank, body, key) => c.post(`/banks/${bank}/entries`, body, { idempotencyKey: key }),
    capture: (bank, holdId, counterAccountId) => c.post(`/banks/${bank}/holds/${encodeURIComponent(holdId)}/capture`, { counterAccountId }),
    release: (bank, holdId) => c.post(`/banks/${bank}/holds/${encodeURIComponent(holdId)}/release`, {}),
    getHold: (bank, holdId) => c.get(`/banks/${bank}/holds/${encodeURIComponent(holdId)}`),
    reverse: (bank, entryId, reason, key) => c.post(`/banks/${bank}/entries/${encodeURIComponent(entryId)}/reverse`, { reason }, { idempotencyKey: key }),
    byReference: async (bank, reference) => {
      const [entries, holds] = await Promise.all([
        c.get<{ entries: unknown[] }>(`/banks/${bank}/entries`, { query: { reference } }),
        c.get<{ holds: unknown[] }>(`/banks/${bank}/holds`, { query: { reference } }),
      ]);
      return { entries: entries.entries, holds: holds.holds };
    },
  };
}

export function httpGlDirectory(accountUrl: string, token: string): GlDirectory {
  const c = new ServiceClient(accountUrl, { token, caller: 'bank-adapter' });
  const cache = new Map<string, string>();
  return {
    switchSettlement: async (bank) => {
      const hit = cache.get(bank);
      if (hit) return hit;
      const gl = await c.get<InternalAccount>(`/internal/banks/${bank}/gl/SWITCH_SETTLEMENT`);
      cache.set(bank, gl.id);
      return gl.id;
    },
  };
}

export interface AdapterDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  internalToken: string;
  banks: string[];
  ledger: LedgerApi;
  gl: GlDirectory;
  faultHangMs?: number;
}

export function buildAdapter(deps: AdapterDeps) {
  const store = new AdapterStore(deps.db, deps.clock);
  const hangMs = deps.faultHangMs ?? 30000;

  function bankOf(req: Request): string {
    const bank = param(req, 'bank');
    if (!deps.banks.includes(bank)) throw notFound('BANK_NOT_FOUND', `adapter does not serve bank ${bank}`);
    return bank;
  }

  async function runStep<T extends { txnId: string }>(
    req: Request,
    res: Response,
    step: AdapterStep,
    schema: ZodType<T, ZodTypeDef, unknown>,
    exec: (bank: string, body: T) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    requireServiceOrStaff(req, ['SWITCH_OPS']);
    const bank = bankOf(req);
    const body = parse(schema, req.body);
    const fault = store.fault(bank, step);
    if (fault?.mode === 'LATENCY') {
      store.consumeFault(bank, step);
      await sleep(fault.latencyMs);
    }
    if (fault?.mode === 'ERROR' && randomInt(100) < fault.errorRate) {
      store.consumeFault(bank, step);
      throw unavailable('ADAPTER_FAULT_INJECTED', `injected ${step} failure at ${bank}`);
    }
    const { replay } = store.begin(bank, body.txnId, step, body);
    if (replay) {
      res.setHeader(HEADERS.replayed, 'true');
      res.status(replay.httpStatus ?? 200).json(replay.response);
      return;
    }
    let response: Record<string, unknown>;
    try {
      response = { txnId: body.txnId, bankCode: bank, step, ...(await exec(bank, body)) };
    } catch (err) {
      const e = toAppError(err);
      if (e.status < 500) {
        store.finish(bank, body.txnId, step, 'FAILED', e.status, e.toBody());
        throw e;
      }
      throw new AppError(502, 'BANK_UNAVAILABLE', `${bank} core banking failed: ${e.message}`);
    }
    store.finish(bank, body.txnId, step, 'DONE', 200, response);
    if (fault?.mode === 'TIMEOUT_AFTER_COMMIT') {
      store.consumeFault(bank, step);
      deps.log.info('fault: holding response after commit', { bank, step, txnId: body.txnId, hangMs });
      await sleep(hangMs);
    }
    if (fault?.mode === 'DROP_RESPONSE') {
      store.consumeFault(bank, step);
      deps.log.info('fault: dropping response after commit', { bank, step, txnId: body.txnId });
      req.socket.destroy();
      return;
    }
    if (!res.writableEnded && !req.socket.destroyed) res.json(response);
  }

  const key = (txnId: string, step: AdapterStep) => `${txnId}.${step}`;

  const app = createApp({ name: 'bank-adapter', internalToken: deps.internalToken, log: deps.log }, (r) => {
    r.post('/banks/:bank/hold', (req, res) =>
      runStep(req, res, 'hold', HoldReq, async (bank, b) => {
        const h = await deps.ledger.placeHold(bank, { accountId: b.accountId, amount: b.amount, reference: b.txnId, ttlSeconds: b.ttlSeconds }, key(b.txnId, 'hold'));
        return { status: 'HELD', holdId: h.id, accountId: b.accountId, amount: b.amount, expiresAt: h.expiresAt };
      }),
    );

    r.post('/banks/:bank/credit', (req, res) =>
      runStep(req, res, 'credit', CreditReq, async (bank, b) => {
        const gl = await deps.gl.switchSettlement(bank);
        const e = await deps.ledger.postEntry(
          bank,
          {
            kind: 'CREDIT',
            reference: b.txnId,
            description: b.description ?? 'UPI credit',
            postings: [
              { accountId: gl, amount: -b.amount },
              { accountId: b.accountId, amount: b.amount },
            ],
          },
          key(b.txnId, 'credit'),
        );
        return { status: 'CREDITED', entryId: e.id, accountId: b.accountId, amount: b.amount };
      }),
    );

    r.post('/banks/:bank/capture', (req, res) =>
      runStep(req, res, 'capture', HoldRef, async (bank, b) => {
        const hold = await deps.ledger.getHold(bank, b.holdId);
        if (hold.reference !== b.txnId) throw new AppError(409, 'HOLD_TXN_MISMATCH', 'hold does not belong to this transaction');
        const gl = await deps.gl.switchSettlement(bank);
        const c = await deps.ledger.capture(bank, b.holdId, gl);
        return { status: 'CAPTURED', holdId: b.holdId, entryId: c.entry.id, accountId: c.hold.accountId, amount: c.hold.amount };
      }),
    );

    r.post('/banks/:bank/release', (req, res) =>
      runStep(req, res, 'release', HoldRef, async (bank, b) => {
        const hold = await deps.ledger.getHold(bank, b.holdId);
        if (hold.reference !== b.txnId) throw new AppError(409, 'HOLD_TXN_MISMATCH', 'hold does not belong to this transaction');
        const h = await deps.ledger.release(bank, b.holdId);
        return { status: 'RELEASED', holdId: h.id, holdStatus: h.status, accountId: h.accountId, amount: h.amount };
      }),
    );

    r.post('/banks/:bank/reverse', (req, res) =>
      runStep(req, res, 'reverse', ReverseReq, async (bank, b) => {
        const e = await deps.ledger.reverse(bank, b.entryId, b.reason, key(b.txnId, 'reverse'));
        return { status: 'REVERSED', entryId: e.id, reversedEntryId: b.entryId };
      }),
    );

    r.get('/banks/:bank/status/:txnId', async (req, res) => {
      requireServiceOrStaff(req, ['SWITCH_OPS']);
      const bank = bankOf(req);
      const txnId = param(req, 'txnId');
      const ledger = await deps.ledger.byReference(bank, txnId);
      res.json({ txnId, bankCode: bank, steps: store.steps(bank, txnId), ledger });
    });

    r.get('/banks/:bank/faults', (req, res) => {
      requireServiceOrStaff(req, ['SWITCH_OPS']);
      res.json({ faults: store.listFaults(bankOf(req)) });
    });

    r.put('/banks/:bank/faults/:op', (req, res) => {
      requireServiceOrStaff(req, ['SWITCH_OPS']);
      const bank = bankOf(req);
      const op = param(req, 'op');
      if (!(ADAPTER_STEPS as readonly string[]).includes(op)) throw notFound('OP_UNKNOWN', `unknown adapter operation ${op}`);
      const body = parse(FaultReq, req.body);
      store.setFault(bank, { op, ...body });
      res.json({ bankCode: bank, op, ...body });
    });

    r.delete('/banks/:bank/faults', (req, res) => {
      requireServiceOrStaff(req, ['SWITCH_OPS']);
      res.json({ cleared: store.clearFaults(bankOf(req)) });
    });
  });

  return { app, store };
}
