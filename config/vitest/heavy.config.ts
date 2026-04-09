import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { resolveMaxForks, vitestMemorySchedulerOptions } from './parallelism.js';

const heavyTestInclude = [
  'test/integration/search-pipeline.test.ts',
] as const;

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: [...heavyTestInclude],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        maxForks: resolveMaxForks(1),
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
