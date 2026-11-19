import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { startStack, type Stack } from '../../scripts/stack.ts';
import { SWITCH_E2E_ENV } from './switch-env.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    urls: Record<string, string>;
    internalToken: string;
    adminPassword: string;
    dataDir: string;
  }
}

const INTERNAL_TOKEN = 'e2e-internal-token';
const ADMIN_PASSWORD = 'E2e-Admin-Pass-1';

let stack: Stack | null = null;
let dataDir = '';

export async function setup(project: TestProject) {
  dataDir = mkdtempSync(join(tmpdir(), 'kosh-e2e-'));
  stack = await startStack({
    dataDir,
    portOffset: 10000,
    logMode: 'files',
    restartOnCrash: ['switch-service'],
    maxPhase: process.env.KOSH_MAX_PHASE ? Number(process.env.KOSH_MAX_PHASE) : undefined,
    extraEnv: {
      KOSH_INTERNAL_TOKEN: INTERNAL_TOKEN,
      ADMIN_PASSWORD,
      OTP_DEV_ECHO: 'true',
      LOG_LEVEL: 'info',
      RL_CUSTOMER_BURST: '40',
      RL_CUSTOMER_RPS: '20',
      RL_ANON_BURST: '500',
      RL_ANON_RPS: '500',
      HOLD_SWEEP_MS: '200',
      ADAPTER_FAULT_HANG_MS: '2000',
      ...SWITCH_E2E_ENV,
    },
  });
  project.provide('urls', stack.urls);
  project.provide('internalToken', INTERNAL_TOKEN);
  project.provide('adminPassword', ADMIN_PASSWORD);
  project.provide('dataDir', dataDir);
}

export async function teardown() {
  if (stack) await stack.stop();
  if (process.env.KOSH_KEEP_E2E_DATA) {
    process.stdout.write(`e2e data kept at ${dataDir}\n`);
    return;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    return;
  }
}
