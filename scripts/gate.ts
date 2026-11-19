import { spawnSync } from 'node:child_process';
import { ROOT } from './stack.ts';

const PHASE_DIRS: Record<string, string[]> = {
  '0': ['packages/money', 'packages/service-kit', 'services/event-bus'],
  '1': ['services/identity-service', 'services/api-gateway'],
  '2': ['services/account-service'],
  '3': ['services/ledger-service'],
  '4': ['services/bank-adapter', 'services/vpa-service'],
  '5.1': ['services/switch-service'],
  '5.2': [],
  '5.3': [],
  '5.4': [],
  '5.5': [],
};

const ORDER = Object.keys(PHASE_DIRS);
const target = process.argv[2] === '5' ? '5.5' : (process.argv[2] ?? '');
if (!ORDER.includes(target)) {
  process.stderr.write(`usage: tsx scripts/gate.ts <${ORDER.join('|')}|5>\n`);
  process.exit(2);
}
const phase = target;
const included = ORDER.slice(0, ORDER.indexOf(target) + 1);
const dirs = included.flatMap((p) => PHASE_DIRS[p] ?? []);
const e2eFiles = included.map((p) => `tests/e2e/phase-${p}.test.ts`);
const maxPhase = String(Math.floor(Number(target)));

interface Step {
  name: string;
  args: string[];
  env?: Record<string, string>;
}

const steps: Step[] = [
  { name: 'typecheck', args: ['tsc', '-p', 'tsconfig.json'] },
  { name: 'lint', args: ['oxlint', 'packages', 'services', 'scripts', 'tests'] },
  { name: `unit+integration (${dirs.length} modules)`, args: ['vitest', 'run', ...dirs] },
  { name: `e2e phases 0..${phase}`, args: ['vitest', 'run', '-c', 'vitest.e2e.config.ts', ...e2eFiles], env: { KOSH_MAX_PHASE: maxPhase } },
];

const results: { name: string; ok: boolean; seconds: number }[] = [];
for (const step of steps) {
  process.stdout.write(`\n=== gate:${phase} :: ${step.name} ===\n`);
  const started = Date.now();
  const r = spawnSync('npx', step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(step.env ?? {}) },
  });
  const ok = r.status === 0;
  results.push({ name: step.name, ok, seconds: (Date.now() - started) / 1000 });
  if (!ok) break;
}

process.stdout.write(`\n=== gate:${phase} summary ===\n`);
for (const r of results) process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(40)} ${r.seconds.toFixed(1)}s\n`);
const skipped = steps.slice(results.length).map((s) => s.name);
for (const s of skipped) process.stdout.write(`  SKIP  ${s}\n`);
const green = results.length === steps.length && results.every((r) => r.ok);
process.stdout.write(green ? `\ngate:${phase} GREEN\n` : `\ngate:${phase} RED\n`);
process.exit(green ? 0 : 1);
