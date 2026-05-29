import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxForks, vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'test/e2e/search-api.search.test.ts',
      'test/e2e/search-api.ops.test.ts',
      'test/e2e/schema-contract.test.ts',
      'test/e2e/server-protocol.test.ts',
      'test/e2e/openapi-feedback-api.test.ts',
      'test/e2e/cli-process.test.ts',
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
