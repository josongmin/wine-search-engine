import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/integration/http/middleware/error-handler.policy-blocked.test.ts',
      'test/integration/http/routes/policy-blocked.helper.test.ts',
      'test/integration/http/routes/public-query-contracts.test.ts',
      'test/integration/http/routes/public-query-security.route.test.ts',
      'test/integration/http/routes/resolve.route.test.ts',
      'test/integration/http/routes/route-contract-registry.test.ts',
      'test/integration/http/schemas/interpret-response.schema.test.ts',
      'test/integration/http/server.test.ts',
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
