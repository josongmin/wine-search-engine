import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: ['test/e2e/vespa/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      TEST_MODE: 'vespa',
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
