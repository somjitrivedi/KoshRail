import { createLogger, envInt, internalToken, listen, Loop, runMain, serviceUrl } from '@kosh/service-kit';
import { buildGateway, type RouteDef } from './app.ts';
import { JwksCache } from './jwks.ts';

const log = createLogger('api-gateway');

export function defaultRoutes(): RouteDef[] {
  return [
    {
      prefix: '/api/identity',
      upstream: serviceUrl('identity'),
      publicEndpoints: ['POST /otp/request', 'POST /register', 'POST /login', 'POST /token/refresh', 'POST /logout', 'POST /staff/login'],
    },
    { prefix: '/api/accounts', upstream: serviceUrl('account') },
    { prefix: '/api/ledger', upstream: serviceUrl('ledger'), kinds: ['staff'] },
    { prefix: '/api/adapter', upstream: serviceUrl('adapter'), kinds: ['staff'] },
    { prefix: '/api/vpa', upstream: serviceUrl('vpa') },
    { prefix: '/api/switch', upstream: serviceUrl('switch') },
  ];
}

runMain('api-gateway', log, async () => {
  const jwks = new JwksCache(`${serviceUrl('identity')}/.well-known/jwks.json`, log);
  await jwks.refresh(true);
  const refresher = new Loop('jwks-refresh', jwks.loaded ? 60000 : 1000, () => jwks.refresh(true), log);
  refresher.start();
  const app = buildGateway({
    routes: defaultRoutes(),
    jwks,
    internalToken: internalToken(),
    log,
    customerLimit: { burst: envInt('RL_CUSTOMER_BURST', 20), ratePerSecond: envInt('RL_CUSTOMER_RPS', 10) },
    anonLimit: { burst: envInt('RL_ANON_BURST', 30), ratePerSecond: envInt('RL_ANON_RPS', 10) },
  });
  const port = envInt('PORT', 8080);
  const server = await listen(app, port);
  log.info('listening', { port });
  return [refresher, server];
});
