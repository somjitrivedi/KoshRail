import { join } from 'node:path';
import {
  createLogger,
  dataDir,
  env,
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
import { buildIdentity } from './app.ts';

const log = createLogger('identity-service');

runMain('identity-service', log, async () => {
  const db = openDb(join(dataDir(), 'identity.db'), migrationsDir(import.meta.url));
  const token = internalToken();
  const { app } = buildIdentity({
    db,
    clock: systemClock,
    log,
    internalToken: token,
    adminPassword: env('ADMIN_PASSWORD', 'Admin@12345'),
    config: {
      otpDevEcho: envBool('OTP_DEV_ECHO', false),
      accessTtlSeconds: envInt('ACCESS_TTL_SECONDS', 900),
    },
  });
  const relay = new OutboxRelay(db, new HttpBus(serviceUrl('eventBus'), token, 'identity-service'), 'identity-service', log);
  relay.start();
  const port = envInt('PORT', 7001);
  const server = await listen(app, port);
  log.info('listening', { port });
  return [{ stop: () => db.close() }, relay, server];
});
