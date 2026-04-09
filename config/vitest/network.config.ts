import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxThreads, vitestMemorySchedulerOptions } from './parallelism.js';

const maxNetworkThreads = resolveMaxThreads(1);

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: ['test/unit/infrastructure/http-adapters.network.test.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxNetworkThreads,
        minThreads: 1,
        useAtomics: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
