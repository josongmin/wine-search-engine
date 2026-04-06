import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/vespa/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      VESPA_URL: 'http://localhost:18080',
      TEST_MODE: 'vespa',
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
