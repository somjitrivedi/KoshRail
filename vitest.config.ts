import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30000,
    env: { LOG_LEVEL: 'silent' },
  },
});
