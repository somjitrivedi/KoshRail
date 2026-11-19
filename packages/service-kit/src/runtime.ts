import type { Express } from 'express';
import type { Server } from 'node:http';
import type { Logger } from './logger.ts';

export function listen(app: Express, port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err?: Error) => {
      if (err) reject(err);
      else resolve(server);
    });
    server.keepAliveTimeout = 5000;
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export class Loop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => unknown | Promise<unknown>,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.fn();
      } catch (err) {
        this.log.warn(`${this.name} loop failed`, { err: err as Error });
      }
      if (this.running) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface Stoppable {
  stop(): unknown;
}

export function runMain(name: string, log: Logger, main: () => Promise<Array<Stoppable | Server>>): void {
  main()
    .then((parts) => {
      let stopping = false;
      const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        log.info('shutting down', { signal });
        for (const p of parts.reverse()) {
          if ('closeAllConnections' in p) await closeServer(p as Server);
          else await (p as Stoppable).stop();
        }
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    })
    .catch((err: unknown) => {
      log.error(`${name} failed to start`, { err: err as Error });
      process.exit(1);
    });
}
