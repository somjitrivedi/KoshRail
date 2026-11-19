import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './stack.ts';

const dataDir = resolve(ROOT, process.env.KOSH_DATA_DIR ?? 'data');
rmSync(dataDir, { recursive: true, force: true });
process.stdout.write(`removed ${dataDir}\n`);
