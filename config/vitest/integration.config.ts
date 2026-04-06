import { defineConfig } from 'vitest/config';
import os from 'node:os';
import { vitestResolveAliases } from './aliases.js';

const maxIntegrationThreads = (() => {
  const parsed = Number.parseInt(process.env.VITEST_MAX_THREADS ?? '6', 10);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.min(cap, Math.max(2, cpus));
})();

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
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxIntegrationThreads,
        minThreads: 1,
        useAtomics: true,
      },
    },
  },
  resolve: {
    alias: vitestResolveAliases(),
  },
});
