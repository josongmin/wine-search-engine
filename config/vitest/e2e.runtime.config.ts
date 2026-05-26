import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxForks, vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'test/e2e/user-journeys.test.ts',
      'test/e2e/golden-set.test.ts',
      'test/e2e/query-family-release-gate.test.ts',
      'test/e2e/specialized-modes-quality.test.ts',
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
