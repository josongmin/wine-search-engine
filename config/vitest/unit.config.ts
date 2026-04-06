import { defineConfig } from 'vitest/config';
import os from 'node:os';
import { vitestResolveAliases } from './aliases.js';

const isCoverageRun = process.argv.includes('--coverage') || process.env.VITEST_COVERAGE === '1';

const maxUnitThreads = (() => {
  const parsed = Number.parseInt(process.env.VITEST_MAX_THREADS ?? '8', 10);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.min(cap, Math.max(2, cpus));
})();

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

export default defineConfig({
  test: {
    globals: true,
    include: [...testInclude],
    exclude: [
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
