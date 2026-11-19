export function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required environment variable ${name}`);
}

export function envInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required environment variable ${name}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`environment variable ${name} must be an integer`);
  return n;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const DEV_INTERNAL_TOKEN = 'kosh-dev-internal-token';

export function internalToken(): string {
  return env('KOSH_INTERNAL_TOKEN', DEV_INTERNAL_TOKEN);
}

export function dataDir(): string {
  return env('KOSH_DATA_DIR', './data');
}

export const DEFAULT_PORTS = {
  eventBus: 7000,
  identity: 7001,
  account: 7002,
  ledger: 7003,
  adapter: 7004,
  vpa: 7005,
  switch: 7006,
  gateway: 8080,
} as const;

export function serviceUrl(name: keyof typeof DEFAULT_PORTS): string {
  const key = `KOSH_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_URL`;
  return env(key, `http://127.0.0.1:${DEFAULT_PORTS[name]}`);
}
