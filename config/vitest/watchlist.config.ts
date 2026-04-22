import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxThreads, vitestMemorySchedulerOptions } from './parallelism.js';

const maxWatchlistThreads = resolveMaxThreads(1);

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [
      'src/__tests__/container-watchlist.test.ts',
      'src/__tests__/watchlist-routes.test.ts',
      'src/__tests__/watchlist-integration.test.ts',
      'src/__tests__/watchlist-delivery-runtime.test.ts',
      'src/__tests__/watchlist-policy.test.ts',
      'src/__tests__/watchlist-aware-search-index.test.ts',
      'src/__tests__/pg-watchlist-store.test.ts',
      'src/__tests__/redis-watchlist-publisher.test.ts',
      'src/__tests__/webhook-delivery.test.ts',
    ],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxWatchlistThreads,
        minThreads: 1,
        useAtomics: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
