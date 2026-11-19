import { join } from 'node:path';
import {
  createLogger,
  dataDir,
  envBool,
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
import { buildAccounts, httpLedgerPort, httpUserDirectory } from './app.ts';

const log = createLogger('account-service');

runMain('account-service', log, async () => {
  const db = openDb(join(dataDir(), 'account.db'), migrationsDir(import.meta.url));
  const token = internalToken();
  const { app } = buildAccounts({
    db,
    clock: systemClock,
    log,
    internalToken: token,
    users: httpUserDirectory(serviceUrl('identity'), token),
    ledger: envBool('LEDGER_SYNC', true) ? httpLedgerPort(serviceUrl('ledger'), token) : null,
  });
  const relay = new OutboxRelay(db, new HttpBus(serviceUrl('eventBus'), token, 'account-service'), 'account-service', log);
  relay.start();
  const port = envInt('PORT', 7002);
  const server = await listen(app, port);
  log.info('listening', { port });
  return [{ stop: () => db.close() }, relay, server];
});
