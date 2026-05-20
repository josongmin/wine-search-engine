/**
 * HTTP route regression test suite for POST /v1/search/interpret.
 *
 * Locks the response shape (V1 InterpretResponseSchema, RFC-014 error envelope)
 * and freezes input contract (Korean / English / mixed queries, oversize, empty)
 * so future changes to the planner's QueryPlanV1 internal type cannot silently
 * change the public interpret surface.
 *
 * The planner is mocked at the InterpretUseCasePort seam — no real NLU/LLM calls.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { registerInterpretRoute } from '../../../../src/interface/http/routes/interpret.route.js';
import type { InterpretRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { InterpretResultWithV2 } from '../../../../src/application/search/interpret.usecase.js';
import { MAX_QUERY_LENGTH } from '../../../../src/domain/shared/constants.js';

interface PlanOverrides {
  readonly rawQuery?: string;
  readonly normalizedQuery?: string;
  readonly intent?: QueryPlanV1['intent'];
  readonly route?: QueryPlanV1['route'];
  readonly retrievalMode?: QueryPlanV1['retrievalMode'];
  readonly queryClass?: QueryPlanV1['queryClass'];
  readonly constraints?: QueryPlanV1['constraints'];
  readonly anchors?: QueryPlanV1['anchors'];
}

/**
 * Build a canonical V1 QueryPlan with all required fields populated.
 * Tests override the deltas relevant to each scenario.
 */
function buildPlan(overrides: PlanOverrides = {}): QueryPlanV1 {
  return {
    rawQuery: overrides.rawQuery ?? 'sample',
    normalizedQuery: overrides.normalizedQuery ?? 'sample',
    intent: overrides.intent ?? 'facet_search',
    route: overrides.route ?? 'hybrid',
    retrievalMode: overrides.retrievalMode ?? 'attribute_search',
    queryClass: overrides.queryClass ?? 'pure_constraint',
    anchors: overrides.anchors ?? [],
    constraints: overrides.constraints ?? { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {},
    uncertainty: {},
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
  };
}

async function post(
  app: FastifyInstance,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/search/interpret',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('POST /v1/search/interpret', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('happy-path response shape (V1 InterpretResponseSchema)', () => {
    it('Korean plain recommendation query returns 200 with canonical interpret fields', async () => {
      const plan = buildPlan({
        rawQuery: '프랑스 레드 와인 추천',
        normalizedQuery: '프랑스 레드 와인 추천',
        intent: 'semantic_discovery',
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'semantic_preference',
        constraints: {
          hard: [
            {
              attribute: 'country',
              operator: '=',
              value: 'France',
              source_phrase: '프랑스',
              confidence: 0.95,
            },
            {
              attribute: 'color',
              operator: '=',
              value: 'red',
              source_phrase: '레드',
              confidence: 0.97,
            },
          ],
          soft: [],
          inferred: [],
        },
      });

      const execute = vi.fn().mockResolvedValue(plan);
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: '프랑스 레드 와인 추천' });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Stable top-level shape — guards against silent schema drift.
      expect(body).toHaveProperty('raw_query');
      expect(body).toHaveProperty('normalized_query');
      expect(body).toHaveProperty('intent');
      expect(body).toHaveProperty('route');
      expect(body).toHaveProperty('retrieval_mode');
      expect(body).toHaveProperty('query_class');
      expect(body).toHaveProperty('anchors');
      expect(body).toHaveProperty('constraints');
      expect(body).toHaveProperty('expansions');
      expect(body).toHaveProperty('policy');
      expect(body).toHaveProperty('uncertainty');
      expect(body).toHaveProperty('planner_version');
      expect(body).toHaveProperty('policy_rule_version');
      expect(body).toHaveProperty('threshold_profile_id');

      expect(body.raw_query).toBe('프랑스 레드 와인 추천');
      expect(body.intent).toBe('semantic_discovery');
      expect(body.constraints.hard).toEqual([
        {
          attribute: 'country',
          operator: '=',
          value: 'France',
          source_phrase: '프랑스',
          confidence: 0.95,
        },
        {
          attribute: 'color',
          operator: '=',
          value: 'red',
          source_phrase: '레드',
          confidence: 0.97,
        },
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('comparison query exposes decomposition strategy via V2 explain (Accept human+json)', async () => {
      const plan = buildPlan({
        rawQuery: 'Opus One vs Sassicaia',
        normalizedQuery: 'opus one vs sassicaia',
        intent: 'comparison_search',
        route: 'mixed',
        retrievalMode: 'attribute_search',
        queryClass: 'comparison_query',
      });
      const v1WithCompiled: InterpretResultWithV2 = {
        v1Plan: plan,
        v2Explain: {
          queryId: 'q-cmp-1',
          queryText: 'Opus One vs Sassicaia',
          detectedIntent: 'comparison_search',
          decompositionStrategy: 'binary_comparison',
          activeChannels: ['sparse_bm25', 'dense_semantic'],
          appliedConstraints: [],
          rankingSignals: ['semantic_similarity'],
          confidence: 0.9,
          version: '2',
          responseType: 'interpret',
        },
        // The compiled field is required on the type but unused by the route's
        // V2 serialization path. Cast through unknown to avoid pulling in the
        // entire CompiledWineQuery shape just for a route-level test.
        compiled: {} as InterpretResultWithV2['compiled'],
      };

      const execute = vi.fn().mockResolvedValue(v1WithCompiled);
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const response = await post(
        app,
        { query: 'Opus One vs Sassicaia' },
        { accept: 'application/vnd.cuvee.human+json' },
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/vnd.cuvee.human+json');
      const body = response.json();
      expect(body.responseType).toBe('interpret');
      expect(body.version).toBe('2');
      expect(body.detectedIntent).toBe('comparison_search');
      expect(body.decompositionStrategy).toBe('binary_comparison');
    });

    it('constraint extraction surfaces price + region from Korean budget+region query', async () => {
      const plan = buildPlan({
        rawQuery: '30만원 이하 부르고뉴',
        normalizedQuery: '30만원 이하 부르고뉴',
        intent: 'budget_search',
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'pure_constraint',
        constraints: {
          hard: [
            {
              attribute: 'price',
              operator: '<=',
              value: 300_000,
              source_phrase: '30만원 이하',
              confidence: 0.99,
            },
            {
              attribute: 'region',
              operator: '=',
              value: 'Burgundy',
              source_phrase: '부르고뉴',
              confidence: 0.97,
            },
          ],
          soft: [],
          inferred: [],
        },
      });

      const deps: InterpretRouteDeps = {
        interpretUseCase: { execute: vi.fn().mockResolvedValue(plan) },
      };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: '30만원 이하 부르고뉴' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const attrs = body.constraints.hard.map((c: { attribute: string }) => c.attribute);
      expect(attrs).toContain('price');
      expect(attrs).toContain('region');
      const price = body.constraints.hard.find((c: { attribute: string }) => c.attribute === 'price');
      expect(price.operator).toBe('<=');
      expect(price.value).toBe(300_000);
    });

    it('pairing query exposes pairing intent + pairing constraint', async () => {
      const plan = buildPlan({
        rawQuery: '스테이크 어울리는 와인',
        normalizedQuery: '스테이크 어울리는 와인',
        intent: 'pairing_search',
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'pure_constraint',
        constraints: {
          hard: [
            {
              attribute: 'food_pairing',
              operator: '=',
              value: 'steak',
              source_phrase: '스테이크',
              confidence: 0.96,
            },
          ],
          soft: [],
          inferred: [],
        },
      });

      const deps: InterpretRouteDeps = {
        interpretUseCase: { execute: vi.fn().mockResolvedValue(plan) },
      };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: '스테이크 어울리는 와인' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.intent).toBe('pairing_search');
      expect(body.constraints.hard[0].attribute).toBe('food_pairing');
      expect(body.constraints.hard[0].value).toBe('steak');
    });

    it('OOD query (whisky) surfaces unknown query_class with no positive anchors', async () => {
      const plan = buildPlan({
        rawQuery: '위스키 추천',
        normalizedQuery: '위스키 추천',
        intent: 'semantic_discovery',
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'unknown',
      });

      const deps: InterpretRouteDeps = {
        interpretUseCase: { execute: vi.fn().mockResolvedValue(plan) },
      };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: '위스키 추천' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.query_class).toBe('unknown');
      expect(body.anchors).toEqual([]);
      expect(body.constraints.hard).toEqual([]);
    });
  });

  describe('input validation (RFC-014 error envelope)', () => {
    it('empty query body returns 400 with VALIDATION_ERROR envelope', async () => {
      const execute = vi.fn();
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: '' });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.retryable).toBe(false);
      expect(body.error.request_id).toEqual(expect.any(String));
      expect(execute).not.toHaveBeenCalled();
    });

    it('oversized query (> MAX_QUERY_LENGTH chars) returns 400 with VALIDATION_ERROR', async () => {
      const execute = vi.fn();
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const oversized = 'a'.repeat(MAX_QUERY_LENGTH + 1);
      const response = await post(app, { query: oversized });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(execute).not.toHaveBeenCalled();
    });

    it('whitespace-only query reaches the use case and INVALID_REQUEST surfaces as 400', async () => {
      // Whitespace passes the schema's .min(1) length check (3 chars), so the
      // route forwards it to the planner. The use case is the one that decides
      // the query is semantically empty after sanitization — represented here
      // by INVALID_REQUEST, the canonical domain code for "client sent a
      // request that violates the endpoint's semantic contract" (RFC-014).
      const { DomainError } = await import('../../../../src/domain/shared/error/domain-error.js');
      const execute = vi.fn().mockRejectedValue(
        new DomainError('INVALID_REQUEST', 'Empty query after sanitization.'),
      );
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: '   ' });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('missing query field returns 400 with VALIDATION_ERROR', async () => {
      const execute = vi.fn();
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const response = await post(app, {});

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('regression: locale and Unicode normalization stability', () => {
    it('English-only query produces the same V1 contract shape as Korean', async () => {
      const plan = buildPlan({
        rawQuery: 'recommend French red wine',
        normalizedQuery: 'recommend french red wine',
        intent: 'semantic_discovery',
        queryClass: 'semantic_preference',
      });
      const deps: InterpretRouteDeps = {
        interpretUseCase: { execute: vi.fn().mockResolvedValue(plan) },
      };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: 'recommend French red wine' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Same top-level keys as the Korean happy path → stable cross-locale contract.
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(expect.arrayContaining([
        'anchors',
        'constraints',
        'expansions',
        'intent',
        'normalized_query',
        'planner_version',
        'policy',
        'policy_rule_version',
        'query_class',
        'raw_query',
        'retrieval_mode',
        'route',
        'threshold_profile_id',
        'uncertainty',
      ]));
    });

    it('mixed Korean+English query is forwarded verbatim to the planner', async () => {
      const plan = buildPlan({
        rawQuery: 'Bordeaux 와인 추천',
        normalizedQuery: 'bordeaux 와인 추천',
        intent: 'semantic_discovery',
      });
      const execute = vi.fn().mockResolvedValue(plan);
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: 'Bordeaux 와인 추천' });

      expect(response.statusCode).toBe(200);
      const firstArg = execute.mock.calls[0]?.[0] as { query: string };
      expect(firstArg.query).toBe('Bordeaux 와인 추천');
    });

    it('NFC and NFD Korean inputs each reach the planner with their original byte sequence', async () => {
      // Boundary: HTTP layer must NOT silently re-normalize Unicode.
      // The planner / normalizer downstream is the SSoT for canonicalization;
      // the route only forwards the raw bytes.
      const nfc = '크로스'; // "크로스" precomposed Hangul syllables
      const nfd = nfc.normalize('NFD');
      expect(nfc).not.toBe(nfd); // Sanity: the two encodings differ at the byte level.

      const execute = vi.fn().mockImplementation(async (req: { query: string }) =>
        buildPlan({ rawQuery: req.query, normalizedQuery: req.query }),
      );
      const deps: InterpretRouteDeps = { interpretUseCase: { execute } };
      registerInterpretRoute(app, deps);

      const r1 = await post(app, { query: nfc });
      const r2 = await post(app, { query: nfd });

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      const firstArg1 = execute.mock.calls[0]?.[0] as { query: string };
      const firstArg2 = execute.mock.calls[1]?.[0] as { query: string };
      expect(firstArg1.query).toBe(nfc);
      expect(firstArg2.query).toBe(nfd);
      // Both responses keep identical top-level contract shape.
      expect(Object.keys(r1.json()).sort()).toEqual(Object.keys(r2.json()).sort());
    });

    it('boundary: query at exactly MAX_QUERY_LENGTH chars is accepted', async () => {
      const onLimit = 'a'.repeat(MAX_QUERY_LENGTH);
      const plan = buildPlan({ rawQuery: onLimit, normalizedQuery: onLimit });
      const deps: InterpretRouteDeps = {
        interpretUseCase: { execute: vi.fn().mockResolvedValue(plan) },
      };
      registerInterpretRoute(app, deps);

      const response = await post(app, { query: onLimit });

      expect(response.statusCode).toBe(200);
    });
  });
});
