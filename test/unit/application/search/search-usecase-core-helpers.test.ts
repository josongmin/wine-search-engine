import { afterEach, describe, it, expect, vi } from 'vitest';
import { topKFinalScores } from '../../../../src/application/search/search-usecase-ranking-scores.js';
import { buildEntityResolverInputFromPlan } from '../../../../src/application/search/search-usecase-entity-resolver-input.js';
import { buildHybridRetrievalInputForPlan } from '../../../../src/application/search/search-usecase-hybrid-candidates.js';
import { tryGetCachedSearchResponse } from '../../../../src/application/search/search-usecase-cache-lookup.js';
import { buildConstraintContradictionExitParams } from '../../../../src/application/search/search-usecase-constraint-early-exit.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import { globalSilentSkipCounter } from '../../../../src/domain/observability/silent-skip-counters.js';

afterEach(() => {
  globalSilentSkipCounter.reset();
});

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'unknown',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function minimalCompiled(): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'q',
      normalizedQuery: 'q',
      intent: 'semantic_discovery',
      queryClass: 'unknown',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {} as never,
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  };
}

describe('topKFinalScores', () => {
  it('returns up to k scores', () => {
    const rows = [0.9, 0.8, 0.7].map((finalScore, i) => ({
      finalScore,
      entityId: `e-${i}`,
    })) as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    expect(topKFinalScores(rows, 2)).toEqual([0.9, 0.8]);
  });
});

describe('buildEntityResolverInputFromPlan', () => {
  it('passes plan fields into resolver input', () => {
    const plan = minimalPlan();
    const input = buildEntityResolverInputFromPlan(plan);
    expect(input.rawQuery).toBe('q');
    expect(input.candidateEntities).toEqual([]);
  });
});

describe('buildHybridRetrievalInputForPlan', () => {
  it('propagates the compiled execution candidate budget into retrieval input', () => {
    const input = buildHybridRetrievalInputForPlan(
      minimalPlan(),
      'hybrid',
      undefined,
      minimalCompiled(),
    );

    expect(input.executionBudgetMaxCandidates).toBe(20);
  });

  it('attaches a structured retrieval plan derived from constraints', () => {
    const plan = {
      ...minimalPlan(),
      normalizedQueryViews: {
        raw: '오푸스원',
        strict: '오푸스원',
        accentless: '오푸스원',
        collapsedWhitespace: '오푸스원',
        punctuationStripped: '오푸스원',
        compact: '오푸스원',
        vintageCanonicalized: '오푸스원',
        vintageStripped: '오푸스원',
        semanticVariants: ['오푸스원', 'opus one'],
        lookupVariants: ['오푸스원', 'opus one', 'opusone'],
      },
      constraints: {
        hard: [
          {
            attribute: 'region',
            operator: '=',
            value: 'Bordeaux',
            source_phrase: '보르도',
            confidence: 0.95,
            mapping_version: 'test',
          },
        ],
        soft: [],
        inferred: [
          {
            attribute: 'grape_family',
            operator: 'in',
            value: ['Cabernet', 'Merlot'],
            source_phrase: 'composition(bordeaux+red)',
            confidence: 0.75,
            mapping_version: 'test',
          },
          {
            attribute: 'occasion',
            operator: 'in',
            value: ['gift'],
            source_phrase: '선물용',
            confidence: 0.8,
            mapping_version: 'test',
          },
        ],
      },
    } as QueryPlanV1;
    const input = buildHybridRetrievalInputForPlan(plan);

    expect(input.retrievalPlan?.hardFilterTokens.length).toBeGreaterThan(0);
    expect(input.retrievalPlan?.inferredBoosts).toHaveLength(2);
    expect(input.lexicalQueries).toEqual(
      expect.arrayContaining(['q', '오푸스원', 'opus one', 'opusone', 'Bordeaux', 'Cabernet Merlot', 'gift']),
    );
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining(['q', 'Bordeaux', 'Cabernet Merlot', 'gift']),
    );
    expect(input.semanticQueries).not.toEqual(
      expect.arrayContaining(['오푸스원', 'opusone']),
    );
  });

  it('does not flatten learned suitability or drinking-window signals into numeric lexical expansions', () => {
    const plan = {
      ...minimalPlan(),
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'gift_suitability',
            operator: '>=',
            value: 0.7,
            source_phrase: 'gift-worthy',
            confidence: 0.9,
            mapping_version: 'test',
          },
          {
            attribute: 'beginner_suitability',
            operator: '>=',
            value: 0.6,
            source_phrase: '초보자',
            confidence: 0.88,
            mapping_version: 'test',
          },
          {
            attribute: 'drinking_window',
            operator: '=',
            value: 'peak',
            source_phrase: '지금 피크',
            confidence: 0.85,
            mapping_version: 'test',
          },
        ],
        inferred: [],
      },
    } as QueryPlanV1;

    const input = buildHybridRetrievalInputForPlan(plan);

    expect(input.lexicalQueries).not.toEqual(expect.arrayContaining(['0.7', '0.6', 'peak']));
    expect(input.semanticQueries).not.toEqual(expect.arrayContaining(['0.7', '0.6', 'peak']));
    expect(input.retrievalObjective?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: 'gift_suitability', value: 0.7 }),
      expect.objectContaining({ axis: 'beginner_suitability', value: 0.6 }),
      expect.objectContaining({ axis: 'drinking_window', value: 'peak' }),
    ]));
  });
});

describe('tryGetCachedSearchResponse', () => {
  it('returns data on cache hit', async () => {
    const cached = { queryType: 'search' as const, engineDecision: {} as any, results: [], meta: {} } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1;
    const getSearchResponse = vi.fn(async () => ({
      kind: 'hit',
      value: cached,
    }));
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const out = await tryGetCachedSearchResponse(
      { getSearchResponse } as import('../../../../src/domain/performance/port/search-response-cache.port.js').SearchResponseCachePort,
      plan,
      undefined,
      request,
      undefined,
    );
    expect(out).toBe(cached);
    expect(getSearchResponse).toHaveBeenCalledOnce();
  });

  it('returns undefined on miss', async () => {
    const getSearchResponse = vi.fn(async () => ({ kind: 'miss' }));
    const plan = minimalPlan();
    const out = await tryGetCachedSearchResponse(
      { getSearchResponse } as import('../../../../src/domain/performance/port/search-response-cache.port.js').SearchResponseCachePort,
      plan,
      undefined,
      { query: 'x' },
      undefined,
    );
    expect(out).toBeUndefined();
  });

  it('returns undefined and counts breaker_open separately', async () => {
    const getSearchResponse = vi.fn(async () => ({ kind: 'breaker_open' }));
    const plan = minimalPlan();
    const before = globalSilentSkipCounter.snapshot().cache_read_failure;
    const out = await tryGetCachedSearchResponse(
      { getSearchResponse } as import('../../../../src/domain/performance/port/search-response-cache.port.js').SearchResponseCachePort,
      plan,
      undefined,
      { query: 'x' },
      undefined,
    );
    const after = globalSilentSkipCounter.snapshot().cache_read_failure;
    expect(out).toBeUndefined();
    expect(after).toBe(before + 1);
  });

  it('returns undefined and counts infra_error separately', async () => {
    const getSearchResponse = vi.fn(async () => ({
      kind: 'infra_error',
      errorClass: 'Error',
      message: 'redis down',
    }));
    const plan = minimalPlan();
    const before = globalSilentSkipCounter.snapshot().cache_read_failure;
    const out = await tryGetCachedSearchResponse(
      { getSearchResponse } as import('../../../../src/domain/performance/port/search-response-cache.port.js').SearchResponseCachePort,
      plan,
      undefined,
      { query: 'x' },
      undefined,
    );
    const after = globalSilentSkipCounter.snapshot().cache_read_failure;
    expect(out).toBeUndefined();
    expect(after).toBe(before + 1);
  });
});

describe('buildConstraintContradictionExitParams', () => {
  it('builds failed decision with constraint message', () => {
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const params = buildConstraintContradictionExitParams(
      plan,
      request,
      'rid',
      0,
      undefined,
      [
        [
          { attribute: 'color', operator: 'eq', value: 'red' },
          { attribute: 'color', operator: 'eq', value: 'white' },
        ],
      ],
      minimalCompiled(),
    );
    expect(params.decisionOutput.decisionStatus).toBe('failed');
    expect(params.decisionOutput.failureReason).toBe('HARD_CONSTRAINT_VIOLATION');
    expect(params.decisionOutput.decisionTrace.finalReason).toContain('Contradictory');
  });
});
