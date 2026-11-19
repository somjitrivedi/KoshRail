import { join } from 'node:path';
import { BANK_CODES, TOPICS } from '@kosh/contracts';
import {
  Consumer,
  createLogger,
  dataDir,
  type Db,
  envInt,
  envList,
  HttpBus,
  internalToken,
  listen,
  Loop,
  migrationsDir,
  openDb,
  OutboxRelay,
  runMain,
  serviceUrl,
  systemClock,
} from '@kosh/service-kit';
import { buildLedgerApp, httpAccountDirectory } from './app.ts';

const log = createLogger('ledger-service');

runMain('ledger-service', log, async () => {
  const banks = envList('LEDGER_BANKS', [...BANK_CODES]);
  const dbs = new Map<string, Db>();
  for (const code of banks) dbs.set(code, openDb(join(dataDir(), `ledger-${code}.db`), migrationsDir(import.meta.url)));
  const token = internalToken();
  const { app, ledgers } = buildLedgerApp({ dbs, clock: systemClock, log, internalToken: token, accounts: httpAccountDirectory(serviceUrl('account'), token) });

  const bus = new HttpBus(serviceUrl('eventBus'), token, 'ledger-service');
  const relays = [...dbs].map(([code, db]) => new OutboxRelay(db, bus, `ledger-service.${code}`, log));
  for (const r of relays) r.start();

  const consumer = new Consumer({
    bus,
    group: 'ledger-service',
    topics: [TOPICS.account],
    resolveDb: (e) => dbs.get(String((e.payload as { bankCode?: string }).bankCode)) ?? null,
    handle: (e) => ledgers.get(String((e.payload as { bankCode: string }).bankCode))?.applyAccountEvent(e.type, e.payload as Record<string, unknown>),
    log,
  });
  consumer.start();

  const sweeper = new Loop(
    'hold-expiry',
    envInt('HOLD_SWEEP_MS', 5000),
    () => {
      for (const l of ledgers.values()) {
        const n = l.expireHolds();
        if (n > 0) log.info('expired holds', { bank: l.bankCode, count: n });
      }
    },
    log,
  );
  sweeper.start();

  const port = envInt('PORT', 7003);
  const server = await listen(app, port);
  log.info('listening', { port, banks });
  return [{ stop: () => dbs.forEach((d) => d.close()) }, ...relays, consumer, sweeper, server];
});
