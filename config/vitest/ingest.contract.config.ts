import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/unit/etl/ndjson.test.ts',
      'test/unit/etl/index-to-vespa.test.ts',
      'test/unit/etl/validate-silver.test.ts',
      'test/unit/etl/indexable-record.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
