import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/vespa/search-smoke.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Do not set VESPA_URL here — it would override the host/shell and hide dev Vespa (8080).
    // run-vespa-test-lane.sh exports VESPA_URL=http://localhost:18080; for local dev use .env or export.
    env: {
      TEST_MODE: 'vespa',
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
