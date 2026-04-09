import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { vitestMemorySchedulerOptions } from './parallelism.js';

const evalTestInclude = [
  'test/unit/eval/offline-eval-reporting.test.ts',
  'test/unit/eval/noisy-entity-eval.test.ts',
] as const;

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
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
