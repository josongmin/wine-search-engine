import { defineConfig } from 'vitest/config';
import os from 'node:os';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/e2e/user-journeys.test.ts',
      'test/e2e/golden-set.test.ts',
      'test/e2e/specialized-modes-quality.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: (() => {
          const parsed = Number.parseInt(process.env.VITEST_MAX_FORKS ?? '4', 10);
          const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
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
