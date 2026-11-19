import type { Request, Response } from 'express';
import { HEADERS, type Principal } from '@kosh/contracts';
import { AppError, createApp, encodePrincipal, forbidden, type Logger, notFound, tooMany, ulid, unauthorized } from '@kosh/service-kit';
import type { JwksCache } from './jwks.ts';
import { RateLimiter, type BucketConfig } from './rate-limit.ts';

export interface RouteDef {
  prefix: string;
  upstream: string;
  publicEndpoints?: string[];
  kinds?: Principal['kind'][];
}

export interface GatewayDeps {
  routes: RouteDef[];
  jwks: Pick<JwksCache, 'verify' | 'loaded'>;
  internalToken: string;
  log: Logger;
  customerLimit: BucketConfig;
  anonLimit: BucketConfig;
  upstreamTimeoutMs?: number;
}

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', HEADERS.idempotencyKey];
const FORWARD_RESPONSE_HEADERS = [HEADERS.replayed, 'retry-after', 'content-type'];

function matchRoute(routes: RouteDef[], path: string): { route: RouteDef; rest: string } | null {
  for (const route of routes) {
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) {
      return { route, rest: path.slice(route.prefix.length) || '/' };
    }
  }
  return null;
}

function isPublic(route: RouteDef, method: string, rest: string): boolean {
  return (route.publicEndpoints ?? []).includes(`${method} ${rest}`);
}

function bearer(req: Request): string | null {
  const h = req.header('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

export function buildGateway(deps: GatewayDeps) {
  const customerLimiter = new RateLimiter(deps.customerLimit);
  const anonLimiter = new RateLimiter(deps.anonLimit);
  const timeoutMs = deps.upstreamTimeoutMs ?? 10000;

  const sweep = setInterval(() => {
    customerLimiter.sweep();
    anonLimiter.sweep();
  }, 60000);
  sweep.unref();

  function limit(res: Response, limiter: RateLimiter, key: string) {
    const r = limiter.take(key);
    if (!r.allowed) {
      res.setHeader('retry-after', String(r.retryAfterSeconds));
      throw tooMany('RATE_LIMITED', 'too many requests', { retryAfterSeconds: r.retryAfterSeconds });
    }
  }

  async function proxy(req: Request, res: Response) {
    const match = matchRoute(deps.routes, req.path);
    if (!match) throw notFound('ROUTE_NOT_FOUND', `no route for ${req.method} ${req.path}`);
    const { route, rest } = match;
    if (rest === '/internal' || rest.startsWith('/internal/') || rest.startsWith('/.well-known')) {
      throw notFound('ROUTE_NOT_FOUND', `no route for ${req.method} ${req.path}`);
    }

    let principal: Principal | null = null;
    const token = bearer(req);
    if (token) principal = await deps.jwks.verify(token);
    const publicEndpoint = isPublic(route, req.method, rest);
    if (!principal && !publicEndpoint) throw unauthorized('AUTH_REQUIRED', 'authentication required');
    if (principal && route.kinds && !route.kinds.includes(principal.kind)) {
      throw forbidden(principal.kind === 'customer' ? 'STAFF_ONLY' : 'CUSTOMER_ONLY', `this API is not available to ${principal.kind} users`);
    }

    if (!principal) limit(res, anonLimiter, `ip:${req.ip ?? 'unknown'}`);
    else if (principal.kind === 'customer') limit(res, customerLimiter, `c:${principal.deviceId ?? principal.sub}`);

    const target = new URL(route.upstream);
    target.pathname = `${target.pathname.replace(/\/$/, '')}${rest}`;
    const qIndex = req.originalUrl.indexOf('?');
    if (qIndex >= 0) target.search = req.originalUrl.slice(qIndex);

    const headers: Record<string, string> = {
      [HEADERS.internalToken]: deps.internalToken,
      [HEADERS.caller]: 'gateway',
      [HEADERS.requestId]: String(res.getHeader(HEADERS.requestId) ?? ulid()),
    };
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.header(h);
      if (v) headers[h] = v;
    }
    if (principal) headers[HEADERS.principal] = encodePrincipal(principal);
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    if (hasBody) headers['content-type'] = 'application/json';

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new AppError(504, 'UPSTREAM_TIMEOUT', 'upstream service timed out');
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'upstream service is unavailable');
    }
    res.status(upstream.status);
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }

  return createApp(
    {
      name: 'api-gateway',
      internalToken: deps.internalToken,
      log: deps.log,
      publicPaths: ['/api'],
      ready: () => deps.jwks.loaded,
    },
    (app) => {
      app.set('trust proxy', 'loopback');
      app.all('/api/*path', proxy);
    },
  );
}
