import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConstraintSAT } from '../../../../src/domain/query/service/constraint-sat.js';
import { QuerySanitizer } from '../../../../src/domain/security/service/query-sanitizer.js';
import { runSearchPreRoutePhase } from '../../../../src/application/search/search-usecase-pre-route-phase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import type { QueryPlannerPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { ResponseBuilder } from '../../../../src/domain/response/service/response-builder.js';
import type { NormalizedConstraint } from '../../../../src/domain/shared/types/index.js';
import { buildRetrievalPlan } from '../../../../src/domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../../../src/domain/retrieval/model/retrieval-objective.js';
import { logSearchEvent } from '../../../../src/domain/observability/log-search-event.js';

vi.mock('../../../../src/domain/observability/log-search-event.js', () => ({
  logSearchEvent: vi.fn(),
}));

const mockedLogSearchEvent = vi.mocked(logSearchEvent);

function constraint(
  partial: Omit<NormalizedConstraint, 'source_phrase' | 'confidence'> &
    Partial<Pick<NormalizedConstraint, 'source_phrase' | 'confidence'>>,
): NormalizedConstraint {
  return {
    source_phrase: 'test',
    confidence: 0.9,
    ...partial,
  };
}

describe('runSearchPreRoutePhase', () => {
  beforeEach(() => {
    mockedLogSearchEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns continue with plan when pipeline reaches main search via explicit compiled-less seam', async () => {
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
      allowCompiledFallback: true,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.plan).toBe(plan);
    }
    expect(queryPlanner.plan).toHaveBeenCalled();
  });

  it('rebuilds compiled and admission context after merging structured filters', async () => {
    const plan = {
      rawQuery: 'red wine',
      normalizedQuery: 'red wine',
      intent: 'facet_search' as const,
      route: 'hybrid' as const,
      retrievalMode: 'attribute_search' as const,
      queryClass: 'unknown',
      anchors: [],
      constraints: {
        hard: [
          constraint({ attribute: 'wine_type', operator: '=', value: 'white' }),
          constraint({ attribute: 'country', operator: '=', value: 'France' }),
        ],
        soft: [],
        inferred: [],
      },
      expansions: { lexical: [], semantic: [] },
      policy: {} as QueryPlanV1['policy'],
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      admission_context: {
        requires_identity_seal: false,
        requires_constraint_evidence: true,
        requires_anchor_evidence: false,
      },
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
        retrievalPlan: buildRetrievalPlan(plan.constraints),
      },
      execution: {
        effectiveRoute: 'hybrid' as const,
        effectiveRetrievalMode: 'attribute_search' as const,
        routeSource: 'planner' as const,
        budget: { maxCandidates: 20, enablePrecisionRerank: true },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: true,
          requireAnchorEvidence: false,
        },
      },
    };

    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn(async () => plan),
      planWithCompiled: vi.fn(async () => ({ v1: plan, compiled })),
    };

    const result = await runSearchPreRoutePhase({
      request: {
        query: 'red wine',
        filters: [
          constraint({ attribute: 'wine_type', operator: '=', value: 'red' }),
        ],
        preferences: [
          constraint({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
        ],
      },
      requestId: 'r-filters',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.plan.constraints.hard).toEqual([
        constraint({ attribute: 'country', operator: '=', value: 'France' }),
        constraint({ attribute: 'wine_type', operator: '=', value: 'red' }),
      ]);
      expect(result.plan.constraints.soft).toEqual([
        constraint({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
      ]);
      expect(result.plan.admission_context).toEqual({
        requires_identity_seal: false,
        requires_constraint_evidence: true,
        requires_anchor_evidence: false,
      });
      expect(result.compiled.query.constraints.hard).toEqual(result.plan.constraints.hard);
      expect(result.compiled.query.retrievalPlan).toEqual(
        buildRetrievalPlan(result.plan.constraints),
      );
      expect(result.compiled.query.retrievalObjective).toEqual(
        buildRetrievalObjective(result.plan.constraints),
      );
      expect(result.compiled.query.retrievalObjective.signals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
        ]),
      );
      expect(result.compiled.execution.provenancePolicy.requireConstraintEvidence).toBe(true);
    }
  });

  it('promotes planner-chosen entity execution to recommendation when typed set-retrieval preferences exist', async () => {
    const plan = {
      rawQuery: '캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거',
      normalizedQuery: '캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거 camping wine',
      intent: 'entity_fuzzy' as const,
      route: 'entity' as const,
      retrievalMode: 'entity_resolution' as const,
      queryClass: 'ambiguous_short_form',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {} as QueryPlanV1['policy'],
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      admission_context: {
        requires_identity_seal: true,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
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
        retrievalPlan: buildRetrievalPlan(plan.constraints),
      },
      execution: {
        effectiveRoute: 'entity' as const,
        effectiveRetrievalMode: 'entity_resolution' as const,
        routeSource: 'planner' as const,
        budget: { maxCandidates: 10, rerankLimit: 0, enablePrecisionRerank: false },
        provenancePolicy: {
          requireIdentitySeal: true,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    };

    const result = await runSearchPreRoutePhase({
      request: {
        query: plan.rawQuery,
        preferences: [
          constraint({ attribute: 'closure', operator: '=', value: 'screw cap' }),
          constraint({ attribute: 'style', operator: 'in', value: ['chillable'] }),
          constraint({ attribute: 'occasion', operator: 'in', value: ['camping'] }),
        ],
      },
      requestId: 'r-structured-recommendation',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner: {
        plan: vi.fn(async () => plan),
        planWithCompiled: vi.fn(async () => ({ v1: plan, compiled })),
      },
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.plan.route).toBe('hybrid');
      expect(result.plan.retrievalMode).toBe('recommendation');
      expect(result.plan.admission_context?.requires_identity_seal).toBe(false);
      expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
      expect(result.compiled.execution.effectiveRetrievalMode).toBe('recommendation');
      expect(result.compiled.execution.budget).toEqual({
        maxCandidates: 20,
        rerankLimit: 20,
        enablePrecisionRerank: true,
      });
      expect(result.compiled.execution.provenancePolicy.requireIdentitySeal).toBe(false);
    }
  });

  it('does not override an explicit API route when structured preferences exist', async () => {
    const plan = {
      rawQuery: '샤또 마고',
      normalizedQuery: 'margaux',
      intent: 'entity_exact' as const,
      route: 'entity' as const,
      retrievalMode: 'entity_lookup' as const,
      queryClass: 'short_entity',
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
        effectiveRoute: 'entity' as const,
        effectiveRetrievalMode: 'entity_lookup' as const,
        routeSource: 'api_override' as const,
        budget: { maxCandidates: 10, rerankLimit: 0, enablePrecisionRerank: false },
        provenancePolicy: {
          requireIdentitySeal: true,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    };

    const result = await runSearchPreRoutePhase({
      request: {
        query: plan.rawQuery,
        preferences: [
          constraint({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
        ],
      },
      requestId: 'r-api-route-preserved',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner: {
        plan: vi.fn(async () => plan),
        planWithCompiled: vi.fn(async () => ({ v1: plan, compiled })),
      },
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.compiled.execution.effectiveRoute).toBe('entity');
      expect(result.compiled.execution.effectiveRetrievalMode).toBe('entity_lookup');
      expect(result.compiled.execution.routeSource).toBe('api_override');
    }
  });

  it('demotes representative concept identity constraints from hard gates to soft objectives', async () => {
    const baroloConstraint = constraint({
      attribute: 'appellation',
      operator: '=',
      value: 'Barolo',
      source_phrase: 'Barolo',
    });
    const plan = {
      rawQuery: 'Barolo wine',
      normalizedQuery: 'barolo wine',
      intent: 'facet_search' as const,
      route: 'hybrid' as const,
      retrievalMode: 'attribute_search' as const,
      queryClass: 'ambiguous_short_form',
      anchors: [],
      constraints: {
        hard: [baroloConstraint],
        soft: [],
        inferred: [],
      },
      expansions: { lexical: [], semantic: [] },
      policy: {} as QueryPlanV1['policy'],
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      admission_context: {
        requires_identity_seal: false,
        requires_constraint_evidence: true,
        requires_anchor_evidence: false,
      },
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
        retrievalPlan: buildRetrievalPlan(plan.constraints),
        retrievalObjective: buildRetrievalObjective(plan.constraints),
      },
      execution: {
        effectiveRoute: 'hybrid' as const,
        effectiveRetrievalMode: 'attribute_search' as const,
        routeSource: 'planner' as const,
        budget: { maxCandidates: 20, rerankLimit: 20, enablePrecisionRerank: true },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: true,
          requireAnchorEvidence: false,
        },
      },
      constraintGraph: {
        graphSchemaVersion: 'constraint_graph_v1' as const,
        origin: 'deterministic_from_atoms' as const,
        rootNodeId: 'root',
        nodes: [],
        edges: [],
        globalBudgets: {},
      },
    };

    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn(async () => plan),
      planWithCompiled: vi.fn(async () => ({ v1: plan, compiled })),
    };

    const result = await runSearchPreRoutePhase({
      request: {
        query: 'Barolo wine',
        representativeConcept: { field: 'appellation', value: 'Barolo' },
      },
      requestId: 'r-representative-concept',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.plan.constraints.hard).toEqual([]);
      expect(result.plan.constraints.soft).toEqual([baroloConstraint]);
      expect(result.plan.admission_context?.requires_constraint_evidence).toBe(false);
      expect(result.compiled.query.constraints.hard).toEqual([]);
      expect(result.compiled.query.constraints.soft).toEqual([baroloConstraint]);
      expect(result.compiled.execution.provenancePolicy.requireConstraintEvidence).toBe(false);
      expect(result.compiled.constraintGraph).toBeUndefined();
    }
  });

  it('rejects compiled-less fallback unless the explicit seam is enabled', async () => {
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

    await expect(runSearchPreRoutePhase({
      request: { query: 'red wine' },
      requestId: 'r-legacy',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    })).rejects.toThrow('Search pre-route requires QueryPlanner.planWithCompiled()');
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
    vi.useFakeTimers();
    vi.setSystemTime(223);

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
    expect(decomposedSearch.execute).toHaveBeenCalledTimes(1);
    const [
      subQueries,
      comparisonLegs,
      comparisonIntent,
      originalQuery,
      requestId,
      requestStartTimeMs,
      forwardedRequest,
      executionOptions,
    ] = decomposedSearch.execute.mock.calls[0] ?? [];
    expect(subQueries).toEqual(['Opus One', 'Screaming Eagle']);
    expect(comparisonLegs).toHaveLength(2);
    expect(comparisonLegs).toEqual([
      expect.objectContaining({
        rawQuery: 'Opus One',
        retrievalQuery: 'Opus One wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        canonicalConcept: 'Opus One',
      }),
      expect.objectContaining({
        rawQuery: 'Screaming Eagle',
        retrievalQuery: 'Screaming Eagle wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        canonicalConcept: 'Screaming Eagle',
      }),
    ]);
    expect(comparisonIntent).toBe('compare');
    expect(originalQuery).toBe('Opus One vs Screaming Eagle');
    expect(requestId).toBe('r-compare');
    expect(requestStartTimeMs).toBe(123);
    expect(forwardedRequest).toEqual({
      context: { locale: 'ko-KR', currency: 'KRW' },
      sessionContext: { sessionId: 's-1', previousEntities: ['entity-1'] },
      queryBudget: { maxLatencyMs: 800, maxCandidates: 20, rerankLimit: 10 },
    });
    expect(executionOptions).toEqual({ abortSignal: expect.any(AbortSignal) });
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
        _comparisonLegs: unknown,
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
      allowCompiledFallback: true,
    });

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.outcome).toBe('continue');
    expect(queryPlanner.plan).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('upgrades planner-soft price_band intent from entity route to hybrid recommendation route', async () => {
    const plan = {
      rawQuery: '가성비 좋은 와인',
      normalizedQuery: '가성비 좋은 와인',
      intent: 'facet_search' as const,
      route: 'entity' as const,
      retrievalMode: 'attribute_search' as const,
      queryClass: 'unknown',
      anchors: [],
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'price_band',
            operator: '=',
            value: 'budget',
            source_phrase: '가성비',
            confidence: 0.9,
            mapping_version: 'rule-based-v1.0',
          },
        ],
        inferred: [],
      },
      expansions: { lexical: [], semantic: [] },
      policy: {} as QueryPlanV1['policy'],
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    } as QueryPlanV1;
    const result = await runSearchPreRoutePhase({
      request: { query: '가성비 좋은 와인' },
      requestId: 'price-band-upgrade',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner: {
        plan: vi.fn().mockResolvedValue(plan),
        planWithCompiled: vi.fn().mockResolvedValue({
          v1: plan,
          compiled: {
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
              effectiveRoute: 'entity',
              effectiveRetrievalMode: 'attribute_search',
              routeSource: 'planner',
              budget: { maxCandidates: 20, enablePrecisionRerank: true },
              provenancePolicy: {
                requireIdentitySeal: false,
                requireConstraintEvidence: false,
                requireAnchorEvidence: false,
              },
            },
          },
        }),
      },
      responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(result.plan.route).toBe('hybrid');
    expect(result.plan.retrievalMode).toBe('recommendation');
    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('recommendation');
  });
});
