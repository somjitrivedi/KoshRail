import { generateKeyPairSync, randomUUID } from 'node:crypto';

const GATEWAY = process.env.KOSH_GATEWAY_URL ?? 'http://127.0.0.1:8080';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345';
const PAYMENTS = Number(process.env.LOAD_PAYMENTS ?? 200);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 16);
const PAIRS = Number(process.env.LOAD_PAIRS ?? 12);
const BANKS = ['KOSH', 'ALPHA', 'BETA'];
const MPIN = '2580';

interface Res {
  status: number;
  body: any;
}

async function api(method: string, path: string, body?: unknown, token?: string, idem?: string): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = idem;
  const res = await fetch(`${GATEWAY}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

function must(r: Res, ok: number[], what: string): Res {
  if (!ok.includes(r.status)) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retrying(fn: () => Promise<Res>): Promise<Res> {
  for (;;) {
    const r = await fn();
    if (r.status !== 429) return r;
    await sleep(Number(r.body?.error?.details?.retryAfterSeconds ?? 1) * 1000);
  }
}

const admin = must(await api('POST', '/api/identity/staff/login', { username: 'admin', password: ADMIN_PASSWORD }), [200], 'admin login').body.accessToken as string;
const opsName = `load.ops.${Date.now().toString(36)}`;
must(await api('POST', '/api/identity/staff', { username: opsName, name: 'Load Ops', password: 'Load-Ops-12345', role: 'SWITCH_OPS', bankCode: null }, admin), [201], 'create switch ops');
const switchOps = must(await api('POST', '/api/identity/staff/login', { username: opsName, password: 'Load-Ops-12345' }), [200], 'ops login').body.accessToken as string;
const makers: Record<string, string> = {};
for (const bank of BANKS) {
  const username = `load.maker.${bank.toLowerCase()}.${Date.now().toString(36)}`;
  must(await api('POST', '/api/identity/staff', { username, name: `${bank} load maker`, password: 'Load-Maker-12345', role: 'BANK_OPS', bankCode: bank }, admin), [201], 'create maker');
  makers[bank] = must(await api('POST', '/api/identity/staff/login', { username, password: 'Load-Maker-12345' }), [200], 'maker login').body.accessToken as string;
}

interface Party {
  token: string;
  address: string;
  bank: string;
  accountId: string;
}

let phoneSeq = Date.now() % 1_000_000;
async function party(bank: string, deposit: number): Promise<Party> {
  const phone = `6${String(phoneSeq++).padStart(9, '0').slice(-9)}`;
  const otp = must(await api('POST', '/api/identity/otp/request', { phone, purpose: 'REGISTER' }), [201], 'otp');
  if (!otp.body.devCode) throw new Error('OTP_DEV_ECHO must be true (npm run dev sets it)');
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = `Load User ${phone.slice(-4)}`;
  const reg = must(
    await api('POST', '/api/identity/register', {
      challengeId: otp.body.challengeId,
      code: otp.body.devCode,
      name,
      deviceId: `load-${randomUUID()}`,
      devicePublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }),
    [201],
    'register',
  );
  const token = reg.body.accessToken as string;
  must(await api('PUT', '/api/identity/mpin', { mpin: MPIN }, token), [200], 'mpin');
  const maker = makers[bank]!;
  const customer = must(await api('POST', '/api/accounts/customers', { bankCode: bank, fullName: name, phone, kycTier: 'FULL' }, maker), [201], 'customer');
  const account = must(await api('POST', '/api/accounts/accounts', { customerId: customer.body.id, type: 'SAVINGS' }, maker), [201], 'account');
  must(await api('POST', `/api/accounts/accounts/${account.body.id}/activate`, { reason: 'load' }, maker), [200], 'activate');
  if (deposit > 0) must(await api('POST', `/api/ledger/banks/${bank}/deposits`, { accountId: account.body.id, amount: deposit, reference: 'load funding' }, maker, `load-${account.body.id}`), [201], 'deposit');
  must(await api('GET', `/api/accounts/discover?bankCode=${bank}`, undefined, token), [200], 'discover');
  const vpa = must(await api('POST', '/api/vpa/vpas', { handle: `load${phone}`, pspHandle: bank.toLowerCase() }, token), [201], 'vpa');
  must(await api('POST', `/api/vpa/vpas/${vpa.body.address}/links`, { accountId: account.body.id }, token), [201], 'link');
  return { token, address: vpa.body.address as string, bank, accountId: account.body.id as string };
}

process.stdout.write(`creating ${PAIRS} payer/payee pairs...\n`);
const payers: Party[] = [];
const payees: Party[] = [];
for (let i = 0; i < PAIRS; i++) {
  payers.push(await party(BANKS[i % 3]!, 10_000_000));
  payees.push(await party(BANKS[(i + 1) % 3]!, 0));
}

const latencies: number[] = [];
const outcomes: Record<string, number> = {};
let next = 0;
async function worker() {
  while (next < PAYMENTS) {
    const i = next++;
    const payer = payers[i % PAIRS]!;
    const payee = payees[(i * 7) % PAIRS]!;
    const started = performance.now();
    const mpin = must(await retrying(() => api('POST', '/api/identity/mpin/verify', { mpin: MPIN, purpose: 'PAYMENT' }, payer.token)), [200], 'mpin verify');
    const key = `load-${randomUUID()}`;
    const r = must(
      await retrying(() => api('POST', '/api/switch/pay', { payerVpa: payer.address, payeeVpa: payee.address, amount: 100 + (i % 900), mpinToken: mpin.body.mpinToken }, payer.token, key)),
      [202],
      'pay',
    );
    for (;;) {
      await sleep(100);
      const s = await retrying(() => api('GET', `/api/switch/txn/${r.body.id}`, undefined, switchOps));
      if (['COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW'].includes(s.body.state)) {
        outcomes[s.body.state] = (outcomes[s.body.state] ?? 0) + 1;
        break;
      }
    }
    latencies.push(performance.now() - started);
  }
}

process.stdout.write(`running ${PAYMENTS} payments with ${CONCURRENCY} in flight...\n`);
const t0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]!.toFixed(0);
process.stdout.write(`\n${PAYMENTS} payments in ${seconds.toFixed(1)}s = ${(PAYMENTS / seconds).toFixed(1)} payments/s\n`);
process.stdout.write(`time to final state (client view): p50 ${pct(50)}ms  p95 ${pct(95)}ms  p99 ${pct(99)}ms  max ${latencies.at(-1)!.toFixed(0)}ms\n`);
process.stdout.write(`outcomes: ${JSON.stringify(outcomes)}\n`);
const metrics = must(await api('GET', '/api/switch/ops/metrics?windowMinutes=60', undefined, switchOps), [200], 'metrics').body;
process.stdout.write(`switch view: ${JSON.stringify({ window: metrics.window, latencyMs: metrics.latencyMs })}\n`);
const inv = must(await api('GET', '/api/ledger/admin/invariants', undefined, admin), [200], 'invariants').body;
process.stdout.write(`ledger invariants ok: ${inv.ok}\n`);
process.exit(inv.ok && (outcomes.COMPLETED ?? 0) === PAYMENTS ? 0 : 1);
