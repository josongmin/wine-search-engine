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
      getByIdForUser: vi.fn(),
      listByUserId: vi.fn(),
      listByEntityId: vi.fn(),
      deleteForUser: vi.fn(),
      listDeliveries: vi.fn(),
      recordDeliveryLog: vi.fn(),
    },
    evalRunner: null,
    feedbackStore: null,
    feedbackIngestEnabled: false,
  };
}

describe('HTTP server route registration', () => {
  it('registers POST /v1/feedback (returns 503 when feedback ingest is disabled)', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });
    try {
      const routes = app.printRoutes();
      expect(routes).toContain('feedback (POST)');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/feedback',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'Opus One',
          entity_id: 'wine-opus-one',
          signal_type: 'click',
          session_id: 'sess-1',
        }),
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { error?: { code?: string } };
      expect(body.error?.code).toBe('FEEDBACK_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });

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
            required: false,
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
            required: false,
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
          postgres: { status: 'skipped', required: true },
          redis: { status: 'down', required: false },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('marks required readiness checks down when the probe throws', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      health: {
        readiness: {
          vespa: {
            required: true,
            check: async () => {
              throw new Error('vespa unavailable');
            },
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
          vespa: { status: 'down', required: true },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('does not block startup when background eval runner fails during onReady', async () => {
    const evalRunner = {
      run: vi.fn(async () => {
        throw new Error('eval backend unavailable');
      }),
    };
    const app = await createServer(
      {
        ...createHttpServerDeps(),
        evalRunner,
      },
      {
        logLevel: 'silent',
        nodeEnv: 'test',
        runEvalAtStartup: true,
      },
    );

    try {
      await expect(app.ready()).resolves.toBe(app);
      expect(evalRunner.run).toHaveBeenCalledTimes(1);

      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('includes dynamically registered readiness checks in the response body', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      health: {
        readiness: {
          vespa: {
            required: true,
            check: async () => 'up',
          },
          reranker: {
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
          postgres: { status: 'skipped', required: true },
          redis: { status: 'skipped', required: true },
          vespa: { status: 'up', required: true },
          reranker: { status: 'down', required: false },
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

  it('blocks /metrics/agent when debug secret is not configured', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: '/metrics/agent',
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error?.code).toBe('FORBIDDEN');
    } finally {
      await app.close();
    }
  });

  it('protects /metrics/agent with X-Debug-Key when debug secret is configured', async () => {
    const debugSecret = 'metrics-debug-secret';
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      httpDebugSecret: debugSecret,
    });

    try {
      await app.ready();
      const forbidden = await app.inject({
        method: 'GET',
        url: '/metrics/agent',
      });
      expect(forbidden.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'GET',
        url: '/metrics/agent',
        headers: { 'x-debug-key': debugSecret },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({
        timestamp: expect.any(String),
        agent: {
          runs: expect.any(Number),
          by_termination_reason: expect.any(Object),
          fallback_runs: expect.any(Number),
          fallback_rate: expect.any(Number),
          fallback_by_layer: expect.any(Object),
          reasoning_failure_runs: expect.any(Number),
          total_tool_calls: expect.any(Number),
          avg_duration_ms: expect.any(Number),
          tool_outcome_kinds: expect.any(Object),
          failed_outcome_kinds: expect.any(Object),
          timeouts: {
            llm_step: expect.any(Number),
            tool: expect.any(Number),
            parallel_batch: expect.any(Number),
            event_rate_per_run: expect.any(Number),
          },
          alerts: expect.any(Array),
        },
      });
    } finally {
      await app.close();
    }
  });

  it('refuses startup when eval-on-startup is enabled in production', async () => {
    await expect(createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'production',
      runEvalAtStartup: true,
    })).rejects.toThrow(/EVAL_RUN_AT_STARTUP=true is not permitted in production/);
  });

  it('echoes a valid inbound X-Request-Id on the response', async () => {
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
          'x-request-id': 'gateway-trace-abc',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toBe('gateway-trace-abc');
    } finally {
      await app.close();
    }
  });
});

describe('HTTP debug mode (X-Debug-Key)', () => {
  const debugSecret = 'integration-test-debug-key';

  it('does not set X-Debug-Active when secret is not configured', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-debug-key': debugSecret },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-debug-active']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('does not set X-Debug-Active when X-Debug-Key is wrong', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      httpDebugSecret: debugSecret,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-debug-key': 'wrong-key-not-matching' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-debug-active']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('sets X-Debug-Active when X-Debug-Key matches HTTP_DEBUG_SECRET', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      httpDebugSecret: debugSecret,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-debug-key': debugSecret },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-debug-active']).toBe('1');
    } finally {
      await app.close();
    }
  });

  it('returns benchmark quick scenarios when enableAgentBenchmarkUi is true', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      enableAgentBenchmarkUi: true,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/agent/benchmark-scenarios' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { scenarios: Array<{ id: number; profile: string }> };
      expect(body.scenarios).toHaveLength(20);
      expect(body.scenarios[0]?.profile).toBe('quick');
    } finally {
      await app.close();
    }
  });

  it('returns 404 for benchmark scenarios when enableAgentBenchmarkUi is false', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
      enableAgentBenchmarkUi: false,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/agent/benchmark-scenarios' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error?: { code?: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});
