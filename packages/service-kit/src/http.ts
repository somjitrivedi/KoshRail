import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { MoneyError } from '@kosh/money';
import { HEADERS } from '@kosh/contracts';
import { AppError, isAppError } from './errors.ts';
import { ulid } from './ids.ts';
import type { Logger } from './logger.ts';

export interface AppOptions {
  name: string;
  internalToken: string;
  log: Logger;
  publicPaths?: string[];
  ready?: () => boolean | Promise<boolean>;
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  return schema.parse(value);
}

export function createApp(opts: AppOptions, mount: (app: Express) => void): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    const id = req.header(HEADERS.requestId) ?? ulid();
    res.setHeader(HEADERS.requestId, id);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: opts.name });
  });

  app.get('/ready', async (_req, res) => {
    const ok = opts.ready ? await opts.ready() : true;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not-ready', service: opts.name });
  });

  const publicPaths = opts.publicPaths ?? [];
  app.use((req, _res, next) => {
    if (publicPaths.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    if (!tokenMatches(req.header(HEADERS.internalToken), opts.internalToken)) {
      return next(new AppError(401, 'INTERNAL_TOKEN_INVALID', 'missing or invalid internal service token'));
    }
    next();
  });

  mount(app);

  app.use((req, _res, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', `no route for ${req.method} ${req.path}`));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const appErr = toAppError(err);
    if (appErr.status >= 500) opts.log.error('request failed', { method: req.method, path: req.path, err: err as Error });
    else opts.log.debug('request rejected', { method: req.method, path: req.path, code: appErr.code });
    if (res.headersSent) return;
    res.status(appErr.status).json(appErr.toBody());
  });

  return app;
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof ZodError) {
    return new AppError(400, 'VALIDATION_FAILED', 'request validation failed', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (err instanceof MoneyError) return new AppError(400, err.code, err.message);
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.parse.failed') return new AppError(400, 'MALFORMED_JSON', 'request body is not valid JSON');
  if (e?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  return new AppError(500, 'INTERNAL_ERROR', 'unexpected server error');
}

export function sendStored(res: Response, stored: { status: number; body: unknown; replayed: boolean }): void {
  if (stored.replayed) res.setHeader(HEADERS.replayed, 'true');
  res.status(stored.status).json(stored.body);
}

export function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function queryInt(req: Request, name: string, fallback: number, max = 1000): number {
  const raw = queryString(req, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new AppError(400, 'VALIDATION_FAILED', `${name} must be a non-negative integer`);
  return Math.min(n, max);
}

export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || v === '') throw new AppError(400, 'VALIDATION_FAILED', `missing path parameter ${name}`);
  return v;
}
