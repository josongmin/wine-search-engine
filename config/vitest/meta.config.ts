import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { vitestMemorySchedulerOptions } from './parallelism.js';

const metaTestInclude = [
  'test/unit/replay-fixtures/replay-fixture-lane-truth.test.ts',
  'test/unit/replay-fixtures/replay-fixtures-workflow-parity.test.ts',
  'test/unit/replay-fixtures/run-search-replay.test.ts',
  'test/unit/interface/http/http-route-catalog-openapi-parity.test.ts',
  'src/domain/response/__tests__/human-response-builder-v2.test.ts',
  'src/interface/http/schemas/__tests__/search-response-v2.schema.test.ts',
  'src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts',
  'src/interface/http/routes/__tests__/http-contract-openapi-bridge.test.ts',
  // E5-T12: SSoT gate — verifies SOFT_CONSTRAINT_ATTRIBUTES has exactly one definition
  'test/meta/constraint-attributes-ssot.test.ts',
] as const;

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
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
