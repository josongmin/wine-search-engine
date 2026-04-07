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
            decision_trace_ref: 'trace-1',
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
        decision_trace_ref: 'trace-1',
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
        decision_trace_ref: 'trace-1',
        execution_mode: 'heuristic',
        blocking_eligible: false,
        degradation_reasons: ['heuristic_drinking_window'],
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
        execution_mode: 'heuristic',
        blocking_eligible: false,
        degradation_reasons: ['heuristic_drinking_window'],
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
          execution_mode: 'heuristic',
          degradation_reasons: ['heuristic_drinking_window'],
          blocking_eligible: false,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        preflight_honesty_contract: {
          execution_mode: 'heuristic',
          degradation_reasons: ['heuristic_drinking_window'],
          blocking_eligible: false,
        },
      }),
      expect.any(String),
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
});
