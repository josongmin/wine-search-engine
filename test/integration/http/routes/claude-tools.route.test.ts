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

  it('POST /v1/claude-tools accepts lookup_wine and delegates with the lookup contract', async () => {
    executeWithFallback.mockResolvedValueOnce({
      result: {
        query_type: 'search',
        engine_decision: {
          decision_status: 'resolved',
          next_action: 'return_result',
          route: 'entity',
          decision_confidence: 0.95,
          confidence_semantics: 'calibrated_decision_confidence',
          decision_trace_ref: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
          decision_snapshot: {
            snapshot_id: 'snapshot-lookup-123',
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
          request_id: 'req-lookup-123',
          query_time_ms: 3,
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
        tool_name: 'lookup_wine',
        tool_input: { query: 'Opus One 2018', limit: 2 },
        request_id: 'req-lookup-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeWithFallback).toHaveBeenCalledWith(
      'lookup_wine',
      {
        query: 'Opus One 2018',
        limit: 2,
      },
      'req-lookup-123',
    );

    const body = JSON.parse(response.body) as {
      tool_name: string;
      tool_result: { query_type: string };
      request_id: string;
    };
    expect(body.tool_name).toBe('lookup_wine');
    expect(body.tool_result.query_type).toBe('search');
    expect(body.request_id).toBe('req-lookup-123');
  });

  it('POST /v1/claude-tools accepts get_food_pairings and delegates with the pairing contract', async () => {
    executeWithFallback.mockResolvedValueOnce({
      result: { error: 'pairing not available in route mock' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'get_food_pairings',
        tool_input: {
          food: 'grilled salmon',
          max_price_krw: 60000,
          color: 'white',
        },
        request_id: 'req-pairing-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeWithFallback).toHaveBeenCalledWith(
      'get_food_pairings',
      {
        food: 'grilled salmon',
        max_price_krw: 60000,
        color: 'white',
      },
      'req-pairing-123',
    );

    const body = JSON.parse(response.body) as {
      tool_name: string;
      tool_result: { error: string };
      request_id: string;
    };
    expect(body.tool_name).toBe('get_food_pairings');
    expect(body.tool_result.error).toBe('pairing not available in route mock');
    expect(body.request_id).toBe('req-pairing-123');
  });

  it('POST /v1/claude-tools accepts check_drinking_window and delegates with the drinking-window contract', async () => {
    executeWithFallback.mockResolvedValueOnce({
      result: {
        drinking_window_start: 2024,
        drinking_window_end: 2032,
        peak_year: 2028,
        currently_drinkable: true,
        confidence: 'high',
        evidence_level: 'deterministic',
        blocking_eligible: true,
        model_version: 'deterministic:structural-slot-v2',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'check_drinking_window',
        tool_input: {
          entity_id: 'entity:wine:opus-one-2018',
          target_year: 2028,
        },
        request_id: 'req-drinking-window-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeWithFallback).toHaveBeenCalledWith(
      'check_drinking_window',
      {
        entity_id: 'entity:wine:opus-one-2018',
        target_year: 2028,
      },
      'req-drinking-window-123',
    );

    const body = JSON.parse(response.body) as {
      tool_name: string;
      tool_result: {
        drinking_window_start: number;
        drinking_window_end: number;
        peak_year: number;
        currently_drinkable: boolean;
      };
      request_id: string;
    };
    expect(body.tool_name).toBe('check_drinking_window');
    expect(body.tool_result.drinking_window_start).toBe(2024);
    expect(body.tool_result.drinking_window_end).toBe(2032);
    expect(body.tool_result.currently_drinkable).toBe(true);
    expect(body.request_id).toBe('req-drinking-window-123');
  });

  it('POST /v1/claude-tools accepts compare_wines and delegates with the comparison contract', async () => {
    executeWithFallback.mockResolvedValueOnce({
      result: {
        query_type: 'comparison',
        original_query: 'Opus One 2018 vs Caymus Cabernet 2019',
        comparison_intent: 'compare',
        entities: [
          {
            sub_query: 'Opus One 2018',
            top_result: null,
            result_count: 0,
            resolution_status: 'failed',
            all_results: [],
          },
          {
            sub_query: 'Caymus Cabernet 2019',
            top_result: null,
            result_count: 0,
            resolution_status: 'failed',
            all_results: [],
          },
        ],
        overall_status: 'failed',
        request_id: 'req-compare-123',
        runtime_correlation_ref: 'req-compare-123',
        execution_time_ms: 12,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'compare_wines',
        tool_input: {
          query_a: 'Opus One 2018',
          query_b: 'Caymus Cabernet 2019',
        },
        request_id: 'req-compare-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeWithFallback).toHaveBeenCalledWith(
      'compare_wines',
      {
        query_a: 'Opus One 2018',
        query_b: 'Caymus Cabernet 2019',
      },
      'req-compare-123',
    );

    const body = JSON.parse(response.body) as {
      tool_name: string;
      tool_result: { query_type: string; overall_status: string };
      request_id: string;
    };
    expect(body.tool_name).toBe('compare_wines');
    expect(body.tool_result.query_type).toBe('comparison');
    expect(body.tool_result.overall_status).toBe('failed');
    expect(body.request_id).toBe('req-compare-123');
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

  it('POST /v1/claude-tools tolerates unknown tool_input fields and strips them', async () => {
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
            snapshot_id: 'snapshot-unknown-123',
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
          request_id: 'req-unknown-123',
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
        tool_input: {
          query: 'Opus One 2018',
          unexpected: true,
        },
        request_id: 'req-unknown-123',
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
      'req-unknown-123',
    );
  });
});
