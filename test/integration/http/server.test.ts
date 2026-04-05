import { describe, expect, it, vi } from 'vitest';
import type { HttpServerDeps } from '../../../src/interface/http/routes/route-deps.js';
import { createServer } from '../../../src/interface/http/server.js';

describe('HTTP server route registration', () => {
  it('exposes the Claude tools endpoint through the server', async () => {
    const deps: HttpServerDeps = {
      searchUseCase: {
        execute: vi.fn(),
      },
      decomposedSearchUseCase: {
        execute: vi.fn(),
      },
      batchSearchUseCase: {
        execute: vi.fn(),
      },
      replayUseCase: {
        execute: vi.fn(),
      },
      interpretUseCase: {
        execute: vi.fn(),
      },
      resolveUseCase: {
        execute: vi.fn(),
      },
      hybridUseCase: {
        execute: vi.fn(),
      },
      adaptiveToolExecutor: {
        executeWithFallback: vi.fn(),
      },
      evalRunner: null,
    };

    const app = await createServer(deps, { logLevel: 'silent' });
    try {
      const routes = app.printRoutes();
      expect(routes).toContain('claude-tools (POST, GET, HEAD)');
    } finally {
      await app.close();
    }
  });
});
