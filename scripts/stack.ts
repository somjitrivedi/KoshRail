import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

export interface ServiceDef {
  name: string;
  urlEnv: string;
  port: number;
  phase: number;
}

export const SERVICES: ServiceDef[] = [
  { name: 'event-bus', urlEnv: 'KOSH_EVENT_BUS_URL', port: 7000, phase: 0 },
  { name: 'identity-service', urlEnv: 'KOSH_IDENTITY_URL', port: 7001, phase: 1 },
  { name: 'account-service', urlEnv: 'KOSH_ACCOUNT_URL', port: 7002, phase: 2 },
  { name: 'ledger-service', urlEnv: 'KOSH_LEDGER_URL', port: 7003, phase: 3 },
  { name: 'bank-adapter', urlEnv: 'KOSH_ADAPTER_URL', port: 7004, phase: 4 },
  { name: 'vpa-service', urlEnv: 'KOSH_VPA_URL', port: 7005, phase: 4 },
  { name: 'switch-service', urlEnv: 'KOSH_SWITCH_URL', port: 7006, phase: 5 },
  { name: 'api-gateway', urlEnv: 'KOSH_GATEWAY_URL', port: 8080, phase: 1 },
];

export interface StackOptions {
  dataDir: string;
  portOffset?: number;
  extraEnv?: Record<string, string>;
  logMode: 'inherit' | 'files';
  maxPhase?: number;
  restartOnCrash?: string[];
}

export interface RunningService {
  def: ServiceDef;
  url: string;
  child: ChildProcess;
  restarts: number;
}

export interface Stack {
  urls: Record<string, string>;
  services: RunningService[];
  stop: () => Promise<void>;
}

export function serviceExists(def: ServiceDef): boolean {
  return existsSync(join(ROOT, 'services', def.name, 'src', 'main.ts'));
}

export function stackUrls(offset: number): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const s of SERVICES) urls[s.urlEnv] = `http://127.0.0.1:${s.port + offset}`;
  return urls;
}

async function waitHealthy(url: string, child: ChildProcess, name: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode} before becoming healthy`);
    try {
      const res = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  const offset = opts.portOffset ?? 0;
  const urls = stackUrls(offset);
  mkdirSync(opts.dataDir, { recursive: true });
  const defs = SERVICES.filter((s) => serviceExists(s) && (opts.maxPhase === undefined || s.phase <= opts.maxPhase));
  const running: RunningService[] = [];
  const restartable = new Set(opts.restartOnCrash ?? []);
  let stopping = false;

  const spawnChild = (def: ServiceDef): ChildProcess => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...urls,
      PORT: String(def.port + offset),
      KOSH_DATA_DIR: opts.dataDir,
      ...(opts.extraEnv ?? {}),
    };
    const child = spawn(process.execPath, ['--import', 'tsx', join('services', def.name, 'src', 'main.ts')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (opts.logMode === 'files') {
      const out = createWriteStream(join(opts.dataDir, `${def.name}.log`), { flags: 'a' });
      child.stdout?.pipe(out);
      child.stderr?.pipe(out);
    } else {
      const prefix = `[${def.name}] `;
      const pipe = (stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream) =>
        stream?.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) if (line.trim()) target.write(`${prefix}${line}\n`);
        });
      pipe(child.stdout, process.stdout);
      pipe(child.stderr, process.stderr);
    }
    return child;
  };

  const supervise = (entry: RunningService) => {
    entry.child.once('exit', (code) => {
      if (stopping || !restartable.has(entry.def.name)) return;
      entry.restarts++;
      process.stdout.write(`[stack] ${entry.def.name} exited with code ${code}; restarting (restart #${entry.restarts})\n`);
      setTimeout(() => {
        if (stopping) return;
        entry.child = spawnChild(entry.def);
        supervise(entry);
      }, 200);
    });
  };

  const stop = async () => {
    stopping = true;
    await Promise.all(
      running.map(
        (r) =>
          new Promise<void>((done) => {
            if (r.child.exitCode !== null) return done();
            r.child.once('exit', () => done());
            r.child.kill();
            setTimeout(done, 3000);
          }),
      ),
    );
  };
  try {
    for (const def of defs) {
      const url = urls[def.urlEnv]!;
      const entry: RunningService = { def, url, child: spawnChild(def), restarts: 0 };
      running.push(entry);
      await waitHealthy(url, entry.child, def.name);
      supervise(entry);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { urls, services: running, stop };
}
