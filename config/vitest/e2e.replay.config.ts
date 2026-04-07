import { defineConfig } from 'vitest/config';
import { resolveMaxForks } from './parallelism.js';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/search-replay*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        maxForks: resolveMaxForks(1),
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
