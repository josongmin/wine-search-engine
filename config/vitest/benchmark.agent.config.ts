import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    // Restrict to *.test.ts so shared fixture modules under __helpers__/ are
    // not picked up as empty test suites (caused 1 spurious failed-suite after
    // scorer.test.ts was split into per-dim files in the 2026-05-26 round B).
    include: ['test/benchmark/agent/__tests__/**/*.test.ts'],
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
