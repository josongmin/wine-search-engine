import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxForks } from './parallelism.js';

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
        singleFork: true,
        maxForks: resolveMaxForks(),
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
