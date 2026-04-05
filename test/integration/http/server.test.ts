import { describe, expect, it, vi } from 'vitest';
import type { HttpServerDeps } from '../../../src/interface/http/routes/route-deps.js';
import { createServer } from '../../../src/interface/http/server.js';

function createHttpServerDeps(): HttpServerDeps {
  return {
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
    watchlistService: {
      create: vi.fn(),
      getById: vi.fn(),
      listByEntityId: vi.fn(),
      delete: vi.fn(),
      listDeliveries: vi.fn(),
      recordDeliveryLog: vi.fn(),
      clear: vi.fn(),
    },
    evalRunner: null,
  };
}

describe('HTTP server route registration', () => {
  it('exposes the Claude tools endpoint through the server', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });
    try {
      const routes = app.printRoutes();
      expect(routes).toContain('claude-tools (POST, GET, HEAD)');
    } finally {
      await app.close();
    }
  });

  it('marks readiness failed when a required dependency check is down', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      health: {
        readiness: {
          postgres: {
            required: true,
            check: async () => 'down',
          },
          redis: {
            check: async () => 'down',
          },
        },
      },
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        ready: false,
        checks: {
          postgres: { status: 'down', required: true },
          redis: { status: 'down', required: false },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('keeps readiness green when only optional dependency checks are down', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      health: {
        readiness: {
          redis: {
            check: async () => 'down',
          },
        },
      },
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ready: true,
        checks: {
          postgres: { status: 'skipped', required: false },
          redis: { status: 'down', required: false },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('responds to health checks with default hooks enabled in test env', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:3000',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res.json()).toMatchObject({
        status: 'ok',
      });
    } finally {
      await app.close();
    }
  });
});
