import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { decodePrincipal, migrationsDir, openDb } from '@kosh/service-kit';
import { FakeClock, newTestDevice, serve, TEST_TOKEN, testLogger } from '@kosh/test-kit';
import { buildIdentity } from '../../identity-service/src/app.ts';
import { buildGateway } from '../src/app.ts';
import { JwksCache } from '../src/jwks.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const log = testLogger();
const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];

let identity: Awaited<ReturnType<typeof serve>>;
let echo: Awaited<ReturnType<typeof serve>>;
let gateway: Awaited<ReturnType<typeof serve>>;
let pastIdentity: Awaited<ReturnType<typeof serve>>;

async function customerToken(baseUrl: string, phone: string) {
  const d = newTestDevice();
  const o = await fetch(`${baseUrl}/api/identity/otp/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, purpose: 'REGISTER' }),
  }).then((r) => r.json() as Promise<{ challengeId: string; devCode: string }>);
  const reg = await fetch(`${baseUrl}/api/identity/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: o.challengeId, code: o.devCode, name: 'Gate Way', deviceId: d.deviceId, devicePublicKey: d.publicKey }),
  }).then((r) => r.json() as Promise<{ accessToken: string; user: { id: string } }>);
  return reg;
}

async function staffToken() {
  const r = await fetch(`${gateway.url}/api/identity/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin-Pass-123' }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
}

beforeAll(async () => {
  const idDb = openDb(':memory:', migrationsDir(new URL('../../identity-service/src/main.ts', import.meta.url).href));
  identity = await serve(
    buildIdentity({ db: idDb, clock: new FakeClock(new Date()), log, internalToken: TEST_TOKEN, adminPassword: 'Admin-Pass-123', config: { otpDevEcho: true } }).app,
  );
  const pastDb = openDb(':memory:', migrationsDir(new URL('../../identity-service/src/main.ts', import.meta.url).href));
  pastIdentity = await serve(
    buildIdentity({ db: pastDb, clock: new FakeClock(new Date(Date.now() - 3600_000)), log, internalToken: TEST_TOKEN, config: { otpDevEcho: true } }).app,
  );

  const echoApp = express();
  echoApp.use(express.json());
  echoApp.all('/*path', (req, res) => {
    seen.push({ path: req.originalUrl, headers: req.headers, body: req.body });
    if (req.path === '/replay') res.setHeader('idempotent-replayed', 'true');
    res.status(req.path === '/teapot' ? 418 : 200).json({ ok: true, path: req.originalUrl });
  });
  echo = await serve(echoApp);

  const jwks = new JwksCache(`${identity.url}/.well-known/jwks.json`, log, 0);
  await jwks.refresh(true);
  gateway = await serve(
    buildGateway({
      routes: [
        { prefix: '/api/identity', upstream: identity.url, publicEndpoints: ['POST /otp/request', 'POST /register', 'POST /staff/login'] },
        { prefix: '/api/echo', upstream: echo.url, publicEndpoints: ['GET /open'] },
        { prefix: '/api/staffonly', upstream: echo.url, kinds: ['staff'] },
        { prefix: '/api/dead', upstream: 'http://127.0.0.1:1' },
      ],
      jwks,
      internalToken: TEST_TOKEN,
      log,
      customerLimit: { burst: 5, ratePerSecond: 1 },
      anonLimit: { burst: 1000, ratePerSecond: 1000 },
    }),
  );
});

afterAll(async () => {
  await Promise.all([gateway.close(), echo.close(), identity.close(), pastIdentity.close()]);
});

describe('gateway routing and auth', () => {
  it('passes public endpoints through without a token', async () => {
    const r = await fetch(`${gateway.url}/api/echo/open?x=1`);
    expect(r.status).toBe(200);
    const last = seen.at(-1)!;
    expect(last.path).toBe('/open?x=1');
    expect(last.headers['x-kosh-internal-token']).toBe(TEST_TOKEN);
    expect(last.headers['x-kosh-caller']).toBe('gateway');
    expect(last.headers['x-kosh-principal']).toBeUndefined();
  });

  it('requires a token for protected endpoints', async () => {
    const r = await fetch(`${gateway.url}/api/echo/private`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
    const bad = await fetch(`${gateway.url}/api/echo/private`, { headers: { authorization: 'Bearer abc.def.ghi' } });
    expect(bad.status).toBe(401);
  });

  it('forwards the verified principal and ignores spoofed headers', async () => {
    const { accessToken, user } = await customerToken(gateway.url, '9999999999');
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker', kind: 'staff', roles: ['ADMIN'], bankCode: null, deviceId: null, sid: 'x' })).toString('base64url');
    const r = await fetch(`${gateway.url}/api/echo/private`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'x-kosh-principal': forged, 'x-kosh-internal-token': 'forged', 'idempotency-key': 'idem-key-123' },
      body: JSON.stringify({ amount: 5 }),
    });
    expect(r.status).toBe(200);
    const last = seen.at(-1)!;
    const p = decodePrincipal(String(last.headers['x-kosh-principal']));
    expect(p).toMatchObject({ sub: user.id, kind: 'customer', roles: [] });
    expect(last.headers['x-kosh-internal-token']).toBe(TEST_TOKEN);
    expect(last.headers['idempotency-key']).toBe('idem-key-123');
    expect(last.body).toEqual({ amount: 5 });
  });

  it('enforces staff-only routes', async () => {
    const { accessToken } = await customerToken(gateway.url, '8888888888');
    const r = await fetch(`${gateway.url}/api/staffonly/x`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(r.status).toBe(403);
    const staff = await staffToken();
    expect((await fetch(`${gateway.url}/api/staffonly/x`, { headers: { authorization: `Bearer ${staff}` } })).status).toBe(200);
  });

  it('never exposes internal or jwks paths', async () => {
    const staff = await staffToken();
    const r = await fetch(`${gateway.url}/api/identity/internal/users/usr_1`, { headers: { authorization: `Bearer ${staff}` } });
    expect(r.status).toBe(404);
    expect((await fetch(`${gateway.url}/api/identity/.well-known/jwks.json`)).status).toBe(404);
  });

  it('propagates upstream status and selected headers', async () => {
    const staff = await staffToken();
    const tea = await fetch(`${gateway.url}/api/staffonly/teapot`, { headers: { authorization: `Bearer ${staff}` } });
    expect(tea.status).toBe(418);
    const rep = await fetch(`${gateway.url}/api/staffonly/replay`, { headers: { authorization: `Bearer ${staff}` } });
    expect(rep.headers.get('idempotent-replayed')).toBe('true');
  });

  it('returns 503 when the upstream is down', async () => {
    const staff = await staffToken();
    const r = await fetch(`${gateway.url}/api/dead/x`, { headers: { authorization: `Bearer ${staff}` } });
    expect(r.status).toBe(503);
  });

  it('rejects expired tokens with TOKEN_EXPIRED', async () => {
    const pastJwks = new JwksCache(`${pastIdentity.url}/.well-known/jwks.json`, log, 0);
    await pastJwks.refresh(true);
    const g = await serve(
      buildGateway({
        routes: [
          { prefix: '/api/identity', upstream: pastIdentity.url, publicEndpoints: ['POST /otp/request', 'POST /register'] },
          { prefix: '/api/echo', upstream: echo.url },
        ],
        jwks: pastJwks,
        internalToken: TEST_TOKEN,
        log,
        customerLimit: { burst: 100, ratePerSecond: 100 },
        anonLimit: { burst: 100, ratePerSecond: 100 },
      }),
    );
    const { accessToken } = await customerToken(g.url, '9999999999');
    const r = await fetch(`${g.url}/api/echo/x`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('TOKEN_EXPIRED');
    await g.close();
  });

  it('rate limits customers per device with retry-after', async () => {
    const { accessToken } = await customerToken(gateway.url, '7777777777');
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${gateway.url}/api/echo/x`, { headers: { authorization: `Bearer ${accessToken}` } });
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get('retry-after');
    }
    expect(statuses.filter((s) => s === 200).length).toBe(5);
    expect(statuses.filter((s) => s === 429).length).toBe(3);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    const other = await customerToken(gateway.url, '6666666666');
    expect((await fetch(`${gateway.url}/api/echo/x`, { headers: { authorization: `Bearer ${other.accessToken}` } })).status).toBe(200);
  });
});

describe('token bucket', () => {
  it('refills over time', () => {
    let t = 0;
    const rl = new RateLimiter({ burst: 2, ratePerSecond: 2 }, () => t);
    expect(rl.take('k').allowed).toBe(true);
    expect(rl.take('k').allowed).toBe(true);
    const denied = rl.take('k');
    expect(denied).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    t = 500;
    expect(rl.take('k').allowed).toBe(true);
    expect(rl.take('k').allowed).toBe(false);
    t = 10000;
    expect(rl.take('k').remaining).toBe(1);
  });
});
