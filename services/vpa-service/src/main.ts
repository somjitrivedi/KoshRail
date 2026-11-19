import { join } from 'node:path';
import { TOPICS } from '@kosh/contracts';
import {
  Consumer,
  createLogger,
  dataDir,
  envInt,
  HttpBus,
  internalToken,
  listen,
  migrationsDir,
  openDb,
  OutboxRelay,
  runMain,
  serviceUrl,
  systemClock,
} from '@kosh/service-kit';
import { buildVpa, httpAccountLookup } from './app.ts';

const log = createLogger('vpa-service');

runMain('vpa-service', log, async () => {
  const db = openDb(join(dataDir(), 'vpa.db'), migrationsDir(import.meta.url));
  const token = internalToken();
  const { app, svc } = buildVpa({ db, clock: systemClock, log, internalToken: token, accounts: httpAccountLookup(serviceUrl('account'), token), cacheTtlMs: envInt('VPA_CACHE_TTL_MS', 60000) });
  const bus = new HttpBus(serviceUrl('eventBus'), token, 'vpa-service');
  const relay = new OutboxRelay(db, bus, 'vpa-service', log);
  relay.start();
  const consumer = new Consumer({
    bus,
    group: 'vpa-service',
    topics: [TOPICS.account],
    resolveDb: () => db,
    handle: (e) => svc.applyAccountEvent(e.type, e.payload as Record<string, unknown>),
    log,
  });
  consumer.start();
  const port = envInt('PORT', 7005);
  const server = await listen(app, port);
  log.info('listening', { port });
  return [{ stop: () => db.close() }, relay, consumer, server];
});
