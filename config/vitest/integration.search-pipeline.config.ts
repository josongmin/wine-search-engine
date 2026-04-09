import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';
import { vitestMemorySchedulerOptions } from './parallelism.js';

export default defineConfig({
  test: {
    ...vitestMemorySchedulerOptions(),
    globals: true,
    include: ['test/integration/search-pipeline.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
