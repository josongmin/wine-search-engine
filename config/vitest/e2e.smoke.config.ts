import { defineConfig } from 'vitest/config';
import os from 'node:os';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/e2e/search-api.test.ts',
      'test/e2e/search-replay-fixtures.test.ts',
      'test/e2e/schema-contract.test.ts',
      'test/e2e/batch-search-api.test.ts',
      'test/e2e/server-protocol.test.ts',
      'test/e2e/openapi-feedback-api.test.ts',
      'test/e2e/v2-routes.contract.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: (() => {
          const parsed = Number.parseInt(process.env.VITEST_MAX_FORKS ?? '6', 10);
          const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
          const cpus = Math.max(2, os.availableParallelism?.() ?? os.cpus().length);
          return Math.min(cap, cpus);
        })(),
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
