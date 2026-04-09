import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxForks, vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'test/e2e/search-api.search.test.ts',
      'test/e2e/search-api.secondary.test.ts',
      'test/e2e/search-api.ops.test.ts',
      'test/e2e/watchlist-api.test.ts',
      'test/e2e/server-protocol.test.ts',
      'test/e2e/infrastructure.invariants.test.ts',
      'test/e2e/infrastructure.contracts.test.ts',
      'test/e2e/mixed-search.test.ts',
      'test/e2e/claude-tools-api.test.ts',
      'test/e2e/openapi-feedback-api.test.ts',
      'test/e2e/batch-search-api.test.ts',
      'test/e2e/v2-routes.contract.test.ts',
      'test/e2e/response-invariants.test.ts',
      'test/e2e/realistic-scenarios.test.ts',
      'test/e2e/edge-cases.input.test.ts',
      'test/e2e/edge-cases.protocol.test.ts',
      'test/e2e/hard-scenarios.test.ts',
      'test/e2e/agent-api.test.ts',
      'test/e2e/error-envelope.contract.test.ts',
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
