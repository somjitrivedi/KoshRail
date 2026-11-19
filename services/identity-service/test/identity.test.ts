import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import { encodePrincipal, migrationsDir, openDb, type Db } from '@kosh/service-kit';
import { customerPrincipal, FakeClock, newTestDevice, staffPrincipal, TEST_TOKEN, testLogger, type TestDevice } from '@kosh/test-kit';
import { buildIdentity } from '../src/app.ts';
import { isWeakMpin } from '../src/service.ts';

const MIGRATIONS = migrationsDir(new URL('../src/main.ts', import.meta.url).href);
const H = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'gateway' };
const DUMMY_PHONES = ['9999999999', '8888888888', '7777777777', '6666666666'];

let db: Db;
let clock: FakeClock;
let app: Express;
let phoneSeq = 0;

function nextPhone() {
  const phone = DUMMY_PHONES[phoneSeq % DUMMY_PHONES.length]!;
  phoneSeq++;
  return phone;
}

function as(principal: ReturnType<typeof customerPrincipal>) {
  return { ...H, 'x-kosh-principal': encodePrincipal(principal) };
}

async function otp(phone: string, purpose: 'REGISTER' | 'LOGIN') {
  const r = await request(app).post('/otp/request').set(H).send({ phone, purpose });
  expect(r.status).toBe(201);
  return r.body as { challengeId: string; devCode: string };
}

async function registerUser(device: TestDevice = newTestDevice(), phone = nextPhone()) {
  const o = await otp(phone, 'REGISTER');
  const r = await request(app)
    .post('/register')
    .set(H)
    .send({ challengeId: o.challengeId, code: o.devCode, name: 'Asha Verma', deviceId: device.deviceId, devicePublicKey: device.publicKey });
  expect(r.status).toBe(201);
  return { ...r.body, phone, device } as { user: { id: string }; accessToken: string; refreshToken: string; phone: string; device: TestDevice };
}

function outboxTypes(): string[] {
  return db.prepare('SELECT type FROM _outbox ORDER BY seq').pluck().all() as string[];
}

beforeEach(() => {
  db = openDb(':memory:', MIGRATIONS);
  clock = new FakeClock();
  phoneSeq = 0;
  app = buildIdentity({ db, clock, log: testLogger(), internalToken: TEST_TOKEN, adminPassword: 'Admin-Pass-123', config: { otpDevEcho: true } }).app;
});

describe('mpin strength', () => {
  it('flags repeated and sequential pins', () => {
    for (const weak of ['1111', '000000', '1234', '123456', '4321', '987654', '7890', '890123']) expect(isWeakMpin(weak), weak).toBe(true);
    for (const ok of ['1357', '204816', '9182', '1243']) expect(isWeakMpin(ok), ok).toBe(false);
  });
});

describe('internal access', () => {
  it('requires the internal token except for jwks', async () => {
    expect((await request(app).post('/otp/request').send({ phone: '9999999999', purpose: 'REGISTER' })).status).toBe(401);
    const jwks = await request(app).get('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
  });
});

describe('otp registration', () => {
  it('registers, binds the device and issues verifiable tokens', async () => {
    const u = await registerUser();
    const jwks = (await request(app).get('/.well-known/jwks.json')).body.keys[0];
    const claims = jwt.verify(u.accessToken, createPublicKey({ key: jwks, format: 'jwk' }), {
      issuer: 'kosh-identity',
      audience: 'kosh',
      clockTimestamp: Math.floor(clock.now().getTime() / 1000),
    }) as jwt.JwtPayload;
    expect(claims).toMatchObject({ sub: u.user.id, kind: 'customer', roles: [], deviceId: u.device.deviceId });
    expect(outboxTypes()).toEqual(['UserRegistered', 'DeviceBound']);
  });

  it('rejects invalid phones and duplicate registrations', async () => {
    expect((await request(app).post('/otp/request').set(H).send({ phone: '12345', purpose: 'REGISTER' })).body.error.code).toBe('PHONE_INVALID');
    const u = await registerUser();
    const dup = await request(app).post('/otp/request').set(H).send({ phone: u.phone, purpose: 'REGISTER' });
    expect(dup.status).toBe(409);
    const unknown = await request(app).post('/otp/request').set(H).send({ phone: nextPhone(), purpose: 'LOGIN' });
    expect(unknown.status).toBe(404);
  });

  it('locks a challenge after three wrong codes', async () => {
    const phone = nextPhone();
    const o = await otp(phone, 'REGISTER');
    const d = newTestDevice();
    const wrong = o.devCode === '000000' ? '111111' : '000000';
    const send = (code: string) =>
      request(app).post('/register').set(H).send({ challengeId: o.challengeId, code, name: 'X Y', deviceId: d.deviceId, devicePublicKey: d.publicKey });
    expect((await send(wrong)).body.error).toMatchObject({ code: 'OTP_INCORRECT', details: { attemptsRemaining: 2 } });
    await send(wrong);
    await send(wrong);
    const r = await send(o.devCode);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('expires codes and prevents reuse', async () => {
    const phone = nextPhone();
    const o = await otp(phone, 'REGISTER');
    clock.advanceSeconds(301);
    const d = newTestDevice();
    const r = await request(app).post('/register').set(H).send({ challengeId: o.challengeId, code: o.devCode, name: 'X Y', deviceId: d.deviceId, devicePublicKey: d.publicKey });
    expect(r.body.error.code).toBe('OTP_EXPIRED');
  });

  it('rate limits otp requests per phone', async () => {
    const phone = nextPhone();
    for (let i = 0; i < 5; i++) await otp(phone, 'REGISTER');
    const r = await request(app).post('/otp/request').set(H).send({ phone, purpose: 'REGISTER' });
    expect(r.status).toBe(429);
    clock.advanceSeconds(601);
    await otp(phone, 'REGISTER');
  });

  it('rejects non P-256 device keys', async () => {
    const o = await otp(nextPhone(), 'REGISTER');
    const r = await request(app)
      .post('/register')
      .set(H)
      .send({ challengeId: o.challengeId, code: o.devCode, name: 'X Y', deviceId: 'device-123', devicePublicKey: '-----BEGIN PUBLIC KEY-----\nnot-a-key-at-all-just-filler-text-to-pass-length\n-----END PUBLIC KEY-----' });
    expect(r.body.error.code).toBe('DEVICE_KEY_INVALID');
  });
});

describe('login and device binding', () => {
  it('requires a device signature on a bound device', async () => {
    const u = await registerUser();
    const o = await otp(u.phone, 'LOGIN');
    const noSig = await request(app).post('/login').set(H).send({ challengeId: o.challengeId, code: o.devCode, deviceId: u.device.deviceId });
    expect(noSig.body.error.code).toBe('DEVICE_SIGNATURE_INVALID');
    const o2 = await otp(u.phone, 'LOGIN');
    const ok = await request(app)
      .post('/login')
      .set(H)
      .send({ challengeId: o2.challengeId, code: o2.devCode, deviceId: u.device.deviceId, deviceSignature: u.device.sign(o2.challengeId) });
    expect(ok.status).toBe(200);
    expect(ok.body.newDevice).toBe(false);
  });

  it('rejects a signature made by another key', async () => {
    const u = await registerUser();
    const attacker = newTestDevice(u.device.deviceId);
    const o = await otp(u.phone, 'LOGIN');
    const r = await request(app)
      .post('/login')
      .set(H)
      .send({ challengeId: o.challengeId, code: o.devCode, deviceId: u.device.deviceId, deviceSignature: attacker.sign(o.challengeId) });
    expect(r.status).toBe(401);
  });

  it('binds a new device with a fresh key', async () => {
    const u = await registerUser();
    const second = newTestDevice();
    const o = await otp(u.phone, 'LOGIN');
    const r = await request(app).post('/login').set(H).send({ challengeId: o.challengeId, code: o.devCode, deviceId: second.deviceId, devicePublicKey: second.publicKey });
    expect(r.body.newDevice).toBe(true);
    const devices = await request(app).get('/devices').set(as(customerPrincipal(u.user.id, second.deviceId)));
    expect(devices.body.devices).toHaveLength(2);
  });

  it('revoking a device kills its sessions', async () => {
    const u = await registerUser();
    const second = newTestDevice();
    const o = await otp(u.phone, 'LOGIN');
    const s2 = await request(app).post('/login').set(H).send({ challengeId: o.challengeId, code: o.devCode, deviceId: second.deviceId, devicePublicKey: second.publicKey });
    const self = await request(app).delete(`/devices/${u.device.deviceId}`).set(as(customerPrincipal(u.user.id, u.device.deviceId)));
    expect(self.body.error.code).toBe('CANNOT_REVOKE_CURRENT_DEVICE');
    await request(app).delete(`/devices/${second.deviceId}`).set(as(customerPrincipal(u.user.id, u.device.deviceId))).expect(200);
    const refreshed = await request(app).post('/token/refresh').set(H).send({ refreshToken: s2.body.refreshToken });
    expect(refreshed.status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotates and detects reuse by revoking the whole family', async () => {
    const u = await registerUser();
    const r1 = await request(app).post('/token/refresh').set(H).send({ refreshToken: u.refreshToken });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/token/refresh').set(H).send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);
    const reuse = await request(app).post('/token/refresh').set(H).send({ refreshToken: u.refreshToken });
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
    const latest = await request(app).post('/token/refresh').set(H).send({ refreshToken: r2.body.refreshToken });
    expect(latest.body.error.code).toBe('REFRESH_REVOKED');
  });

  it('logout revokes and expiry is enforced', async () => {
    const u = await registerUser();
    expect((await request(app).post('/logout').set(H).send({ refreshToken: u.refreshToken })).body.revoked).toBe(1);
    expect((await request(app).post('/token/refresh').set(H).send({ refreshToken: u.refreshToken })).body.error.code).toBe('REFRESH_REVOKED');
    const v = await registerUser();
    clock.advanceSeconds(31 * 24 * 3600);
    expect((await request(app).post('/token/refresh').set(H).send({ refreshToken: v.refreshToken })).body.error.code).toBe('REFRESH_EXPIRED');
  });
});

describe('mpin', () => {
  it('sets, changes and validates format', async () => {
    const u = await registerUser();
    const h = as(customerPrincipal(u.user.id, u.device.deviceId));
    expect((await request(app).put('/mpin').set(h).send({ mpin: '1234' })).body.error.code).toBe('MPIN_WEAK');
    expect((await request(app).put('/mpin').set(h).send({ mpin: '12a4' })).body.error.code).toBe('MPIN_FORMAT');
    expect((await request(app).put('/mpin').set(h).send({ mpin: '1357' })).body).toEqual({ mpinSet: true, changed: false });
    expect((await request(app).put('/mpin').set(h).send({ mpin: '2468' })).body.error.code).toBe('CURRENT_MPIN_REQUIRED');
    expect((await request(app).put('/mpin').set(h).send({ mpin: '2468', currentMpin: '1357' })).body.changed).toBe(true);
    expect((await request(app).post('/mpin/verify').set(h).send({ mpin: '2468' })).status).toBe(200);
  });

  it('locks after three wrong attempts for 24 hours', async () => {
    const u = await registerUser();
    const h = as(customerPrincipal(u.user.id, u.device.deviceId));
    await request(app).put('/mpin').set(h).send({ mpin: '1357' }).expect(200);
    expect((await request(app).post('/mpin/verify').set(h).send({ mpin: '9999' })).body.error.code).toBe('MPIN_INCORRECT');
    expect((await request(app).post('/mpin/verify').set(h).send({ mpin: '9999' })).status).toBe(401);
    const third = await request(app).post('/mpin/verify').set(h).send({ mpin: '9999' });
    expect(third.status).toBe(423);
    const fourth = await request(app).post('/mpin/verify').set(h).send({ mpin: '1357' });
    expect(fourth.status).toBe(423);
    expect(outboxTypes()).toContain('MpinLocked');
    clock.advanceSeconds(23 * 3600);
    expect((await request(app).post('/mpin/verify').set(h).send({ mpin: '1357' })).status).toBe(423);
    clock.advanceSeconds(3601);
    expect((await request(app).post('/mpin/verify').set(h).send({ mpin: '1357' })).status).toBe(200);
  });

  it('resets the failure counter on success', async () => {
    const u = await registerUser();
    const h = as(customerPrincipal(u.user.id, u.device.deviceId));
    await request(app).put('/mpin').set(h).send({ mpin: '1357' });
    await request(app).post('/mpin/verify').set(h).send({ mpin: '0000' });
    await request(app).post('/mpin/verify').set(h).send({ mpin: '0000' });
    await request(app).post('/mpin/verify').set(h).send({ mpin: '1357' }).expect(200);
    await request(app).post('/mpin/verify').set(h).send({ mpin: '0000' });
    await request(app).post('/mpin/verify').set(h).send({ mpin: '0000' });
    expect((await request(app).post('/mpin/verify').set(h).send({ mpin: '1357' })).status).toBe(200);
  });

  it('issues short-lived mpin tokens verifiable by internal callers', async () => {
    const u = await registerUser();
    const h = as(customerPrincipal(u.user.id, u.device.deviceId));
    await request(app).put('/mpin').set(h).send({ mpin: '1357' });
    const v = await request(app).post('/mpin/verify').set(h).send({ mpin: '1357' });
    const svcHeaders = { 'x-kosh-internal-token': TEST_TOKEN, 'x-kosh-caller': 'switch-service' };
    const ok = await request(app).post('/internal/mpin-tokens/verify').set(svcHeaders).send({ token: v.body.mpinToken });
    expect(ok.body).toMatchObject({ userId: u.user.id, purpose: 'PAYMENT' });
    expect((await request(app).post('/internal/mpin-tokens/verify').set(svcHeaders).send({ token: u.accessToken })).status).toBe(401);
    clock.advanceSeconds(121);
    expect((await request(app).post('/internal/mpin-tokens/verify').set(svcHeaders).send({ token: v.body.mpinToken })).status).toBe(401);
  });
});

describe('staff', () => {
  it('bootstraps admin and lets only admins create staff', async () => {
    const login = await request(app).post('/staff/login').set(H).send({ username: 'admin', password: 'Admin-Pass-123' });
    expect(login.status).toBe(200);
    expect(login.body.staff.role).toBe('ADMIN');
    const bad = await request(app).post('/staff/login').set(H).send({ username: 'admin', password: 'wrong' });
    expect(bad.body.error.code).toBe('CREDENTIALS_INVALID');

    const admin = as(staffPrincipal('stf_admin', ['ADMIN']));
    const ops = as(staffPrincipal('stf_ops', ['BANK_OPS'], 'KOSH'));
    const body = { username: 'ops.kosh', name: 'Ops Kosh', password: 'Ops-Pass-1234', role: 'BANK_OPS', bankCode: 'KOSH' };
    expect((await request(app).post('/staff').set(ops).send(body)).status).toBe(403);
    expect((await request(app).post('/staff').set(admin).send({ ...body, bankCode: null })).body.error.code).toBe('BANK_CODE_REQUIRED');
    expect((await request(app).post('/staff').set(admin).send({ ...body, bankCode: 'NOPE' })).body.error.code).toBe('BANK_UNKNOWN');
    expect((await request(app).post('/staff').set(admin).send(body)).status).toBe(201);
    expect((await request(app).post('/staff').set(admin).send(body)).status).toBe(409);
    const opsLogin = await request(app).post('/staff/login').set(H).send({ username: 'ops.kosh', password: 'Ops-Pass-1234' });
    expect(opsLogin.body.staff).toMatchObject({ role: 'BANK_OPS', bankCode: 'KOSH' });
  });

  it('customers cannot call staff endpoints', async () => {
    const u = await registerUser();
    const r = await request(app).get('/staff').set(as(customerPrincipal(u.user.id)));
    expect(r.body.error.code).toBe('STAFF_ONLY');
  });
});
