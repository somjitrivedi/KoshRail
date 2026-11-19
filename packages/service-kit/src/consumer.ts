import type { DeliveredEvent } from '@kosh/contracts';
import type { BusSubscriber } from './bus.ts';
import type { Db } from './db.ts';
import { tx } from './db.ts';
import type { Logger } from './logger.ts';

export function processOnce(db: Db, consumer: string, eventId: string, fn: () => void): boolean {
  return tx(db, () => {
    const inserted = db
      .prepare('INSERT OR IGNORE INTO _inbox (consumer, event_id, processed_at) VALUES (?, ?, ?)')
      .run(consumer, eventId, new Date().toISOString());
    if (inserted.changes === 0) return false;
    fn();
    return true;
  });
}

export interface ConsumerOptions {
  bus: BusSubscriber;
  group: string;
  topics: string[];
  resolveDb: (event: DeliveredEvent) => Db | null;
  handle: (event: DeliveredEvent, db: Db) => void;
  log: Logger;
  pollIntervalMs?: number;
  batchSize?: number;
}

export interface PollResult {
  delivered: number;
  processed: number;
  duplicates: number;
  skipped: number;
}

export class Consumer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling: Promise<PollResult> | null = null;

  constructor(private readonly opts: ConsumerOptions) {}

  pollOnce(): Promise<PollResult> {
    if (!this.polling) {
      this.polling = this.doPoll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  private async doPoll(): Promise<PollResult> {
    const result: PollResult = { delivered: 0, processed: 0, duplicates: 0, skipped: 0 };
    const { bus, group, topics, resolveDb, handle, log } = this.opts;
    for (const topic of topics) {
      const events = await bus.fetch(group, topic, this.opts.batchSize ?? 100);
      let committed: number | null = null;
      for (const event of events) {
        result.delivered++;
        const db = resolveDb(event);
        if (!db) {
          result.skipped++;
          committed = event.offset;
          continue;
        }
        try {
          const fresh = processOnce(db, group, event.id, () => handle(event, db));
          if (fresh) result.processed++;
          else result.duplicates++;
          committed = event.offset;
        } catch (err) {
          log.error('event handler failed; will retry', { group, topic, eventId: event.id, type: event.type, err: err as Error });
          break;
        }
      }
      if (committed !== null) await bus.commit(group, topic, committed);
    }
    return result;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.opts.pollIntervalMs ?? 100;
    const tick = async () => {
      if (!this.running) return;
      let busy = false;
      try {
        const r = await this.pollOnce();
        busy = r.delivered > 0;
      } catch (err) {
        this.opts.log.warn('consumer poll failed', { group: this.opts.group, err: err as Error });
      }
      if (this.running) this.timer = setTimeout(tick, busy ? 0 : interval);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => undefined);
  }
}
