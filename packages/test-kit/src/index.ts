import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import type { Principal, Role } from '@kosh/contracts';
import { type Clock, closeServer, createLogger, listen, type Logger } from '@kosh/service-kit';

export const TEST_TOKEN = 'test-internal-token';

export function tempDir(prefix = 'kosh-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        return;
      }
    },
  };
}

export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-11-16T04:30:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceSeconds(s: number): void {
    this.current += s * 1000;
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }
}

export function testLogger(name = 'test'): Logger {
  return createLogger(name);
}

export async function serve(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await listen(app, 0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${addr.port}`, close: () => closeServer(server) };
}

export function customerPrincipal(userId: string, deviceId = 'dev-test'): Principal {
  return { sub: userId, kind: 'customer', roles: [], bankCode: null, deviceId, sid: `ses_${userId}` };
}

export function staffPrincipal(id: string, roles: Role[], bankCode: string | null = null): Principal {
  return { sub: id, kind: 'staff', roles, bankCode, deviceId: null, sid: `ses_${id}` };
}

export interface TestDevice {
  deviceId: string;
  publicKey: string;
  sign(message: string): string;
}

let deviceSeq = 0;
export function newTestDevice(deviceId = `device-${Date.now().toString(36)}-${deviceSeq++}`): TestDevice {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    deviceId,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (message: string) => sign('sha256', Buffer.from(message), privateKey).toString('base64'),
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.label ?? 'condition'}${last ? `: ${(last as Error).message}` : ''}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50));
  }
}
