import { describe, expect, it } from 'vitest';
import { adminToken, call, createStaff, gw, poll, registerCustomer, topicEvents } from './helpers.ts';

describe('phase 1 - identity and gateway', () => {
  it('registers a customer through the gateway and reads /me', async () => {
    const s = await registerCustomer('Meera Iyer');
    const me = await call('GET', gw('/api/identity/me'), { token: s.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ kind: 'customer', id: s.userId, name: 'Meera Iyer', mpinSet: false });
    expect(me.body.devices).toHaveLength(1);
  });

  it('logs in on the bound device with a signature and rotates refresh tokens', async () => {
    const s = await registerCustomer();
    const otp = await call('POST', gw('/api/identity/otp/request'), { body: { phone: s.phone, purpose: 'LOGIN' } });
    const login = await call('POST', gw('/api/identity/login'), {
      body: { challengeId: otp.body.challengeId, code: otp.body.devCode, deviceId: s.device.deviceId, deviceSignature: s.device.signChallenge(otp.body.challengeId) },
    });
    expect(login.status).toBe(200);
    const r1 = await call('POST', gw('/api/identity/token/refresh'), { body: { refreshToken: login.body.refreshToken } });
    expect(r1.status).toBe(200);
    const reuse = await call('POST', gw('/api/identity/token/refresh'), { body: { refreshToken: login.body.refreshToken } });
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
  });

  it('rejects missing and forged tokens', async () => {
    expect((await call('GET', gw('/api/identity/me'))).status).toBe(401);
    expect((await call('GET', gw('/api/identity/me'), { token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' })).status).toBe(401);
  });

  it('enforces roles: customers and bank ops cannot manage staff', async () => {
    const admin = await adminToken();
    const ops = await createStaff(admin, 'BANK_OPS', 'KOSH');
    const customer = await registerCustomer();
    const body = { username: 'should.not.exist', name: 'Nope Nope', password: 'Whatever-123', role: 'ADMIN', bankCode: null };
    const asCustomer = await call('POST', gw('/api/identity/staff'), { token: customer.accessToken, body });
    expect(asCustomer.status).toBe(403);
    const asOps = await call('POST', gw('/api/identity/staff'), { token: ops.token, body });
    expect(asOps.status).toBe(403);
    expect(asOps.body.error.code).toBe('ROLE_REQUIRED');
    const list = await call('GET', gw('/api/identity/staff'), { token: admin });
    expect(list.status).toBe(200);
    expect(list.body.staff.some((s: { username: string }) => s.username === ops.username)).toBe(true);
  });

  it('locks the MPIN after three wrong attempts and stays locked on the fourth', async () => {
    const s = await registerCustomer();
    await call('PUT', gw('/api/identity/mpin'), { token: s.accessToken, body: { mpin: '2580' } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await call('POST', gw('/api/identity/mpin/verify'), { token: s.accessToken, body: { mpin: '1111' } })).status);
    expect(codes).toEqual([401, 401, 423]);
    const fourth = await call('POST', gw('/api/identity/mpin/verify'), { token: s.accessToken, body: { mpin: '2580' } });
    expect(fourth.status).toBe(423);
    expect(fourth.body.error.code).toBe('MPIN_LOCKED');
    const me = await call('GET', gw('/api/identity/me'), { token: s.accessToken });
    expect(me.body.mpinLockedUntil).toBeTruthy();
    const locked = await poll(async () => (await topicEvents('identity.events')).find((e) => e.type === 'MpinLocked' && e.key === s.userId), 'MpinLocked event');
    expect(locked.payload.userId).toBe(s.userId);
  });

  it('publishes registration events to the bus', async () => {
    const s = await registerCustomer();
    const events = await poll(async () => {
      const all = (await topicEvents('identity.events')).filter((e) => e.key === s.userId);
      return all.length >= 2 ? all : null;
    }, 'identity events');
    expect(events.map((e) => e.type)).toEqual(['UserRegistered', 'DeviceBound']);
    expect(events[0].source).toBe('identity-service');
  });

  it('rate limits a single customer device with 429', async () => {
    const s = await registerCustomer();
    const results = await Promise.all(Array.from({ length: 90 }, () => call('GET', gw('/api/identity/me'), { token: s.accessToken })));
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.headers.get('retry-after')).toBeTruthy();
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(40);
  });
});
