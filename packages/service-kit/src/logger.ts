const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info') as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function serialize(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
  return out;
}

export function createLogger(service: string): Logger {
  const write = (level: Exclude<Level, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold()) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, service, msg, ...serialize(fields) });
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
