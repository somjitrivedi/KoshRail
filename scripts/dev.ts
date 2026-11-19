import { resolve } from 'node:path';
import { ROOT, startStack } from './stack.ts';

const dataDir = resolve(ROOT, process.env.KOSH_DATA_DIR ?? 'data');

const stack = await startStack({ dataDir, logMode: 'inherit', extraEnv: { OTP_DEV_ECHO: 'true' } });
process.stdout.write(`\nKoshRail is up. Gateway: ${stack.urls.KOSH_GATEWAY_URL}\n`);
for (const s of stack.services) process.stdout.write(`  ${s.def.name.padEnd(18)} ${s.url}\n`);
process.stdout.write('\nPress Ctrl+C to stop.\n');

const shutdown = async () => {
  await stack.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
