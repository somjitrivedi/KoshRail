import type { DeliveredEvent, EventEnvelope } from '@kosh/contracts';
import { type Db, tx } from '@kosh/service-kit';

interface EventRow {
  seq: number;
  id: string;
  topic: string;
  type: string;
  key: string;
  payload: string;
  occurred_at: string;
  source: string;
}

function toDelivered(r: EventRow): DeliveredEvent {
  return {
    offset: r.seq,
    id: r.id,
    topic: r.topic,
    type: r.type,
    key: r.key,
    occurredAt: r.occurred_at,
    source: r.source,
    payload: JSON.parse(r.payload) as unknown,
  };
}

export class EventStore {
  constructor(private readonly db: Db) {}

  append(events: EventEnvelope[]): { accepted: number; duplicates: number } {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO events (id, topic, type, key, payload, occurred_at, source, appended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    return tx(this.db, () => {
      let accepted = 0;
      const now = new Date().toISOString();
      for (const e of events) {
        const r = insert.run(e.id, e.topic, e.type, e.key, JSON.stringify(e.payload ?? null), e.occurredAt, e.source, now);
        accepted += r.changes;
      }
      return { accepted, duplicates: events.length - accepted };
    });
  }

  committed(group: string, topic: string): number {
    const v = this.db.prepare('SELECT committed_offset FROM group_offsets WHERE group_id = ? AND topic = ?').pluck().get(group, topic) as
      | number
      | undefined;
    return v ?? 0;
  }

  readAfter(topic: string, after: number, max: number): DeliveredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, id, topic, type, key, payload, occurred_at, source FROM events WHERE topic = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(topic, after, max) as EventRow[];
    return rows.map(toDelivered);
  }

  commit(group: string, topic: string, offset: number): number {
    return tx(this.db, () => {
      const current = this.committed(group, topic);
      const next = Math.max(current, offset);
      this.db
        .prepare(
          `INSERT INTO group_offsets (group_id, topic, committed_offset, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(group_id, topic) DO UPDATE SET committed_offset = excluded.committed_offset, updated_at = excluded.updated_at`,
        )
        .run(group, topic, next, new Date().toISOString());
      return next;
    });
  }

  seek(group: string, topic: string, offset: number): void {
    this.db
      .prepare(
        `INSERT INTO group_offsets (group_id, topic, committed_offset, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id, topic) DO UPDATE SET committed_offset = excluded.committed_offset, updated_at = excluded.updated_at`,
      )
      .run(group, topic, offset, new Date().toISOString());
  }

  topics(): { topic: string; count: number; lastOffset: number }[] {
    return this.db
      .prepare('SELECT topic, COUNT(*) AS count, MAX(seq) AS lastOffset FROM events GROUP BY topic ORDER BY topic')
      .all() as { topic: string; count: number; lastOffset: number }[];
  }

  groups(): { group: string; topic: string; committedOffset: number; lag: number }[] {
    return this.db
      .prepare(
        `SELECT g.group_id AS "group", g.topic, g.committed_offset AS committedOffset,
                (SELECT COUNT(*) FROM events e WHERE e.topic = g.topic AND e.seq > g.committed_offset) AS lag
         FROM group_offsets g ORDER BY g.group_id, g.topic`,
      )
      .all() as { group: string; topic: string; committedOffset: number; lag: number }[];
  }
}
