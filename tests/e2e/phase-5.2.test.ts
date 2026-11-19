import { describe, expect, it } from 'vitest';
import { call, gw, idemKey, topicEvents } from './helpers.ts';
import { balance, clearFaults, customer, expectInvariants, ledgerByReference, mpinToken, pay, payAndWait, setFault, waitState } from './switch-helpers.ts';

describe('phase 5.2 - saga orchestrator', () => {
  it('two users at different banks: pay Rs 500, both balances correct, hold captured, events published', async () => {
    const asha = await customer('KOSH', 1_000_000);
    const ravi = await customer('ALPHA');
    const done = await payAndWait(asha, ravi, 50_000);
    expect(done.txn.state).toBe('COMPLETED');
    expect(done.transitions.map((t: { to: string }) => t.to)).toEqual(['RISK_PASSED', 'DEBIT_HELD', 'CREDITED', 'COMPLETED']);
    expect(await balance(asha)).toMatchObject({ ledgerBalance: 950_000, heldAmount: 0 });
    expect((await balance(ravi)).ledgerBalance).toBe(50_000);
    const payerSide = await ledgerByReference('KOSH', done.txn.id);
    expect(payerSide.holds).toHaveLength(1);
    expect(payerSide.holds[0]).toMatchObject({ status: 'CAPTURED', amount: 50_000 });
    const payeeSide = await ledgerByReference('ALPHA', done.txn.id);
    expect(payeeSide.entries.filter((e) => e.kind === 'CREDIT')).toHaveLength(1);
    const customerView = await call('GET', gw(`/api/switch/txn/${done.txn.id}`), { token: asha.session.accessToken });
    expect(customerView.body).toMatchObject({ status: 'SUCCESS', state: 'COMPLETED' });
    const events = (await topicEvents('switch.txn')).filter((e) => e.key === done.txn.id).map((e) => e.type);
    expect(events).toContain('TxnCompleted');
    await expectInvariants();
  });

  it('insufficient funds: DEBIT_FAILED and no hold left behind', async () => {
    const payer = await customer('BETA', 1_000);
    const payee = await customer('KOSH');
    const done = await payAndWait(payer, payee, 5_000);
    expect(done.txn).toMatchObject({ state: 'DEBIT_FAILED', failureCode: 'INSUFFICIENT_FUNDS', holdId: null });
    expect(await balance(payer)).toMatchObject({ ledgerBalance: 1_000, heldAmount: 0 });
    expect((await ledgerByReference('BETA', done.txn.id)).holds).toHaveLength(0);
    expect((await balance(payee)).ledgerBalance).toBe(0);
    const view = await call('GET', gw(`/api/switch/txn/${done.txn.id}`), { token: payer.session.accessToken });
    expect(view.body).toMatchObject({ status: 'FAILED', failureCode: 'INSUFFICIENT_FUNDS' });
    await expectInvariants();
  });

  it('double click with the same idempotency key: one transaction, money moved once', async () => {
    const payer = await customer('KOSH', 100_000);
    const payee = await customer('BETA');
    const key = idemKey();
    const token = await mpinToken(payer);
    const [a, b] = await Promise.all([pay(payer, payee, 7_000, { key, token }), pay(payer, payee, 7_000, { key, token })]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.id).toBe(b.body.id);
    await waitState(a.body.id, ['COMPLETED']);
    const again = await pay(payer, payee, 7_000, { key, token });
    expect(again.body.id).toBe(a.body.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await balance(payer)).ledgerBalance).toBe(93_000);
    expect((await balance(payee)).ledgerBalance).toBe(7_000);
    const list = await call('GET', gw('/api/switch/txns'), { token: payer.session.accessToken });
    expect(list.body.txns).toHaveLength(1);
    await expectInvariants();
  });

  it('pays between two customers of the same bank', async () => {
    const a = await customer('ALPHA', 20_000);
    const b = await customer('ALPHA');
    const done = await payAndWait(a, b, 2_000);
    expect(done.txn.state).toBe('COMPLETED');
    expect((await balance(a)).ledgerBalance).toBe(18_000);
    expect((await balance(b)).ledgerBalance).toBe(2_000);
    await expectInvariants();
  });

  it('payee bank keeps failing the credit: the hold is released and the payment ends REVERSED', async () => {
    const payer = await customer('KOSH', 30_000);
    const payee = await customer('BETA');
    await setFault('BETA', 'credit', { mode: 'ERROR' });
    try {
      const done = await payAndWait(payer, payee, 9_000);
      expect(done.txn).toMatchObject({ state: 'REVERSED', holdReleased: true, creditEntryId: null });
      expect(done.transitions.map((t: { to: string }) => t.to)).toEqual(['RISK_PASSED', 'DEBIT_HELD', 'CREDIT_FAILED', 'REVERSING', 'REVERSED']);
      expect(await balance(payer)).toMatchObject({ ledgerBalance: 30_000, heldAmount: 0 });
      expect((await ledgerByReference('KOSH', done.txn.id)).holds[0].status).toBe('RELEASED');
      expect((await balance(payee)).ledgerBalance).toBe(0);
    } finally {
      await clearFaults('BETA');
    }
    await expectInvariants();
  });
});
