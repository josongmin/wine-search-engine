import { defineConfig } from 'vitest/config';
import os from 'node:os';
import { vitestResolveAliases } from './aliases.js';

const maxIntegrationThreads = (() => {
  const parsed = Number.parseInt(process.env.VITEST_MAX_THREADS ?? '6', 10);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.min(cap, Math.max(2, cpus));
})();

export default defineConfig({
  test: {
    globals: true,
    include: ['test/integration/**/*.test.ts'],
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
