import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/e2e/golden-set.test.ts',
      'test/e2e/user-journeys.test.ts',
      'test/integration/decision-utility.test.ts',
      'test/integration/learning-flywheel.test.ts',
      'test/unit/eval/entity-type.test.ts',
      'test/unit/eval/noisy-entity-eval.test.ts',
      'test/unit/evaluation/selective-predictor.test.ts',
      'test/unit/evaluation/utility-scorer.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
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
