import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/e2e/vespa/search-correctness.test.ts',
      'test/e2e/vespa/search-quality.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      VESPA_URL: 'http://localhost:18080',
      TEST_MODE: 'vespa',
    },
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
