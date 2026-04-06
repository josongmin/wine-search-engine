import { defineConfig } from 'vitest/config';
import path from 'node:path';

const testInclude = [
  'test/unit/**/*.test.ts',
  'src/application/**/__tests__/**/*.test.ts',
  'src/config/**/__tests__/**/*.test.ts',
  'src/domain/**/__tests__/**/*.test.ts',
  'src/infrastructure/**/__tests__/**/*.test.ts',
  'src/interface/**/__tests__/**/*.test.ts',
  'src/__tests__/**/*.test.ts',
] as const;

export default defineConfig({
  test: {
    globals: true,
    include: [...testInclude],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        'src/main.ts',
      ],
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
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
