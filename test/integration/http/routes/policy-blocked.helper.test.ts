import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import {
  buildPolicyBlockedErrorResponse,
  isPolicyBlockedSearchResponse,
  throwIfPolicyBlockedSearchResponse,
} from '../../../../src/interface/http/errors/policy-blocked.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

function buildResponse(failureReason: string, route: string): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'failed',
      nextAction: 'fail',
      route,
      decisionConfidence: 0,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: route,
        feature_flags: {},
      },
      failure_reason: failureReason,
    },
    results: [],
    meta: {
      requestId: 'req-1',
      queryTimeMs: 1,
      route,
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: route,
        feature_flags: {},
      },
      response_hash: 'hash',
    },
  };
}

describe('policy-blocked HTTP helper', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    registerRequestContext(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('identifies only security_gate policy-blocked search responses', () => {
    expect(isPolicyBlockedSearchResponse(buildResponse('POLICY_BLOCKED', 'security_gate'))).toBe(true);
    expect(isPolicyBlockedSearchResponse(buildResponse('POLICY_BLOCKED', 'hybrid'))).toBe(false);
    expect(isPolicyBlockedSearchResponse(buildResponse('NO_RESULTS', 'security_gate'))).toBe(false);
  });

  it('builds the canonical machine-readable error body', () => {
    expect(buildPolicyBlockedErrorResponse('req-123')).toEqual({
      error: {
        request_id: 'req-123',
        code: 'POLICY_BLOCKED',
        message: 'Query blocked by security policy.',
        failure_reason: 'POLICY_BLOCKED',
        retryable: false,
      },
    });
  });

  it('throws a typed PolicyBlockedError for security-gate policy blocks', () => {
    expect(() => {
      throwIfPolicyBlockedSearchResponse(buildResponse('POLICY_BLOCKED', 'security_gate'));
    }).toThrow(PolicyBlockedError);
  });

  it('does nothing for non-policy search failures', () => {
    expect(() => {
      throwIfPolicyBlockedSearchResponse(buildResponse('NO_RESULTS', 'hybrid'));
    }).not.toThrow();
  });
});
