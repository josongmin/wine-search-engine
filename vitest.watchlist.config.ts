import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/__tests__/container-watchlist.test.ts',
      'src/__tests__/watchlist-routes.test.ts',
      'src/__tests__/watchlist-integration.test.ts',
      'src/__tests__/watchlist-delivery-runtime.test.ts',
      'src/__tests__/watchlist-policy.test.ts',
      'src/__tests__/watchlist-aware-search-index.test.ts',
      'src/__tests__/pg-watchlist-store.test.ts',
      'src/__tests__/readiness.test.ts',
      'src/__tests__/redis-watchlist-publisher.test.ts',
      'src/__tests__/webhook-delivery.test.ts',
      'src/interface/http/routes/__tests__/register-contract-route.test.ts',
      'test/integration/http/routes/http-contract-manifest-script.test.ts',
      'test/integration/http/server.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/domain/shared'),
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@app': path.resolve(__dirname, 'src/application'),
      '@infra': path.resolve(__dirname, 'src/infrastructure'),
      '@interface': path.resolve(__dirname, 'src/interface'),
      '@config': path.resolve(__dirname, 'src/config'),
    },
  },
});
