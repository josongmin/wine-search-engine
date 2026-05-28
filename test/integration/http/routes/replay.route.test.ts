import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DeterminismViolationError,
  UnexpectedReplayResponseError,
} from '../../../../src/application/search/replay.usecase.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import type { ReplayRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import { registerReplayRoute } from '../../../../src/interface/http/routes/replay.route.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';

const CANONICAL_ENTITY_TRACE_REF =
  'decision:v1:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function buildReplaySnapshot() {
  return {
    snapshot_id: 'snap-1',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'search_response_v1',
  };
}

describe('POST /v1/search/replay', () => {
  let app: FastifyInstance;
  let mockDeps: ReplayRouteDeps;

  beforeAll(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    mockDeps = {
      replayUseCase: {
        execute: vi.fn().mockResolvedValue({
          query_type: 'search',
          engine_decision: {
            decision_status: 'resolved',
            next_action: 'return_result',
            route: 'entity',
            decision_confidence: 0.99,
            confidence_semantics: 'calibrated_decision_confidence',
            decision_trace_ref: CANONICAL_ENTITY_TRACE_REF,
            decision_snapshot: buildReplaySnapshot(),
          },
          results: [],
          meta: {
            request_id: 'test-request',
            query_time_ms: 1,
            route: 'entity',
            version: '1.0.0',
            engine_schema_version: 'search_response_v1',
            decision_snapshot: buildReplaySnapshot(),
            response_hash: 'actual-hash',
          },
        }),
      },
    };

    registerReplayRoute(app, mockDeps);
  });

  beforeEach(() => {
    mockDeps.replayUseCase.execute = vi.fn().mockResolvedValue({
      query_type: 'search',
      engine_decision: {
        decision_status: 'resolved',
        next_action: 'return_result',
        route: 'entity',
        decision_confidence: 0.99,
        confidence_semantics: 'calibrated_decision_confidence',
        decision_trace_ref: CANONICAL_ENTITY_TRACE_REF,
        decision_snapshot: buildReplaySnapshot(),
      },
      results: [],
      meta: {
        request_id: 'test-request',
        query_time_ms: 1,
        route: 'entity',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        decision_snapshot: buildReplaySnapshot(),
        response_hash: 'actual-hash',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails closed (403) in production when HTTP_DEBUG_SECRET is unset (R6 M9)', async () => {
    const savedNodeEnv = process.env['NODE_ENV'];
    const savedSecret = process.env['HTTP_DEBUG_SECRET'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['HTTP_DEBUG_SECRET'];
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: {
          query: 'Opus One 2018',
          decision_snapshot: buildReplaySnapshot(),
          expected_response_hash: 'expected-hash',
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('REPLAY_FORBIDDEN');
    } finally {
      if (savedNodeEnv === undefined) {
        delete process.env['NODE_ENV'];
      } else {
        process.env['NODE_ENV'] = savedNodeEnv;
      }
      if (savedSecret === undefined) {
        delete process.env['HTTP_DEBUG_SECRET'];
      } else {
        process.env['HTTP_DEBUG_SECRET'] = savedSecret;
      }
    }
  });

  it('maps DeterminismViolationError to 409 with the RFC-014 error contract', async () => {
    mockDeps.replayUseCase.execute = vi.fn().mockRejectedValue(
      new DeterminismViolationError('expected-hash', 'actual-hash'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: buildReplaySnapshot(),
        expected_response_hash: 'expected-hash',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(ErrorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({
      error: {
        code: 'DETERMINISM_VIOLATION',
        retryable: false,
      },
    });
  });

  it('passes expected_response_hash through to the replay use case', async () => {
    const execute = vi.fn(async (request) => {
      expect(request).toMatchObject({
        query: 'Opus One 2018',
        expected_response_hash: 'actual-hash',
      });
      throw new DeterminismViolationError('expected-hash', 'actual-hash');
    });
    mockDeps.replayUseCase.execute = execute;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: buildReplaySnapshot(),
        expected_response_hash: 'actual-hash',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        expected_response_hash: 'actual-hash',
      }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('passes expected_determinism_fingerprint through to the replay use case', async () => {
    const execute = vi.fn(async (request) => {
      expect(request).toMatchObject({
        query: 'Opus One 2018',
        expected_determinism_fingerprint: 'abc123def4567890',
      });
      throw new DeterminismViolationError('expected-fingerprint', 'actual-fingerprint', 'determinism_fingerprint');
    });
    mockDeps.replayUseCase.execute = execute;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: buildReplaySnapshot(),
        expected_determinism_fingerprint: 'abc123def4567890',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        expected_determinism_fingerprint: 'abc123def4567890',
      }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('passes preflight_honesty_contract through to the replay use case', async () => {
    const execute = vi.fn().mockResolvedValue({
      query_type: 'search',
      engine_decision: {
        decision_status: 'resolved',
        next_action: 'return_result',
        route: 'entity',
        decision_confidence: 0.99,
        confidence_semantics: 'calibrated_decision_confidence',
        decision_trace_ref: CANONICAL_ENTITY_TRACE_REF,
        execution_mode: 'degraded',
        blocking_eligible: false,
        degradation_reasons: ['dense_retrieval_disabled'],
        decision_snapshot: buildReplaySnapshot(),
      },
      results: [],
      meta: {
        request_id: 'test-request',
        query_time_ms: 1,
        route: 'entity',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        decision_snapshot: buildReplaySnapshot(),
        execution_mode: 'degraded',
        blocking_eligible: false,
        degradation_reasons: ['dense_retrieval_disabled'],
        response_hash: 'actual-hash',
      },
    });
    mockDeps.replayUseCase.execute = execute;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: buildReplaySnapshot(),
        preflight_honesty_contract: {
          execution_mode: 'degraded',
          degradation_reasons: ['dense_retrieval_disabled'],
          blocking_eligible: false,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        preflight_honesty_contract: {
          execution_mode: 'degraded',
          degradation_reasons: ['dense_retrieval_disabled'],
          blocking_eligible: false,
        },
      }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('maps UnexpectedReplayResponseError to 500 with the RFC-014 error contract', async () => {
    mockDeps.replayUseCase.execute = vi.fn().mockRejectedValue(new UnexpectedReplayResponseError());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: buildReplaySnapshot(),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(ErrorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({
      error: {
        code: 'UNEXPECTED_REPLAY_RESPONSE',
        retryable: false,
      },
    });
  });

  it('fails closed when a V2 human payload leaks into the V1 replay route', async () => {
    mockDeps.replayUseCase.execute = vi.fn().mockResolvedValue({
      queryId: 'q-v2',
      queryType: 'search',
      results: [],
      totalCandidates: 0,
      version: '2',
      responseType: 'human',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: buildReplaySnapshot(),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(ErrorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        retryable: false,
      },
    });
  });
});
