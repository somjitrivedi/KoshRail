import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { inject } from 'vitest';

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface CallOptions {
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export function url(envName: string, path: string): string {
  return `${inject('urls')[envName]}${path}`;
}

export function gw(path: string): string {
  return url('KOSH_GATEWAY_URL', path);
}

export async function call<T = any>(method: string, target: string, opts: CallOptions = {}): Promise<CallResult<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(target, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

export function internalHeaders(caller = 'e2e'): Record<string, string> {
  return { 'x-kosh-internal-token': inject('internalToken'), 'x-kosh-caller': caller };
}

export async function internal<T = any>(method: string, envName: string, path: string, body?: unknown, idempotencyKey?: string) {
  return call<T>(method, url(envName, path), { body, headers: internalHeaders(), idempotencyKey });
}

let seq = 0;
export function uniqueSuffix(): string {
  seq++;
  return `${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function uniquePhone(): string {
  const n = (Date.now() % 1e8) * 10 + (seq++ % 10);
  return `6${String(n).padStart(9, '0').slice(-9)}`;
}

export function idemKey(): string {
  return `e2e-${uniqueSuffix()}`;
}

export interface Device {
  deviceId: string;
  publicKey: string;
  privateKey: KeyObject;
  signChallenge(challengeId: string): string;
}

export function newDevice(): Device {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    deviceId: `dev-${uniqueSuffix()}`,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
    signChallenge: (challengeId: string) => sign('sha256', Buffer.from(challengeId), privateKey).toString('base64'),
  };
}

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
  phone: string;
  device: Device;
  name: string;
}

export async function registerCustomer(name = `Test User ${uniqueSuffix()}`, phone = uniquePhone()): Promise<Session> {
  const device = newDevice();
  const otp = await call('POST', gw('/api/identity/otp/request'), { body: { phone, purpose: 'REGISTER' } });
  if (otp.status !== 201) throw new Error(`otp request failed ${otp.status} ${JSON.stringify(otp.body)}`);
  const reg = await call('POST', gw('/api/identity/register'), {
    body: { challengeId: otp.body.challengeId, code: otp.body.devCode, name, deviceId: device.deviceId, devicePublicKey: device.publicKey },
  });
  if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
  return { userId: reg.body.user.id, accessToken: reg.body.accessToken, refreshToken: reg.body.refreshToken, phone, device, name };
}

export async function adminToken(): Promise<string> {
  const r = await call('POST', gw('/api/identity/staff/login'), { body: { username: 'admin', password: inject('adminPassword') } });
  if (r.status !== 200) throw new Error(`admin login failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken as string;
}

export async function createStaff(admin: string, role: string, bankCode: string | null): Promise<{ id: string; token: string; username: string }> {
  const username = `staff.${uniqueSuffix()}`;
  const password = 'Staff-Pass-123';
  const created = await call('POST', gw('/api/identity/staff'), { token: admin, body: { username, name: `Staff ${username}`, password, role, bankCode } });
  if (created.status !== 201) throw new Error(`create staff failed ${created.status} ${JSON.stringify(created.body)}`);
  const login = await call('POST', gw('/api/identity/staff/login'), { body: { username, password } });
  if (login.status !== 200) throw new Error(`staff login failed ${login.status}`);
  return { id: created.body.id, token: login.body.accessToken, username };
}

export interface BankOps {
  bankCode: string;
  maker: { id: string; token: string };
  checker: { id: string; token: string };
}

const opsCache = new Map<string, Promise<BankOps>>();
export function bankOps(bankCode: string): Promise<BankOps> {
  let p = opsCache.get(bankCode);
  if (!p) {
    p = (async () => {
      const admin = await adminToken();
      const maker = await createStaff(admin, 'BANK_OPS', bankCode);
      const checker = await createStaff(admin, 'BANK_OPS', bankCode);
      return { bankCode, maker, checker };
    })();
    opsCache.set(bankCode, p);
  }
  return p;
}

export async function openAccount(
  ops: BankOps,
  holder: { name: string; phone: string },
  opts: { kycTier?: 'MIN' | 'FULL'; type?: 'SAVINGS' | 'CURRENT'; activate?: boolean } = {},
): Promise<{ customerId: string; accountId: string; accountNumber: string }> {
  const existing = await call('GET', gw(`/api/accounts/customers?bankCode=${ops.bankCode}&phone=${holder.phone}`), { token: ops.maker.token });
  let customerId: string = existing.body.customers?.[0]?.id;
  if (!customerId) {
    const c = await call('POST', gw('/api/accounts/customers'), {
      token: ops.maker.token,
      body: { bankCode: ops.bankCode, fullName: holder.name, phone: holder.phone, kycTier: opts.kycTier ?? 'FULL' },
    });
    if (c.status !== 201) throw new Error(`create customer failed ${c.status} ${JSON.stringify(c.body)}`);
    customerId = c.body.id;
  }
  const a = await call('POST', gw('/api/accounts/accounts'), { token: ops.maker.token, body: { customerId, type: opts.type ?? 'SAVINGS' } });
  if (a.status !== 201) throw new Error(`open account failed ${a.status} ${JSON.stringify(a.body)}`);
  if (opts.activate ?? true) {
    const act = await call('POST', gw(`/api/accounts/accounts/${a.body.id}/activate`), { token: ops.maker.token, body: {} });
    if (act.status !== 200) throw new Error(`activate failed ${act.status}`);
  }
  return { customerId, accountId: a.body.id, accountNumber: a.body.accountNumber };
}

export async function makerChecker(ops: BankOps, accountId: string, kind: string, payload: Record<string, number> = {}) {
  const req = await call('POST', gw('/api/accounts/approvals'), { token: ops.maker.token, body: { accountId, kind, reason: `e2e ${kind}`, payload } });
  if (req.status !== 201) throw new Error(`approval request failed ${req.status} ${JSON.stringify(req.body)}`);
  return call('POST', gw(`/api/accounts/approvals/${req.body.id}/approve`), { token: ops.checker.token, body: {} });
}

export async function poll<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function topicEvents(topic: string, after = 0): Promise<any[]> {
  const r = await internal('GET', 'KOSH_EVENT_BUS_URL', `/topics/${topic}/events?after=${after}&max=1000`);
  return r.body.events as any[];
}
