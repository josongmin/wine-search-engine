import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxThreads } from './parallelism.js';

const maxDevThreads = resolveMaxThreads(1);

const devTestInclude = [
  'test/unit/**/*.test.ts',
  'test/helpers/**/*.test.ts',
  'src/application/**/__tests__/**/*.test.ts',
  'src/config/**/__tests__/**/*.test.ts',
  'src/domain/**/__tests__/**/*.test.ts',
  'src/infrastructure/**/__tests__/**/*.test.ts',
  'src/observability/**/__tests__/**/*.test.ts',
  'src/interface/**/__tests__/**/*.test.ts',
] as const;

export default defineConfig({
  test: {
    globals: true,
    include: [...devTestInclude],
    exclude: [
      'test/unit/eval/offline-eval-reporting.test.ts',
      'test/unit/eval/noisy-entity-eval.test.ts',
      'test/unit/replay-fixtures/replay-fixture-lane-truth.test.ts',
      'test/unit/replay-fixtures/replay-fixtures-workflow-parity.test.ts',
      'test/unit/replay-fixtures/run-search-replay.test.ts',
      'test/unit/interface/http/http-route-catalog-openapi-parity.test.ts',
      'test/unit/infrastructure/http-adapters.network.test.ts',
      'src/domain/response/__tests__/human-response-builder-v2.test.ts',
      'src/interface/http/schemas/__tests__/search-response-v2.schema.test.ts',
      'src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts',
      'src/interface/http/routes/__tests__/http-contract-openapi-bridge.test.ts',
    ],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxDevThreads,
        minThreads: 1,
        useAtomics: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
