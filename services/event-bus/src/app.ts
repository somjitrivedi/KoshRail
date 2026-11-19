import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { EventEnvelopeSchema, type EventEnvelope } from '@kosh/contracts';
import { createApp, type Db, type Logger, param, parse, queryInt, queryString, badRequest } from '@kosh/service-kit';
import { EventStore } from './store.ts';

const PublishSchema = z.object({ events: z.array(EventEnvelopeSchema).min(1).max(1000) });
const OffsetSchema = z.object({ topic: z.string().min(1), offset: z.number().int().min(0) });

export interface BusDeps {
  db: Db;
  log: Logger;
  internalToken: string;
}

export function buildBusApp({ db, log, internalToken }: BusDeps) {
  const store = new EventStore(db);
  const signal = new EventEmitter();
  signal.setMaxListeners(0);

  return createApp({ name: 'event-bus', internalToken, log }, (app) => {
    app.post('/publish', (req, res) => {
      const { events } = parse(PublishSchema, req.body);
      const result = store.append(events as EventEnvelope[]);
      for (const topic of new Set(events.map((e) => e.topic))) signal.emit(topic);
      res.status(202).json(result);
    });

    app.get('/topics', (_req, res) => {
      res.json({ topics: store.topics() });
    });

    app.get('/groups', (_req, res) => {
      res.json({ groups: store.groups() });
    });

    app.get('/topics/:topic/events', async (req, res) => {
      const topic = param(req, 'topic');
      const group = queryString(req, 'group');
      const afterParam = queryString(req, 'after');
      if (!group && afterParam === undefined) throw badRequest('VALIDATION_FAILED', 'either group or after is required');
      const max = queryInt(req, 'max', 100, 1000);
      const waitMs = queryInt(req, 'waitMs', 0, 30000);
      const read = () => store.readAfter(topic, afterParam !== undefined ? Number(afterParam) : store.committed(group!, topic), max);
      let events = read();
      if (events.length === 0 && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.off(topic, done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          signal.on(topic, done);
          req.on('close', done);
        });
        events = read();
      }
      res.json({ events });
    });

    app.post('/groups/:group/commit', (req, res) => {
      const { topic, offset } = parse(OffsetSchema, req.body);
      res.json({ committedOffset: store.commit(param(req, 'group'), topic, offset) });
    });

    app.post('/groups/:group/seek', (req, res) => {
      const { topic, offset } = parse(OffsetSchema, req.body);
      store.seek(param(req, 'group'), topic, offset);
      res.json({ committedOffset: offset });
    });
  });
}
