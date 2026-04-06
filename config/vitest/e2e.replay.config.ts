import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/search-replay-fixtures.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
