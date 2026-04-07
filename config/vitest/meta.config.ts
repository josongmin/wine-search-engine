import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

const metaTestInclude = [
  'test/unit/replay-fixtures/replay-fixture-lane-truth.test.ts',
  'test/unit/replay-fixtures/replay-fixtures-workflow-parity.test.ts',
  'test/unit/replay-fixtures/run-search-replay.test.ts',
  'test/unit/interface/http/http-route-catalog-openapi-parity.test.ts',
] as const;

export default defineConfig({
  test: {
    globals: true,
    include: [...metaTestInclude],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
