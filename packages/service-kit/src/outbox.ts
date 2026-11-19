import type { EventEnvelope } from '@kosh/contracts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { BusPublisher } from './bus.ts';
import type { Db } from './db.ts';
import { newId } from './ids.ts';
import type { Logger } from './logger.ts';

export interface OutgoingEvent {
  topic: string;
  type: string;
  key: string;
  payload: unknown;
}

export function emit(db: Db, event: OutgoingEvent, clock: Clock = systemClock): string {
  const id = newId('evt');
  db.prepare('INSERT INTO _outbox (id, topic, type, key, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    event.topic,
    event.type,
    event.key,
    JSON.stringify(event.payload),
    clock.now().toISOString(),
  );
  return id;
}

interface OutboxRow {
  seq: number;
  id: string;
  topic: string;
  type: string;
  key: string;
  payload: string;
  occurred_at: string;
}

export function pendingOutbox(db: Db): number {
  return db.prepare('SELECT COUNT(*) FROM _outbox WHERE sent_at IS NULL').pluck().get() as number;
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private flushing: Promise<number> | null = null;

  constructor(
    private readonly db: Db,
    private readonly bus: BusPublisher,
    private readonly source: string,
    private readonly log: Logger,
    private readonly intervalMs = 100,
    private readonly batchSize = 200,
  ) {}

  flush(): Promise<number> {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async doFlush(): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = this.db
        .prepare('SELECT seq, id, topic, type, key, payload, occurred_at FROM _outbox WHERE sent_at IS NULL ORDER BY seq LIMIT ?')
        .all(this.batchSize) as OutboxRow[];
      if (rows.length === 0) return total;
      const events: EventEnvelope[] = rows.map((r) => ({
        id: r.id,
        topic: r.topic,
        type: r.type,
        key: r.key,
        occurredAt: r.occurred_at,
        source: this.source,
        payload: JSON.parse(r.payload) as unknown,
      }));
      await this.bus.publish(events);
      const mark = this.db.prepare('UPDATE _outbox SET sent_at = ? WHERE seq = ?');
      const sentAt = new Date().toISOString();
      this.db.transaction(() => {
        for (const r of rows) mark.run(sentAt, r.seq);
      })();
      total += rows.length;
      if (rows.length < this.batchSize) return total;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.flush();
      } catch (err) {
        this.log.warn('outbox relay publish failed', { err: err as Error });
      }
      if (this.running) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.flushing) await this.flushing.catch(() => undefined);
  }
}
