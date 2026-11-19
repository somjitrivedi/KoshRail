import { join } from 'node:path';
import {
  createLogger,
  dataDir,
  envBool,
  envInt,
  HttpBus,
  internalToken,
  listen,
  Loop,
  migrationsDir,
  newId,
  openDb,
  OutboxRelay,
  runMain,
  serviceUrl,
  sleep,
  systemClock,
} from '@kosh/service-kit';
import { buildSwitch, ChaosControl, httpIdentityPort, httpVpaPort } from './app.ts';
import { httpBankPort } from './banks.ts';
import { configFromEnv } from './config.ts';

const log = createLogger('switch-service');

runMain('switch-service', log, async () => {
  const db = openDb(join(dataDir(), 'switch.db'), migrationsDir(import.meta.url));
  const token = internalToken();
  const config = configFromEnv();
  const owner = newId(`switch_${process.pid}`);
  const chaos = envBool('SWITCH_CHAOS', false)
    ? new ChaosControl(log, () => {
        process.exit(137);
      })
    : undefined;
  const { app, recovery } = buildSwitch({
    db,
    clock: systemClock,
    log,
    internalToken: token,
    config,
    owner,
    banks: httpBankPort(serviceUrl('adapter'), token),
    identity: httpIdentityPort(serviceUrl('identity'), token),
    vpa: httpVpaPort(serviceUrl('vpa'), token),
    sleep,
    random: Math.random,
    chaos,
  });
  const bus = new HttpBus(serviceUrl('eventBus'), token, 'switch-service');
  const relay = new OutboxRelay(db, bus, 'switch-service', log);
  relay.start();
  const recoveryLoop = new Loop('saga-recovery', config.recoveryIntervalMs, () => recovery.tick(), log);
  recoveryLoop.start();
  const port = envInt('PORT', 7006);
  const server = await listen(app, port);
  log.info('listening', { port, owner, chaos: Boolean(chaos) });
  return [{ stop: () => db.close() }, relay, { stop: () => recovery.idle() }, recoveryLoop, server];
});
