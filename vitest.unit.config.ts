import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    exclude: [
      'test/unit/application/replay-usecase.test.ts',
      'test/unit/infrastructure/http-learned-matcher.test.ts',
      'test/unit/resolver/resolver-learned-matcher-context.test.ts',
    ],
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
