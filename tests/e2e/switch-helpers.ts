import { expect } from 'vitest';
import { adminToken, bankOps, call, createStaff, gw, idemKey, internalHeaders, openAccount, poll, registerCustomer, uniqueSuffix, url, type Session } from './helpers.ts';

export const MPIN = '1357';
export const TERMINAL = ['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'];

export interface Customer {
  session: Session;
  bank: string;
  address: string;
  accountId: string;
}

export async function customer(bank: string, deposit = 0): Promise<Customer> {
  const ops = await bankOps(bank);
  const session = await registerCustomer();
  const mpin = await call('PUT', gw('/api/identity/mpin'), { token: session.accessToken, body: { mpin: MPIN } });
  expect(mpin.status).toBe(200);
  const acct = await openAccount(ops, { name: session.name, phone: session.phone });
  await call('GET', gw(`/api/accounts/discover?bankCode=${bank}`), { token: session.accessToken });
  const handle = `s${uniqueSuffix()}`.slice(0, 24);
  const psp = bank.toLowerCase();
  const vpa = await call('POST', gw('/api/vpa/vpas'), { token: session.accessToken, body: { handle, pspHandle: psp } });
  expect(vpa.status).toBe(201);
  const link = await call('POST', gw(`/api/vpa/vpas/${vpa.body.address}/links`), { token: session.accessToken, body: { accountId: acct.accountId } });
  expect(link.status).toBe(201);
  if (deposit > 0) await fund(bank, acct.accountId, deposit);
  return { session, bank, address: vpa.body.address as string, accountId: acct.accountId };
}

export async function fund(bank: string, accountId: string, amount: number) {
  const ops = await bankOps(bank);
  const r = await call('POST', gw(`/api/ledger/banks/${bank}/deposits`), { token: ops.maker.token, idempotencyKey: idemKey(), body: { accountId, amount, reference: 'e2e switch funding' } });
  expect(r.status).toBe(201);
}

export async function mpinToken(c: Customer): Promise<string> {
  const r = await call('POST', gw('/api/identity/mpin/verify'), { token: c.session.accessToken, body: { mpin: MPIN, purpose: 'PAYMENT' } });
  expect(r.status).toBe(200);
  return r.body.mpinToken as string;
}

export async function pay(from: Customer, to: Customer | string, amount: number, opts: { key?: string; token?: string; note?: string } = {}) {
  const token = opts.token ?? (await mpinToken(from));
  return call('POST', gw('/api/switch/pay'), {
    token: from.session.accessToken,
    idempotencyKey: opts.key ?? idemKey(),
    body: { payerVpa: from.address, payeeVpa: typeof to === 'string' ? to : to.address, amount, mpinToken: token, ...(opts.note ? { note: opts.note } : {}) },
  });
}

export async function switchTxn(txnId: string): Promise<any | null> {
  try {
    const res = await fetch(url('KOSH_SWITCH_URL', `/internal/txns/${txnId}`), { headers: internalHeaders('e2e'), signal: AbortSignal.timeout(2000) });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function waitState(txnId: string, states: string[] = TERMINAL, timeoutMs = 20000): Promise<any> {
  return poll(async () => {
    const t = await switchTxn(txnId);
    return t && states.includes(t.txn.state) ? t : null;
  }, `txn ${txnId} to reach ${states.join('/')}`, timeoutMs);
}

export async function payAndWait(from: Customer, to: Customer, amount: number) {
  const r = await pay(from, to, amount);
  expect(r.status).toBe(202);
  return waitState(r.body.id);
}

let adminCache: Promise<string> | null = null;
export function admin(): Promise<string> {
  adminCache ??= adminToken();
  return adminCache;
}

let opsCache: Promise<{ id: string; token: string }> | null = null;
export async function switchOps(): Promise<string> {
  opsCache ??= (async () => createStaff(await admin(), 'SWITCH_OPS', null))();
  return (await opsCache).token;
}

export async function balance(c: Customer): Promise<{ ledgerBalance: number; heldAmount: number }> {
  const r = await call('GET', gw(`/api/ledger/banks/${c.bank}/accounts/${c.accountId}/balance`), { token: await admin() });
  expect(r.status).toBe(200);
  return r.body;
}

export async function ledgerByReference(bank: string, reference: string) {
  const token = await admin();
  const [entries, holds] = await Promise.all([
    call('GET', gw(`/api/ledger/banks/${bank}/entries?reference=${reference}`), { token }),
    call('GET', gw(`/api/ledger/banks/${bank}/holds?reference=${reference}`), { token }),
  ]);
  return { entries: entries.body.entries as any[], holds: holds.body.holds as any[] };
}

export async function expectInvariants() {
  const r = await call('GET', gw('/api/ledger/admin/invariants'), { token: await admin() });
  expect(r.status).toBe(200);
  expect(r.body.ok, JSON.stringify(r.body.banks?.filter((b: { ok: boolean }) => !b.ok))).toBe(true);
}

export async function setFault(bank: string, op: string, body: Record<string, unknown>) {
  const r = await call('PUT', gw(`/api/adapter/banks/${bank}/faults/${op}`), { token: await admin(), body });
  expect(r.status).toBe(200);
}

export async function clearFaults(...banks: string[]) {
  const token = await admin();
  for (const b of banks.length ? banks : ['KOSH', 'ALPHA', 'BETA']) await call('DELETE', gw(`/api/adapter/banks/${b}/faults`), { token });
}

export async function switchHealthy(timeoutMs = 20000) {
  await poll(async () => {
    try {
      const r = await fetch(url('KOSH_SWITCH_URL', '/ready'), { signal: AbortSignal.timeout(1000) });
      return r.ok;
    } catch {
      return false;
    }
  }, 'switch-service to be ready', timeoutMs);
}

export async function armCrash(crashAt: string | null, txnId: string | null = null) {
  const r = await fetch(url('KOSH_SWITCH_URL', '/internal/chaos'), {
    method: 'PUT',
    headers: { ...internalHeaders('e2e'), 'content-type': 'application/json' },
    body: JSON.stringify({ crashAt, txnId }),
  });
  expect(r.status).toBe(200);
}

export async function switchOwner(): Promise<string | null> {
  try {
    const r = await call('GET', gw('/api/switch/ops/metrics'), { token: await switchOps() });
    return r.status === 200 ? (r.body.owner as string) : null;
  } catch {
    return null;
  }
}

export function stepCount(detail: any, step: string, status?: string): number {
  return (detail.steps as { step: string; status: string }[]).filter((s) => s.step === step && (!status || s.status === status)).length;
}
