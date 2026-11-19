import { generateKeyPairSync, randomUUID } from 'node:crypto';

const GATEWAY = process.env.KOSH_GATEWAY_URL ?? 'http://127.0.0.1:8080';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345';
const STAFF_PASSWORD = 'Kosh-Staff-123';
const DEMO_MPIN = '1357';

const DEMO_CUSTOMERS = [
  { name: 'Asha Verma', phone: '9999999999', bank: 'KOSH', handle: 'asha', psp: 'kosh', deposit: 1_000_000 },
  { name: 'Ravi Kumar', phone: '8888888888', bank: 'ALPHA', handle: 'ravi', psp: 'alpha', deposit: 1_000_000 },
  { name: 'Meera Iyer', phone: '7777777777', bank: 'BETA', handle: 'meera', psp: 'beta', deposit: 1_000_000 },
];

async function api(method: string, path: string, body?: unknown, token?: string, idem?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = idem;
  const res = await fetch(`${GATEWAY}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

function must<T extends { status: number; body: any }>(r: T, ok: number[], what: string): T {
  if (!ok.includes(r.status)) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

async function staffToken(username: string, password: string) {
  return must(await api('POST', '/api/identity/staff/login', { username, password }), [200], `login ${username}`).body.accessToken as string;
}

const admin = await staffToken('admin', ADMIN_PASSWORD);
const ops: Record<string, { maker: string; checker: string }> = {};
for (const bank of ['KOSH', 'ALPHA', 'BETA']) {
  for (const role of ['maker', 'checker']) {
    const username = `${role}.${bank.toLowerCase()}`;
    must(await api('POST', '/api/identity/staff', { username, name: `${bank} ${role}`, password: STAFF_PASSWORD, role: 'BANK_OPS', bankCode: bank }, admin), [201, 409], `create ${username}`);
  }
  ops[bank] = { maker: await staffToken(`maker.${bank.toLowerCase()}`, STAFF_PASSWORD), checker: await staffToken(`checker.${bank.toLowerCase()}`, STAFF_PASSWORD) };
}
must(await api('POST', '/api/identity/staff', { username: 'switch.ops', name: 'Switch Ops', password: STAFF_PASSWORD, role: 'SWITCH_OPS', bankCode: null }, admin), [201, 409], 'create switch.ops');

for (const c of DEMO_CUSTOMERS) {
  const otp = await api('POST', '/api/identity/otp/request', { phone: c.phone, purpose: 'REGISTER' });
  if (otp.status === 409) {
    process.stdout.write(`skip ${c.name}: already registered\n`);
    continue;
  }
  must(otp, [201], `otp ${c.phone}`);
  if (!otp.body.devCode) throw new Error('OTP_DEV_ECHO must be true for seeding (npm run dev sets it)');
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const reg = must(
    await api('POST', '/api/identity/register', {
      challengeId: otp.body.challengeId,
      code: otp.body.devCode,
      name: c.name,
      deviceId: `seed-${randomUUID()}`,
      devicePublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }),
    [201],
    `register ${c.name}`,
  );
  const user = reg.body.accessToken as string;
  must(await api('PUT', '/api/identity/mpin', { mpin: DEMO_MPIN }, user), [200], 'set mpin');
  const maker = ops[c.bank]!.maker;
  const customer = must(await api('POST', '/api/accounts/customers', { bankCode: c.bank, fullName: c.name, phone: c.phone, kycTier: 'FULL' }, maker), [201], 'customer');
  const account = must(await api('POST', '/api/accounts/accounts', { customerId: customer.body.id, type: 'SAVINGS' }, maker), [201], 'account');
  must(await api('POST', `/api/accounts/accounts/${account.body.id}/activate`, { reason: 'seed' }, maker), [200], 'activate');
  must(await api('POST', `/api/ledger/banks/${c.bank}/deposits`, { accountId: account.body.id, amount: c.deposit, reference: 'seed opening deposit' }, maker, `seed-${account.body.id}`), [201], 'deposit');
  must(await api('GET', `/api/accounts/discover?bankCode=${c.bank}`, undefined, user), [200], 'discover');
  const vpa = must(await api('POST', '/api/vpa/vpas', { handle: c.handle, pspHandle: c.psp }, user), [201, 409], 'vpa');
  if (vpa.status === 201) must(await api('POST', `/api/vpa/vpas/${vpa.body.address}/links`, { accountId: account.body.id }, user), [201], 'link');
  process.stdout.write(`seeded ${c.name} (${c.phone}) ${c.bank} ${account.body.accountNumber} -> ${c.handle}@${c.psp}, balance Rs ${c.deposit / 100}\n`);
}

process.stdout.write(`\nstaff: maker.<bank> / checker.<bank> / switch.ops  password ${STAFF_PASSWORD}\nadmin: admin / ${ADMIN_PASSWORD}\ndemo MPIN: ${DEMO_MPIN}\n`);
