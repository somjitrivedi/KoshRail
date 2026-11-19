import { join } from 'node:path';
import { BANK_CODES } from '@kosh/contracts';
import { createLogger, dataDir, envInt, envList, internalToken, listen, migrationsDir, openDb, runMain, serviceUrl, systemClock } from '@kosh/service-kit';
import { buildAdapter, httpGlDirectory, httpLedgerApi } from './app.ts';

const log = createLogger('bank-adapter');

runMain('bank-adapter', log, async () => {
  const db = openDb(join(dataDir(), 'adapter.db'), migrationsDir(import.meta.url));
  const token = internalToken();
  const { app } = buildAdapter({
    db,
    clock: systemClock,
    log,
    internalToken: token,
    banks: envList('ADAPTER_BANKS', [...BANK_CODES]),
    ledger: httpLedgerApi(serviceUrl('ledger'), token),
    gl: httpGlDirectory(serviceUrl('account'), token),
    faultHangMs: envInt('ADAPTER_FAULT_HANG_MS', 30000),
  });
  const port = envInt('PORT', 7004);
  const server = await listen(app, port);
  log.info('listening', { port });
  return [{ stop: () => db.close() }, server];
});
