import { defineConfig } from 'vitest/config';
import path from 'node:path';
import os from 'node:os';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['test/e2e/vespa/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Parallel test files; each suite uses its own Fastify inject server.
    // maxForks caps memory on large CI runners; override with VITEST_MAX_FORKS if needed.
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: (() => {
          const parsed = Number.parseInt(process.env.VITEST_MAX_FORKS ?? '8', 10);
          const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
          const cpus = Math.max(2, os.availableParallelism?.() ?? os.cpus().length);
          return Math.min(cap, cpus);
        })(),
      },
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
