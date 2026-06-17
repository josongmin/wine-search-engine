import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { vitestMemorySchedulerOptions } from './parallelism.js';

const metaTestInclude = [
  'test/unit/replay-fixtures/replay-fixture-lane-truth.test.ts',
  'test/unit/replay-fixtures/replay-fixtures-workflow-parity.test.ts',
  'test/unit/replay-fixtures/run-search-replay.test.ts',
  'src/domain/response/__tests__/human-response-builder-v2.test.ts',
  'src/interface/http/schemas/__tests__/search-response-v2.schema.test.ts',
  'src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts',
  // E5-T12: SSoT gate — verifies SOFT_CONSTRAINT_ATTRIBUTES has exactly one definition
  'test/meta/constraint-attributes-ssot.test.ts',
  'test/meta/vespa-hit-summary-readraw-parity.test.ts',
  // Entity Lookup V2 cutover gate — per-class no-regression + eval_cases fingerprint pin
  'test/unit/entity-lookup-v2/cutover-gate.test.ts',
  'test/meta/lookup-v2-cutover-gate.meta.test.ts',
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
