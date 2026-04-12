import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'test/unit/etl/ndjson.test.ts',
      'test/unit/etl/index-to-vespa.test.ts',
      'test/unit/etl/validate-silver.test.ts',
      'test/unit/etl/indexable-record.test.ts',
      'test/unit/etl/etl-utils.test.ts',
      'test/unit/etl/vivino-to-silver.test.ts',
      'test/unit/etl/generate-aliases.test.ts',
      'test/unit/etl/snapshot-entity-identity.test.ts',
      'test/unit/etl/build-search-snapshot.test.ts',
      'test/unit/etl/build-alias-artifact.test.ts',
      'test/unit/etl/canonical-entity-graph-sync.test.ts',
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
