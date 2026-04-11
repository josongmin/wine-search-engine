import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxThreads, vitestMemorySchedulerOptions } from './parallelism.js';

const maxIntegrationThreads = resolveMaxThreads(1);

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'test/integration/**/*.test.ts',
      'src/__tests__/integration/**/*.integration.test.ts',
      'src/infrastructure/fixture/__tests__/schema-parity.test.ts',
    ],
    exclude: ['test/integration/search-pipeline.test.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxIntegrationThreads,
        minThreads: 1,
        useAtomics: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
