import { describe, expect, it } from 'vitest';
import { call, gw, idemKey, registerCustomer, topicEvents } from './helpers.ts';
import { customer, expectInvariants, mpinToken, pay, switchOps, waitState } from './switch-helpers.ts';

describe('phase 5.1 - payment intake', () => {
  it('accepts a payment through the gateway with 202, a 12-digit RRN, a readable status and a TxnInitiated event', async () => {
    const payer = await customer('KOSH', 100_000);
    const payee = await customer('ALPHA');
    const r = await pay(payer, payee, 1_500, { note: 'tea' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ amount: 1_500, payerVpa: payer.address, payeeVpa: payee.address, note: 'tea', status: 'PENDING' });
    expect(r.body.rrn).toMatch(/^\d{12}$/);
    const mine = await call('GET', gw(`/api/switch/txn/${r.body.id}`), { token: payer.session.accessToken });
    expect(mine.status).toBe(200);
    expect(mine.body.rrn).toBe(r.body.rrn);
    const theirs = await call('GET', gw(`/api/switch/txn/${r.body.id}`), { token: payee.session.accessToken });
    expect(theirs.status).toBe(200);
    const stranger = await registerCustomer();
    expect((await call('GET', gw(`/api/switch/txn/${r.body.id}`), { token: stranger.accessToken })).status).toBe(404);
    await waitState(r.body.id);
    const events = await topicEvents('switch.txn');
    expect(events.some((e) => e.type === 'TxnInitiated' && e.payload.txnId === r.body.id && e.payload.rrn === r.body.rrn)).toBe(true);
    await expectInvariants();
  });

  it('rejects requests that are not safe to accept', async () => {
    const payer = await customer('KOSH', 10_000);
    const payee = await customer('BETA');
    const other = await customer('ALPHA', 10_000);
    const token = await mpinToken(payer);
    const body = { payerVpa: payer.address, payeeVpa: payee.address, amount: 100, mpinToken: token };
    const noKey = await call('POST', gw('/api/switch/pay'), { token: payer.session.accessToken, body });
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const anon = await call('POST', gw('/api/switch/pay'), { idempotencyKey: idemKey(), body });
    expect(anon.status).toBe(401);
    const badToken = await pay(payer, payee, 100, { token: 'definitely-not-a-valid-token' });
    expect(badToken.status).toBe(401);
    expect(badToken.body.error.code).toBe('MPIN_TOKEN_INVALID');
    const someoneElsesToken = await pay(payer, payee, 100, { token: await mpinToken(other) });
    expect(someoneElsesToken.body.error.code).toBe('MPIN_TOKEN_NOT_YOURS');
    const notMyVpa = await call('POST', gw('/api/switch/pay'), {
      token: payer.session.accessToken,
      idempotencyKey: idemKey(),
      body: { ...body, payerVpa: other.address, mpinToken: await mpinToken(payer) },
    });
    expect(notMyVpa.status).toBe(403);
    expect(notMyVpa.body.error.code).toBe('PAYER_VPA_NOT_OWNED');
    const ghost = await pay(payer, 'nobody.here@alpha', 100);
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.code).toBe('PAYEE_VPA_NOT_FOUND');
    for (const amount of [0, 12.5, -100]) {
      const r = await call('POST', gw('/api/switch/pay'), { token: payer.session.accessToken, idempotencyKey: idemKey(), body: { ...body, amount } });
      expect(r.status).toBe(400);
    }
    const staff = await call('POST', gw('/api/switch/pay'), { token: await switchOps(), idempotencyKey: idemKey(), body });
    expect(staff.status).toBe(403);
  });

  it('an MPIN token pays once; a second payment with it is refused', async () => {
    const payer = await customer('ALPHA', 10_000);
    const payee = await customer('KOSH');
    const token = await mpinToken(payer);
    const first = await pay(payer, payee, 200, { token });
    expect(first.status).toBe(202);
    const second = await pay(payer, payee, 300, { token });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('MPIN_TOKEN_USED');
    await waitState(first.body.id);
  });

  it('keeps the switch internal endpoints off the public gateway', async () => {
    const s = await registerCustomer();
    expect((await call('GET', gw('/api/switch/internal/chaos'), { token: s.accessToken })).status).toBe(404);
    expect((await call('GET', gw('/api/switch/internal/txns/txn_x'), { token: s.accessToken })).status).toBe(404);
  });
});
