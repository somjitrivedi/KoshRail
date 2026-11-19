import { describe, expect, it } from 'vitest';
import { AppError } from '@kosh/service-kit';
import { FakeClock } from '@kosh/test-kit';
import { account, setupLedger } from './fixtures.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.code;
    return (err as { code?: string }).code ?? (err as Error).message;
  }
  return 'NO_ERROR';
}

const by = 'test';

describe('entry validation', () => {
  it('rejects malformed entries', () => {
    const { ledger } = setupLedger();
    const post = (postings: { accountId: string; amount: number }[], kind: 'TRANSFER' | 'REVERSAL' = 'TRANSFER') =>
      code(() => ledger.post({ kind, reference: 'ref-1', postings, createdBy: by }));
    expect(post([{ accountId: 'acc_a', amount: 100 }, { accountId: 'acc_b', amount: -99 }])).toBe('ENTRY_UNBALANCED');
    expect(post([{ accountId: 'acc_a', amount: 100 }])).toBe('ENTRY_TOO_FEW_POSTINGS');
    expect(post([{ accountId: 'acc_a', amount: 0 }, { accountId: 'acc_b', amount: 0 }])).toBe('INVALID_AMOUNT');
    expect(post([{ accountId: 'acc_a', amount: 1.5 }, { accountId: 'acc_b', amount: -1.5 }])).toBe('INVALID_AMOUNT');
    expect(post([{ accountId: 'acc_a', amount: 100 }, { accountId: 'acc_a', amount: -100 }])).toBe('ENTRY_DUPLICATE_ACCOUNT');
    expect(post([{ accountId: 'acc_a', amount: 100 }, { accountId: 'acc_x', amount: -100 }])).toBe('ACCOUNT_UNKNOWN');
    expect(post([{ accountId: 'acc_a', amount: 100 }, { accountId: 'acc_b', amount: -100 }], 'REVERSAL')).toBe('ENTRY_KIND_RESERVED');
  });

  it('refuses accounts that belong to another bank', () => {
    const { ledger } = setupLedger();
    expect(code(() => ledger.upsertAccount(account('acc_alpha', { bankCode: 'ALPHA' })))).toBe('ACCOUNT_WRONG_BANK');
  });
});

describe('postings and funds', () => {
  it('deposits and transfers with balances derived from postings', () => {
    const { ledger } = setupLedger();
    ledger.deposit('acc_a', 10_000, 'dep-1', by);
    const t = ledger.post({ kind: 'TRANSFER', reference: 'tx-1', postings: [{ accountId: 'acc_a', amount: -2_500 }, { accountId: 'acc_b', amount: 2_500 }], createdBy: by });
    expect(t.status).toBe('POSTED');
    expect(ledger.balance('acc_a').ledgerBalance).toBe(7_500);
    expect(ledger.balance('acc_b').ledgerBalance).toBe(2_500);
    expect(ledger.balance('gl_cash').ledgerBalance).toBe(-10_000);
    expect(ledger.invariants().ok).toBe(true);
  });

  it('blocks overdrawing and allows overdraft up to the limit', () => {
    const { ledger } = setupLedger();
    ledger.deposit('acc_a', 1_000, 'dep-1', by);
    expect(code(() => ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: 'acc_a', amount: -1_001 }, { accountId: 'acc_b', amount: 1_001 }], createdBy: by }))).toBe(
      'INSUFFICIENT_FUNDS',
    );
    ledger.upsertAccount(account('acc_od', { type: 'CURRENT', overdraftLimit: 5_000 }));
    ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: 'acc_od', amount: -5_000 }, { accountId: 'acc_b', amount: 5_000 }], createdBy: by });
    expect(ledger.balance('acc_od').availableBalance).toBe(-5_000);
    expect(code(() => ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: 'acc_od', amount: -1 }, { accountId: 'acc_b', amount: 1 }], createdBy: by }))).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect(ledger.invariants().ok).toBe(true);
  });

  it('applies account status rules', () => {
    const { ledger } = setupLedger();
    ledger.upsertAccount(account('acc_frozen', { status: 'ACTIVE' }));
    ledger.deposit('acc_frozen', 5_000, 'dep', by);
    ledger.upsertAccount(account('acc_frozen', { status: 'FROZEN' }));
    ledger.upsertAccount(account('acc_pending', { status: 'PENDING' }));
    ledger.upsertAccount(account('acc_dormant', { status: 'DORMANT' }));
    ledger.deposit('acc_a', 10_000, 'dep', by);
    const xfer = (from: string, to: string) =>
      code(() => ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: from, amount: -100 }, { accountId: to, amount: 100 }], createdBy: by }));
    expect(xfer('acc_frozen', 'acc_a')).toBe('ACCOUNT_NOT_ACTIVE');
    expect(xfer('acc_a', 'acc_frozen')).toBe('NO_ERROR');
    expect(xfer('acc_a', 'acc_pending')).toBe('ACCOUNT_NOT_OPEN');
    expect(xfer('acc_a', 'acc_dormant')).toBe('NO_ERROR');
    expect(xfer('acc_dormant', 'acc_a')).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('enforces per transaction and daily limits per business day', () => {
    const clock = new FakeClock('2026-11-16T10:00:00.000Z');
    const { ledger } = setupLedger(clock);
    ledger.upsertAccount(account('acc_lim', { perTxnLimit: 1_000, dailyDebitLimit: 2_500 }));
    ledger.deposit('acc_lim', 100_000, 'dep', by);
    const send = (amount: number) =>
      code(() => ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: 'acc_lim', amount: -amount }, { accountId: 'acc_b', amount }], createdBy: by }));
    expect(send(1_001)).toBe('LIMIT_PER_TXN_EXCEEDED');
    expect(send(1_000)).toBe('NO_ERROR');
    expect(send(1_000)).toBe('NO_ERROR');
    expect(code(() => ledger.placeHold({ accountId: 'acc_lim', amount: 600, reference: 'h', ttlSeconds: 60 }))).toBe('LIMIT_DAILY_EXCEEDED');
    ledger.placeHold({ accountId: 'acc_lim', amount: 500, reference: 'h', ttlSeconds: 60 });
    expect(send(1)).toBe('LIMIT_DAILY_EXCEEDED');
    expect(code(() => ledger.withdraw('acc_lim', 50_000, 'cash', by))).toBe('NO_ERROR');
    clock.set('2026-11-16T18:31:00.000Z');
    expect(send(1_000)).toBe('NO_ERROR');
  });
});

describe('holds', () => {
  it('place, capture and release move held and ledger amounts correctly', () => {
    const { ledger } = setupLedger();
    ledger.deposit('acc_a', 10_000, 'dep', by);
    const h = ledger.placeHold({ accountId: 'acc_a', amount: 4_000, reference: 'txn-1', ttlSeconds: 300 });
    expect(ledger.balance('acc_a')).toMatchObject({ ledgerBalance: 10_000, heldAmount: 4_000, availableBalance: 6_000 });
    expect(code(() => ledger.placeHold({ accountId: 'acc_a', amount: 6_001, reference: 'txn-2', ttlSeconds: 300 }))).toBe('INSUFFICIENT_FUNDS');
    const cap = ledger.capture(h.id, { counterAccountId: 'gl_switch', createdBy: by });
    expect(cap.hold.status).toBe('CAPTURED');
    expect(cap.entry.kind).toBe('HOLD_CAPTURE');
    expect(ledger.balance('acc_a')).toMatchObject({ ledgerBalance: 6_000, heldAmount: 0 });
    expect(ledger.balance('gl_switch').ledgerBalance).toBe(4_000);
    const again = ledger.capture(h.id, { counterAccountId: 'gl_switch', createdBy: by });
    expect(again.entry.id).toBe(cap.entry.id);
    expect(code(() => ledger.capture(h.id, { counterAccountId: 'acc_b', createdBy: by }))).toBe('HOLD_CAPTURED_DIFFERENTLY');
    expect(code(() => ledger.releaseHold(h.id))).toBe('HOLD_ALREADY_CAPTURED');
    const h2 = ledger.placeHold({ accountId: 'acc_a', amount: 1_000, reference: 'txn-3', ttlSeconds: 300 });
    expect(ledger.releaseHold(h2.id).status).toBe('RELEASED');
    expect(ledger.releaseHold(h2.id).status).toBe('RELEASED');
    expect(code(() => ledger.capture(h2.id, { counterAccountId: 'gl_switch', createdBy: by }))).toBe('HOLD_NOT_ACTIVE');
    expect(ledger.balance('acc_a').availableBalance).toBe(6_000);
    expect(ledger.invariants().ok).toBe(true);
  });

  it('expires holds and refuses late capture', () => {
    const { ledger, clock } = setupLedger();
    ledger.deposit('acc_a', 10_000, 'dep', by);
    const h1 = ledger.placeHold({ accountId: 'acc_a', amount: 1_000, reference: 'a', ttlSeconds: 60 });
    const h2 = ledger.placeHold({ accountId: 'acc_a', amount: 2_000, reference: 'b', ttlSeconds: 60 });
    ledger.placeHold({ accountId: 'acc_a', amount: 3_000, reference: 'c', ttlSeconds: 600 });
    clock.advanceSeconds(61);
    expect(code(() => ledger.capture(h1.id, { counterAccountId: 'gl_switch', createdBy: by }))).toBe('HOLD_EXPIRED');
    expect(ledger.getHold(h1.id).status).toBe('EXPIRED');
    expect(ledger.invariants().totals.staleActiveHolds).toBe(1);
    expect(ledger.expireHolds()).toBe(1);
    expect(ledger.getHold(h2.id).status).toBe('EXPIRED');
    expect(ledger.balance('acc_a')).toMatchObject({ heldAmount: 3_000, availableBalance: 7_000 });
    expect(ledger.invariants().ok).toBe(true);
  });

  it('validates hold input', () => {
    const { ledger } = setupLedger();
    expect(code(() => ledger.placeHold({ accountId: 'gl_cash', amount: 1, reference: 'x', ttlSeconds: 60 }))).toBe('HOLD_ON_INTERNAL');
    expect(code(() => ledger.placeHold({ accountId: 'acc_a', amount: 1, reference: 'x', ttlSeconds: 0 }))).toBe('HOLD_TTL_INVALID');
    expect(code(() => ledger.placeHold({ accountId: 'acc_a', amount: -1, reference: 'x', ttlSeconds: 60 }))).toBe('INVALID_AMOUNT');
  });
});

describe('reversals', () => {
  it('reverses once with negated postings', () => {
    const { ledger } = setupLedger();
    ledger.deposit('acc_a', 10_000, 'dep', by);
    const t = ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: 'acc_a', amount: -3_000 }, { accountId: 'acc_b', amount: 3_000 }], createdBy: by });
    const r = ledger.reverse(t.id, 'customer dispute', by);
    expect(r.kind).toBe('REVERSAL');
    expect(r.reversesEntryId).toBe(t.id);
    expect(r.postings).toEqual([{ accountId: 'acc_a', amount: 3_000 }, { accountId: 'acc_b', amount: -3_000 }]);
    expect(ledger.entry(t.id).reversedByEntryId).toBe(r.id);
    expect(ledger.balance('acc_a').ledgerBalance).toBe(10_000);
    expect(code(() => ledger.reverse(t.id, 'again', by))).toBe('ENTRY_ALREADY_REVERSED');
    expect(code(() => ledger.reverse(r.id, 'undo', by))).toBe('CANNOT_REVERSE_REVERSAL');
    expect(ledger.invariants().ok).toBe(true);
  });

  it('cannot reverse a credit the customer already spent', () => {
    const { ledger } = setupLedger();
    const dep = ledger.deposit('acc_a', 5_000, 'dep', by);
    ledger.post({ kind: 'TRANSFER', reference: 'tx', postings: [{ accountId: 'acc_a', amount: -5_000 }, { accountId: 'acc_b', amount: 5_000 }], createdBy: by });
    expect(code(() => ledger.reverse(dep.id, 'bounced', by))).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('reporting', () => {
  it('computes point in time balances and running statements', () => {
    const { ledger, clock } = setupLedger();
    ledger.deposit('acc_a', 10_000, 'dep-1', by);
    clock.advanceSeconds(60);
    const mid = clock.now().toISOString();
    clock.advanceSeconds(60);
    ledger.post({ kind: 'TRANSFER', reference: 'tx-1', postings: [{ accountId: 'acc_a', amount: -4_000 }, { accountId: 'acc_b', amount: 4_000 }], createdBy: by });
    const h = ledger.placeHold({ accountId: 'acc_a', amount: 1_000, reference: 'h', ttlSeconds: 600 });
    clock.advanceSeconds(60);
    ledger.releaseHold(h.id);
    expect(ledger.balance('acc_a', mid)).toMatchObject({ ledgerBalance: 10_000, heldAmount: 0 });
    const s = ledger.statement('acc_a', { limit: 100 });
    expect(s.lines.map((l) => [l.direction, l.amount, l.balanceAfter])).toEqual([
      ['CREDIT', 10_000, 10_000],
      ['DEBIT', -4_000, 6_000],
    ]);
    expect(s.closingBalance).toBe(ledger.balance('acc_a').ledgerBalance);
    const later = ledger.statement('acc_a', { from: mid, limit: 100 });
    expect(later.openingBalance).toBe(10_000);
    expect(later.lines).toHaveLength(1);
  });
});

describe('database guards', () => {
  it('refuses to mutate or delete posted history', () => {
    const { ledger, db } = setupLedger();
    const e = ledger.deposit('acc_a', 1_000, 'dep', by);
    expect(() => db.prepare('UPDATE postings SET amount = 5 WHERE entry_id = ?').run(e.id)).toThrow(/LEDGER_POSTING_IMMUTABLE/);
    expect(() => db.prepare('DELETE FROM postings WHERE entry_id = ?').run(e.id)).toThrow(/LEDGER_POSTING_IMMUTABLE/);
    expect(() => db.prepare('DELETE FROM journal_entries WHERE id = ?').run(e.id)).toThrow(/LEDGER_ENTRY_IMMUTABLE/);
    expect(() => db.prepare("UPDATE journal_entries SET reference = 'x' WHERE id = ?").run(e.id)).toThrow(/LEDGER_ENTRY_IMMUTABLE/);
    expect(() => db.prepare("INSERT INTO postings (entry_id, account_id, amount, created_at) VALUES (?, 'acc_b', 1, 'now')").run(e.id)).toThrow(
      /LEDGER_ENTRY_IMMUTABLE/,
    );
  });

  it('refuses to post an unbalanced entry even when bypassing the service', () => {
    const { db } = setupLedger();
    db.prepare("INSERT INTO journal_entries (id, kind, status, reference, created_by, created_at) VALUES ('j1', 'ADJUSTMENT', 'PENDING', 'r', 'x', 'now')").run();
    db.prepare("INSERT INTO postings (entry_id, account_id, amount, created_at) VALUES ('j1', 'acc_a', 100, 'now')").run();
    db.prepare("INSERT INTO postings (entry_id, account_id, amount, created_at) VALUES ('j1', 'acc_b', -99, 'now')").run();
    expect(() => db.prepare("UPDATE journal_entries SET status = 'POSTED' WHERE id = 'j1'").run()).toThrow(/LEDGER_UNBALANCED/);
  });

  it('detects tampered cached balances', () => {
    const { ledger, db } = setupLedger();
    ledger.deposit('acc_a', 1_000, 'dep', by);
    db.prepare("UPDATE balances SET ledger_balance = 999999 WHERE account_id = 'acc_a'").run();
    const report = ledger.invariants();
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'balance_matches_postings')?.violations).toHaveLength(1);
  });
});

describe('account projection', () => {
  it('ignores stale events and applies ordered status changes', () => {
    const { ledger } = setupLedger();
    ledger.upsertAccount(account('acc_p', { status: 'ACTIVE' }));
    ledger.applyAccountEvent('AccountOpened', { accountId: 'acc_p', bankCode: 'KOSH', type: 'SAVINGS', glCode: null, status: 'PENDING', overdraftLimit: 0, perTxnLimit: 1, dailyDebitLimit: 1, holderName: 'x' });
    expect(ledger.account('acc_p').status).toBe('ACTIVE');
    ledger.applyAccountEvent('AccountStatusChanged', { accountId: 'acc_p', bankCode: 'KOSH', from: 'PENDING', to: 'ACTIVE' });
    expect(ledger.account('acc_p').status).toBe('ACTIVE');
    ledger.applyAccountEvent('AccountStatusChanged', { accountId: 'acc_p', bankCode: 'KOSH', from: 'ACTIVE', to: 'FROZEN' });
    expect(ledger.account('acc_p').status).toBe('FROZEN');
    ledger.applyAccountEvent('LimitChanged', { accountId: 'acc_p', bankCode: 'KOSH', perTxnLimit: 5, dailyDebitLimit: 10, overdraftLimit: 0 });
    expect(ledger.account('acc_p')).toMatchObject({ per_txn_limit: 5, daily_debit_limit: 10 });
    ledger.applyAccountEvent('AccountOpened', { accountId: 'acc_new', bankCode: 'KOSH', type: 'SAVINGS', glCode: null, status: 'PENDING', overdraftLimit: 0, perTxnLimit: 1, dailyDebitLimit: 1, holderName: 'n' });
    expect(ledger.balance('acc_new').ledgerBalance).toBe(0);
  });
});
