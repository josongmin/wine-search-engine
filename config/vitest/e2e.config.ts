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
      'test/e2e/server-protocol.test.ts',
      'test/e2e/infrastructure.invariants.test.ts',
      'test/e2e/infrastructure.contracts.test.ts',
      'test/e2e/mixed-search.test.ts',
      'test/e2e/response-invariants.test.ts',
      'test/e2e/schema-contract.test.ts',
      'test/e2e/realistic-scenarios.test.ts',
      'test/e2e/core-korean-iconic-entities.test.ts',
      'test/e2e/core-korean-iconic-ambiguity.test.ts',
      'test/e2e/core-korean-iconic-release-gate.test.ts',
      'test/e2e/offline-smoke-release-gate.test.ts',
      'test/e2e/edge-cases.input.test.ts',
      'test/e2e/edge-cases.protocol.test.ts',
      'test/e2e/hard-scenarios.test.ts',
      'test/e2e/query-family-release-gate.test.ts',
      'test/e2e/golden-set.test.ts',
      'test/e2e/wine-search-api.test.ts',
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
