import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

const evalTestInclude = [
  'test/unit/eval/offline-eval-reporting.test.ts',
  'test/unit/eval/noisy-entity-eval.test.ts',
] as const;

export default defineConfig({
  test: {
    globals: true,
    include: [...evalTestInclude],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
