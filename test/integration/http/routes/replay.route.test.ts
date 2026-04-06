import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('POST /v1/search/replay', () => {
  let app: FastifyInstance;
  let mockDeps: ReplayRouteDeps;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    mockDeps = {
      replayUseCase: {
        execute: vi.fn().mockResolvedValue({
          queryType: 'search',
          engineDecision: {
            decisionStatus: 'resolved',
            nextAction: 'respond',
            route: 'entity',
            decisionConfidence: 0.99,
            confidenceSemantics: 'calibrated_decision_confidence',
            decisionTraceRef: 'trace-1',
            decisionSnapshot: {
              model_versions: {},
              index_versions: {},
              policy_rule_version: '1.0.0',
              threshold_profile_id: 'default',
              planner_version: '1.0.0',
              feature_flags: {},
            },
          },
          results: [],
          meta: {
            requestId: 'test-request',
            queryTimeMs: 1,
            route: 'entity',
            version: '1.0.0',
            engine_schema_version: 'search_response_v1',
            decisionSnapshot: {
              model_versions: {},
              index_versions: {},
              policy_rule_version: '1.0.0',
              threshold_profile_id: 'default',
              planner_version: '1.0.0',
              feature_flags: {},
            },
            response_hash: 'actual-hash',
          },
        }),
      },
    };

    registerReplayRoute(app, mockDeps);
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
        decision_snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
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
        decision_snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
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

  it('maps UnexpectedReplayResponseError to 500 with the RFC-014 error contract', async () => {
    mockDeps.replayUseCase.execute = vi.fn().mockRejectedValue(new UnexpectedReplayResponseError());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        decision_snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
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
