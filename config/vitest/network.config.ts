import { defineConfig } from 'vitest/config';
import { vitestResolveAliases } from './aliases.js';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/infrastructure/http-adapters.network.test.ts'],
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
