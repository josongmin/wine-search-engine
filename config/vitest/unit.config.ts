import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxThreads, vitestMemorySchedulerOptions } from './parallelism.js';

const isCoverageRun = process.argv.includes('--coverage') || process.env.VITEST_COVERAGE === '1';

const maxUnitThreads = resolveMaxThreads(1);

const testInclude = [
  'test/unit/**/*.test.ts',
  'test/helpers/**/*.test.ts',
  'src/application/**/__tests__/**/*.test.ts',
  'src/config/**/__tests__/**/*.test.ts',
  'src/domain/**/__tests__/**/*.test.ts',
  'src/infrastructure/**/__tests__/**/*.test.ts',
  'src/observability/**/__tests__/**/*.test.ts',
  'src/interface/**/__tests__/**/*.test.ts',
  'src/__tests__/**/*.test.ts',
] as const;

const heavyTestExclude = [
  'src/__tests__/integration/cache-service*.integration.test.ts',
] as const;

const watchlistTestExclude = [
  'src/__tests__/container-watchlist.test.ts',
  'src/__tests__/watchlist-routes.test.ts',
  'src/__tests__/watchlist-integration.test.ts',
  'src/__tests__/watchlist-delivery-runtime.test.ts',
  'src/__tests__/watchlist-policy.test.ts',
  'src/__tests__/watchlist-aware-search-index.test.ts',
  'src/__tests__/pg-watchlist-store.test.ts',
  'src/config/__tests__/readiness.test.ts',
  'src/__tests__/redis-watchlist-publisher.test.ts',
  'src/__tests__/webhook-delivery.test.ts',
] as const;

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [...testInclude],
    exclude: [
      ...heavyTestExclude,
      ...watchlistTestExclude,
      'test/unit/infrastructure/http-adapters.network.test.ts',
      'src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts',
      'src/interface/http/routes/__tests__/http-contract-openapi-bridge.test.ts',
    ],
    pool: isCoverageRun ? 'forks' : 'threads',
    poolOptions: isCoverageRun
      ? {
        forks: {
          singleFork: true,
        },
      }
      : {
        threads: {
          maxThreads: maxUnitThreads,
          minThreads: 1,
          useAtomics: true,
        },
      },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__tests__/**', 'src/main.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 60,
        lines: 60,
        branches: 80,
        functions: 79,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
