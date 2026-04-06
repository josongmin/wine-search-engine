import { defineConfig } from 'vitest/config';
import os from 'node:os';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['test/e2e/vespa/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: (() => {
          const parsed = Number.parseInt(process.env.VITEST_MAX_FORKS ?? '8', 10);
          const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
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
