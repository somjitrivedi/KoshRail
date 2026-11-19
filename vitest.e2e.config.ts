import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    globalSetup: ['tests/e2e/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
