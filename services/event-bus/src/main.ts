import { join } from 'node:path';
import { createLogger, dataDir, envInt, internalToken, listen, migrationsDir, openDb, runMain } from '@kosh/service-kit';
import { buildBusApp } from './app.ts';

const log = createLogger('event-bus');

runMain('event-bus', log, async () => {
  const db = openDb(join(dataDir(), 'event-bus.db'), migrationsDir(import.meta.url));
  const port = envInt('PORT', 7000);
  const server = await listen(buildBusApp({ db, log, internalToken: internalToken() }), port);
  log.info('listening', { port });
  return [{ stop: () => db.close() }, server];
});
