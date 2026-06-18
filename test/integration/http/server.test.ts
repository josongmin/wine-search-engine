import { describe, expect, it, vi } from 'vitest';
import type { HttpServerDeps } from '../../../src/interface/http/routes/route-deps.js';
import { createServer } from '../../../src/interface/http/server.js';

function createHttpServerDeps(): HttpServerDeps {
  return {
    searchUseCase: {
      execute: vi.fn(),
    },
    entityLookupV2UseCase: {
      execute: vi.fn(),
    },
    evalRunner: null,
  };
}

describe('HTTP server route registration', () => {
  it('does not register retired non-core HTTP surfaces', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });
    try {
      const routes = app.printRoutes();
      expect(routes).not.toContain('feedback (POST)');
      expect(routes).not.toContain('openapi.json (GET)');
      expect(routes).not.toContain('metrics/agent (GET)');
    } finally {
      await app.close();
    }
  });

  it('returns an RFC-014 envelope for unknown routes (not Fastify default 404)', async () => {
    const app = await createServer(createHttpServerDeps(), {
      logLevel: 'silent',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/this-route-does-not-exist' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as {
        error?: {
          request_id?: unknown;
          code?: unknown;
          message?: unknown;
          failure_reason?: unknown;
          retryable?: unknown;
        };
        statusCode?: unknown;
      };
      // RFC-014 envelope shape — NOT Fastify's default {statusCode,error,message}.
      expect(body.statusCode).toBeUndefined();
      expect(body.error?.code).toBe('NOT_FOUND');
      expect(typeof body.error?.request_id).toBe('string');
      expect(body.error?.request_id).not.toBe('');
      expect(typeof body.error?.message).toBe('string');
      expect(body.error?.failure_reason).toBeNull();
      expect(body.error?.retryable).toBe(false);
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
  const authorityTraceRef = 'decision:v1:debug_trace:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validDecisionSnapshot = {
    snapshot_id: 'snapshot:v1:default:1.0.0:1.0.0:abcdef',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: '1',
    feature_flags: {},
    response_contract_version: 'search_response_v1',
  } as const;

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

  it('forwards debugRequest=true into /v1/search/hybrid use case when X-Debug-Key matches', async () => {
    const deps = createHttpServerDeps();
    deps.searchUseCase.execute = vi.fn().mockResolvedValue({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.9,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: authorityTraceRef,
        authorityTraceRef,
        decisionSnapshot: validDecisionSnapshot,
      },
      results: [],
      clarification: null,
      meta: {
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
      },
    });
    const app = await createServer(deps, {
      logLevel: 'silent',
      nodeEnv: 'test',
      httpDebugSecret: debugSecret,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search/hybrid',
        headers: {
          'content-type': 'application/json',
          'x-debug-key': debugSecret,
        },
        payload: JSON.stringify({
          query: 'Opus One 2018',
        }),
      });

      expect(res.headers['x-debug-active']).toBe('1');
      expect(deps.searchUseCase.execute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.searchUseCase.execute).mock.calls[0]?.[2]).toMatchObject({
        debugRequest: true,
      });
    } finally {
      await app.close();
    }
  });

  it('serializes typed abstain reason and audit traces through /v1/search/hybrid contract', async () => {
    const deps = createHttpServerDeps();
    deps.searchUseCase.execute = vi.fn().mockResolvedValue({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'ambiguous',
        nextAction: 'clarify',
        route: 'hybrid',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: authorityTraceRef,
        authorityTraceRef,
        abstainReason: 'low_confidence',
        decisionSnapshot: validDecisionSnapshot,
      },
      results: [],
      clarification: null,
      meta: {
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        auditExtension: {
          planner_policy_trace: [
            {
              stage: 'constraint_resolution',
              inputFacts: { rawConstraintCount: 2 },
              rulesEvaluated: [],
              rejectedBranches: [],
              decision: 'emit_trace',
              confidence: 1,
            },
          ],
          constraint_resolution_trace: {
            atoms: [
              { key: 'sweetness:eq:dry', attribute: 'sweetness', operator: '=', value: 'dry' },
              { key: 'sweetness:eq:sweet', attribute: 'sweetness', operator: '=', value: 'sweet' },
            ],
            relations: [
              { from: 'sweetness:eq:dry', to: 'sweetness:eq:sweet', type: 'contradiction' },
            ],
            policy_outcomes: [
              { atomIndex: 1, outcome: 'dropped', reason: 'conflict' },
            ],
          },
        },
      },
    });
    const app = await createServer(deps, {
      logLevel: 'silent',
      nodeEnv: 'test',
      httpDebugSecret: debugSecret,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search/hybrid',
        headers: {
          'content-type': 'application/json',
          'x-debug-key': debugSecret,
        },
        payload: JSON.stringify({
          query: '달달한 드라이',
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-debug-active']).toBe('1');
      expect(res.json()).toMatchObject({
        engine_decision: {
          abstain_reason: 'low_confidence',
        },
        meta: {
          audit_extension: {
            planner_policy_trace: [
              {
                stage: 'constraint_resolution',
              },
            ],
            constraint_resolution_trace: {
              relations: [
                { type: 'contradiction' },
              ],
            },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

});
