import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/benchmark/agent/__tests__/**/*.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 1,
        minThreads: 1,
        useAtomics: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
