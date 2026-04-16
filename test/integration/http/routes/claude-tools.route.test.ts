import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerClaudeToolsRoute } from '../../../../src/interface/http/routes/claude-tools.route.js';
import type { ClaudeToolsRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { resolveIncomingRequestId } from '../../../../src/interface/http/request-id.js';

describe('Claude tools HTTP route', () => {
  let app: FastifyInstance | undefined;
  const executeWithFallback = vi.fn();

  beforeAll(async () => {
    app = Fastify({
      // Match production so inbound X-Request-Id headers are honored
      // for request_id echo in error responses.
      genReqId: (req) => resolveIncomingRequestId(req.headers),
    });

    // Mirror production wiring so error responses flow through the
    // RFC-014 envelope handler instead of Fastify's default shape.
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    const deps: ClaudeToolsRouteDeps = {
      adaptiveToolExecutor: {
        executeWithFallback,
      },
    };

    registerClaudeToolsRoute(app, deps);
    await app.ready();
  });

  beforeEach(() => {
    executeWithFallback.mockReset();
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('GET /v1/claude-tools returns the tool manifest', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/claude-tools',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      tools: readonly unknown[];
      request_id: string;
    };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.request_id).toEqual(expect.any(String));
    const searchTool = body.tools.find((tool): tool is Record<string, unknown> => {
      return typeof tool === 'object' && tool !== null && (tool as { name?: unknown }).name === 'search_wines';
    });
    expect(searchTool).toBeDefined();
    expect(searchTool?.input_schema).toEqual(expect.objectContaining({
      type: 'object',
      required: ['query'],
    }));
  });

  it('POST /v1/claude-tools delegates to the adaptive executor', async () => {
    executeWithFallback.mockResolvedValueOnce({
      result: {
        query_type: 'search',
        engine_decision: {
          decision_status: 'resolved',
          next_action: 'return_result',
          route: 'entity',
          decision_confidence: 0.9,
          confidence_semantics: 'calibrated_decision_confidence',
          decision_trace_ref: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
          decision_snapshot: {
            snapshot_id: 'snapshot-123',
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1',
            threshold_profile_id: 'default',
            planner_version: '1',
            response_contract_version: 'search_response_v1',
            feature_flags: {},
          },
        },
        results: [],
        meta: {
          request_id: 'req-123',
          query_time_ms: 5,
          route: 'entity',
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'search_wines',
        tool_input: { query: 'Opus One 2018' },
        request_id: 'req-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeWithFallback).toHaveBeenCalledWith(
      'search_wines',
      {
        query: 'Opus One 2018',
        limit: 10,
        retrieval_mode: 'auto',
      },
      'req-123',
    );

    const body = JSON.parse(response.body) as {
      tool_name: string;
      tool_result: { query_type: string };
      request_id: string;
    };
    expect(body.tool_name).toBe('search_wines');
    expect(body.tool_result.query_type).toBe('search');
    expect(body.request_id).toBe('req-123');
  });

  it('POST /v1/claude-tools returns RFC-014 envelope on execution failure', async () => {
    executeWithFallback.mockRejectedValueOnce(new Error('boom'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      headers: { 'x-request-id': 'req-failed-123' },
      payload: {
        tool_name: 'search_wines',
        tool_input: { query: 'Opus One 2018' },
        request_id: 'req-failed-123',
      },
    });

    expect(response.statusCode).toBe(500);
    // Unknown errors propagate to the global error handler which emits
    // the canonical RFC-014 envelope shape `{ error: { request_id, code,
    // message, failure_reason, retryable } }`.
    const body = JSON.parse(response.body) as {
      error: {
        request_id: string;
        code: string;
        message: string;
        failure_reason: string | null;
        retryable: boolean;
      };
    };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBe('req-failed-123');
  });

  it('POST /v1/claude-tools rejects placeholder tool input at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      headers: { 'x-request-id': 'req-invalid-123' },
      payload: {
        tool_name: 'search_wines',
        tool_input: { query: '__TO_BE_FILLED__' },
        request_id: 'req-invalid-123',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(executeWithFallback).not.toHaveBeenCalled();
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('placeholder');
    expect(body.error.request_id).toBe('req-invalid-123');
  });

  it('POST /v1/claude-tools rejects unknown tool_input fields at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'search_wines',
        tool_input: {
          query: 'Opus One 2018',
          unexpected: true,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(executeWithFallback).not.toHaveBeenCalled();
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('unexpected');
  });
});
