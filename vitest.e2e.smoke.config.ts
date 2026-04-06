import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/e2e/search-api.test.ts',
      'test/e2e/schema-contract.test.ts',
      'test/e2e/batch-search-api.test.ts',
      'test/e2e/server-protocol.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
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
