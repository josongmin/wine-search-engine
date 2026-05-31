import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import {
  registerHybridSearchRoute,
  registerSemanticSearchRoute,
} from '../../../../src/interface/http/routes/primitive-search.route.js';
import type { SearchRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

const CANONICAL_HYBRID_TRACE_REF =
  'decision:v1:hybrid:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function buildSnapshot() {
  return {
    snapshot_id: 'snap-primitive-1',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'search_response_v1',
  };
}

function buildSearchResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: CANONICAL_HYBRID_TRACE_REF,
      decisionSnapshot: buildSnapshot(),
    },
    results: [],
    meta: {
      requestId: 'req-primitive',
      queryTimeMs: 1,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: buildSnapshot(),
      response_hash: 'hash-primitive',
    },
  };
}

function makeDeps(executeMock = vi.fn().mockResolvedValue(buildSearchResponse())): SearchRouteDeps {
  return {
    searchUseCase: {
      execute: executeMock,
    },
  };
}

async function post(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

describe('primitive search route compatibility', () => {
  let app: FastifyInstance;
  let deps: SearchRouteDeps;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps();
    registerHybridSearchRoute(app, deps);
    registerSemanticSearchRoute(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts the legacy options envelope on /v1/search/hybrid but keeps the path authoritative', async () => {
    const response = await post(app, '/v1/search/hybrid', {
      query: 'Opus One 2018',
      options: {
        mode: 'entity',
        explain: true,
        clarification: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(deps.searchUseCase.execute).toHaveBeenCalledTimes(1);
    const args = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({
      query: 'Opus One 2018',
      retrievalLane: 'hybrid',
    });
    expect((args?.[0] as { retrieval_mode?: string } | undefined)?.retrieval_mode).toBeUndefined();
  });

  it('ignores a legacy mode hint on /v1/search/semantic and still forces semantic_only', async () => {
    const response = await post(app, '/v1/search/semantic', {
      query: 'Cloudy Bay',
      options: {
        mode: 'hybrid',
        explain: false,
        clarification: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(deps.searchUseCase.execute).toHaveBeenCalledTimes(1);
    const args = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({
      query: 'Cloudy Bay',
      retrievalLane: 'semantic_only',
    });
    expect((args?.[0] as { retrieval_mode?: string } | undefined)?.retrieval_mode).toBeUndefined();
  });
});
