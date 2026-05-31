/**
 * Vitest config for the wine-search e2e lane. ADDITIVE — does not modify
 * any existing config. Runs the curated set of canonical `/v1/agent`
 * in-memory e2e suites against the full Plan-then-Execute pipeline via
 * Fastify `inject()`. No network, no DB, no Redis — hermetic by construction.
 */

import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxForks, vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'test/e2e/wine-search-api.test.ts',
      'test/e2e/wine-search-api-hell-http.test.ts',
      'test/e2e/wine-search-api-hell-adversarial.test.ts',
      'test/e2e/wine-search-api-hell-combo.test.ts',
      'test/e2e/wine-search-api-hell-perf.test.ts',
      'test/e2e/wine-search-api-hell-concurrency.test.ts',
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
