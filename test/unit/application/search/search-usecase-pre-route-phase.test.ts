import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConstraintSAT } from '../../../../src/domain/query/service/constraint-sat.js';
import { QuerySanitizer } from '../../../../src/domain/security/service/query-sanitizer.js';
import { runSearchPreRoutePhase } from '../../../../src/application/search/search-usecase-pre-route-phase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import type { QueryPlannerPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { ResponseBuilder } from '../../../../src/domain/response/service/response-builder.js';
import { logSearchEvent } from '../../../../src/observability/log-search-event.js';

vi.mock('../../../../src/observability/log-search-event.js', () => ({
  logSearchEvent: vi.fn(),
}));

const mockedLogSearchEvent = vi.mocked(logSearchEvent);

describe('runSearchPreRoutePhase', () => {
  beforeEach(() => {
    mockedLogSearchEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns continue with plan when pipeline reaches main search', async () => {
    const plan = {
      rawQuery: 'red wine',
      normalizedQuery: 'red wine',
      intent: 'facet_search' as const,
      route: 'hybrid' as const,
      retrievalMode: 'semantic_hybrid' as const,
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

    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn(async () => plan),
    };

    const responseBuilder = { build: vi.fn() } as unknown as ResponseBuilder;

    const request: SearchRequest = { query: 'red wine' };

    const result = await runSearchPreRoutePhase({
      request,
      requestId: 'r1',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.plan).toBe(plan);
    }
    expect(queryPlanner.plan).toHaveBeenCalled();
  });

  it('logs compiled execution route and mode when compiled planning is available', async () => {
    const plan = {
      rawQuery: 'red wine',
      normalizedQuery: 'red wine',
      intent: 'facet_search' as const,
      route: 'entity' as const,
      retrievalMode: 'attribute_search' as const,
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

    const compiled = {
      query: {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        intent: plan.intent,
        queryClass: plan.queryClass,
        anchors: plan.anchors,
        constraints: plan.constraints,
        expansions: plan.expansions,
        uncertainty: plan.uncertainty,
        plannerVersion: plan.plannerVersion,
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
      },
      execution: {
        effectiveRoute: 'mixed' as const,
        effectiveRetrievalMode: 'recommendation' as const,
        routeSource: 'planner' as const,
        budget: { maxCandidates: 20, enablePrecisionRerank: true },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    };

    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn(async () => plan),
      planWithCompiled: vi.fn(async () => ({ v1: plan, compiled })),
    };

    const responseBuilder = { build: vi.fn() } as unknown as ResponseBuilder;

    const result = await runSearchPreRoutePhase({
      request: { query: 'red wine' },
      requestId: 'r2',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    expect(mockedLogSearchEvent).toHaveBeenCalledTimes(1);
    expect(mockedLogSearchEvent).toHaveBeenCalledWith(expect.objectContaining({
      runtime_correlation_ref: 'r2',
      query_observability: expect.objectContaining({
        suggestedRoute: 'mixed',
        suggestedRetrievalMode: 'recommendation',
        queryFamily: 'recommendation',
      }),
    }));
  });

  it('passes parent context, session, and budget into decomposed search sub-queries', async () => {
    const decomposedSearch = {
      execute: vi.fn().mockResolvedValue({
        queryType: 'comparison',
        originalQuery: 'Opus One vs Screaming Eagle',
        comparisonIntent: 'compare',
        entities: [],
        overallStatus: 'failed',
        requestId: 'r-compare',
        executionTimeMs: 5,
      }),
    };

    const result = await runSearchPreRoutePhase({
      request: {
        query: 'Opus One vs Screaming Eagle',
        context: { locale: 'ko-KR', currency: 'KRW' },
        sessionContext: { sessionId: 's-1', previousEntities: ['entity-1'] },
        queryBudget: { maxLatencyMs: 800, maxCandidates: 20, rerankLimit: 10 },
      },
      requestId: 'r-compare',
      startTime: 123,
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner: { plan: vi.fn() },
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch,
    });

    expect(result.outcome).toBe('return');
    expect(decomposedSearch.execute).toHaveBeenCalledWith(
      ['Opus One', 'Screaming Eagle'],
      'compare',
      'Opus One vs Screaming Eagle',
      'r-compare',
      123,
      {
        context: { locale: 'ko-KR', currency: 'KRW' },
        sessionContext: { sessionId: 's-1', previousEntities: ['entity-1'] },
        queryBudget: { maxLatencyMs: 800, maxCandidates: 20, rerankLimit: 10 },
      },
      { abortSignal: expect.any(AbortSignal) },
    );
  });

  it('aborts decomposed search on timeout and continues with planner fallback', async () => {
    vi.useFakeTimers();

    const plan = {
      rawQuery: 'red wine',
      normalizedQuery: 'red wine',
      intent: 'facet_search' as const,
      route: 'hybrid' as const,
      retrievalMode: 'semantic_hybrid' as const,
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

    let receivedSignal: AbortSignal | undefined;
    const decomposedSearch = {
      execute: vi.fn().mockImplementation(async (
        _subQueries: [string, string],
        _comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
        _originalQuery: string,
        _requestId: string,
        _startTime: number,
        _parentContext: unknown,
        options?: { abortSignal?: AbortSignal },
      ) => {
        receivedSignal = options?.abortSignal;
        await new Promise<never>((_, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        throw new Error('unreachable');
      }),
    };

    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn(async () => plan),
    };

    const promise = runSearchPreRoutePhase({
      request: { query: 'Opus One vs Screaming Eagle' },
      requestId: 'r-timeout',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch,
    });

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.outcome).toBe('continue');
    expect(queryPlanner.plan).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
