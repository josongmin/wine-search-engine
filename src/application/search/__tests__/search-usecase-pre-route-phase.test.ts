import { describe, expect, it, vi } from 'vitest';
import { runSearchPreRoutePhase } from '../search-usecase-pre-route-phase.js';
import type { SearchPreRoutePhaseContext } from '../search-usecase-pre-route-phase.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import { PolicyBlockedError } from '../../../domain/shared/error/policy-blocked.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/entity-id.js';

const HIGH_SENSORY_FIELD_AVAILABILITY = {
  appellation: { populatedDocCount: 8, totalDocCount: 10, populatedDocRatio: 0.8 },
  body: { populatedDocCount: 8, totalDocCount: 10, populatedDocRatio: 0.8 },
  sweetness: { populatedDocCount: 8, totalDocCount: 10, populatedDocRatio: 0.8 },
  acidity: { populatedDocCount: 8, totalDocCount: 10, populatedDocRatio: 0.8 },
  tannin: { populatedDocCount: 8, totalDocCount: 10, populatedDocRatio: 0.8 },
} as const;

const LOW_SENSORY_FIELD_AVAILABILITY = {
  appellation: { populatedDocCount: 8, totalDocCount: 10, populatedDocRatio: 0.8 },
  body: { populatedDocCount: 4, totalDocCount: 10, populatedDocRatio: 0.4 },
  sweetness: { populatedDocCount: 4, totalDocCount: 10, populatedDocRatio: 0.4 },
  acidity: { populatedDocCount: 4, totalDocCount: 10, populatedDocRatio: 0.4 },
  tannin: { populatedDocCount: 4, totalDocCount: 10, populatedDocRatio: 0.4 },
} as const;

/** Minimal V1 plan fixture. */
function makeV1Plan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'red wine',
    normalizedQuery: 'red wine',
    intent: 'search',
    additionalIntents: [],
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: { terms: [], confidence: 0 },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

/** Build a minimal pre-route-phase context with all ports as vi.fn() mocks. */
function makeBaseContext(
  overrides: Partial<SearchPreRoutePhaseContext> = {},
): SearchPreRoutePhaseContext {
  return {
    request: { query: 'red wine' },
    requestId: 'req-test-1',
    startTime: Date.now(),
    snapshotVersions: {
      modelVersions: {},
      indexVersions: {},
      featureFlags: {},
    },
    securityGateDeps: {
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'red wine' }),
      },
    },
    queryPlanner: {
      plan: vi.fn().mockResolvedValue(makeV1Plan()),
    },
    responseBuilder: {
      build: vi.fn(),
    } as never,
    constraintSAT: {
      check: vi.fn().mockReturnValue({ contradicted: false }),
    } as never,
    allowCompiledFallback: true,
    ...overrides,
  };
}

describe('runSearchPreRoutePhase – fallback path (plan() only, no planWithCompiled)', () => {
  it('builds a caller-controlled primitive plan without invoking the planner for general search', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan()),
    };
    const ctx = makeBaseContext({
      request: {
        query: 'smooth red wine',
        options: {
          mode: 'hybrid',
          explain: false,
          clarification: false,
        },
        callerInterpretation: {
          authority: 'caller',
          intent: 'semantic_discovery',
          queryClass: 'semantic_preference',
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(plannerWithoutCompiled.plan).not.toHaveBeenCalled();
    expect(result.plan.intent).toBe('semantic_discovery');
    expect(result.plan.queryClass).toBe('semantic_preference');
    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(result.compiled.execution.executionTopology).toBe('general_only');
    expect(result.compiled.execution.routeSource).toBe('api_override');
  });

  it('maps caller-controlled pairing intent onto recommendation retrieval mode', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan()),
    };
    const ctx = makeBaseContext({
      request: {
        query: '스테이크에 어울리는 와인',
        callerInterpretation: {
          authority: 'caller',
          intent: 'pairing_search',
          queryClass: 'semantic_preference',
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(plannerWithoutCompiled.plan).not.toHaveBeenCalled();
    expect(result.plan.intent).toBe('pairing_search');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('recommendation');
  });

  it('maps caller-controlled pure-constraint intent onto constraint_filter retrieval mode', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan()),
    };
    const ctx = makeBaseContext({
      request: {
        query: 'under $30 red wine from napa',
        filters: [
          {
            attribute: 'region',
            operator: '=',
            value: 'Napa Valley',
            source_phrase: 'napa',
            confidence: 1.0,
          },
        ],
        callerInterpretation: {
          authority: 'caller',
          intent: 'facet_search',
          queryClass: 'pure_constraint',
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(plannerWithoutCompiled.plan).not.toHaveBeenCalled();
    expect(result.plan.queryClass).toBe('pure_constraint');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('constraint_filter');
  });

  it('keeps caller-controlled entity requests on the planner path', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({
        route: 'entity',
        retrievalMode: 'entity_lookup',
      })),
    };
    const ctx = makeBaseContext({
      request: {
        query: 'Opus One 2018',
        options: {
          mode: 'entity',
          explain: false,
          clarification: false,
        },
        callerInterpretation: {
          authority: 'caller',
          intent: 'entity_exact',
          queryClass: 'exact_entity',
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    expect(plannerWithoutCompiled.plan).toHaveBeenCalledOnce();
  });

  it('builds a path-authoritative exact lookup plan without invoking the planner for lookup_wine primitives', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'ambiguous_short_form',
      })),
    };
    const ctx = makeBaseContext({
      request: {
        query: 'Opus One',
        primitiveRoute: 'lookup_wine',
        retrieval_mode: 'entity',
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(plannerWithoutCompiled.plan).not.toHaveBeenCalled();
    expect(result.plan.intent).toBe('entity_exact');
    expect(result.plan.queryClass).toBe('short_entity');
    expect(result.plan.retrievalMode).toBe('entity_lookup');
    expect(result.compiled.execution.effectiveRoute).toBe('entity');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('entity_lookup');
    expect(result.compiled.execution.executionTopology).toBe('entity_only');
    expect(result.compiled.execution.routeSource).toBe('api_override');
  });

  it('builds a path-authoritative similar_to_entity plan without invoking the planner (RFC-021 T-PSA-01)', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'semantic_preference',
      })),
    };
    const ctx = makeBaseContext({
      request: {
        query: 'opus one',
        primitiveRoute: 'similar_to_entity',
        anchorEntityId: createCanonicalEntityId('opus-one-2018'),
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    // DoD: similarity execution does NOT depend on planner heuristics.
    expect(plannerWithoutCompiled.plan).not.toHaveBeenCalled();
    expect(result.plan.queryClass).toBe('anchored_similarity');
    expect(result.plan.retrievalMode).toBe('similar_items');
    expect(result.plan.anchors[0]?.candidateEntityIds).toEqual([
      createCanonicalEntityId('opus-one-2018'),
    ]);
    expect(result.plan.policy.policyReasonCodes).toContain('SIMILAR_TO_ENTITY_PATH_AUTHORITY');
    expect(result.compiled.execution.effectiveRoute).toBe('mixed');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('similar_items');
    expect(result.compiled.execution.routeSource).toBe('api_override');
  });

  it('returns outcome=continue with a defined compiled when queryPlanner only has plan()', async () => {
    // Arrange: planner with only plan() — no planWithCompiled property
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({ route: 'hybrid', retrievalMode: 'attribute_search' })),
      // planWithCompiled is intentionally absent
    };

    const ctx = makeBaseContext({ queryPlanner: plannerWithoutCompiled });

    // Act
    const result = await runSearchPreRoutePhase(ctx);

    // Assert: took the fallback branch, outcome is 'continue'
    expect(result.outcome).toBe('continue');

    // Assert: compiled was reconstructed via compileFromLegacyPlan
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(result.compiled).toBeDefined();

    // Assert: effectiveRoute is a valid route string
    const validRoutes = ['entity', 'hybrid', 'mixed'] as const;
    expect(validRoutes).toContain(result.compiled.execution.effectiveRoute);

    // Assert: effectiveRetrievalMode is set and is a known mode
    expect(result.compiled.execution.effectiveRetrievalMode).toBeDefined();
    expect(['entity_lookup', 'attribute_search', 'similar_items', 'entity_resolution',
            'constraint_filter', 'producer_browse', 'region_browse', 'compare_candidates',
            'recommendation', 'no_match_detection']).toContain(result.compiled.execution.effectiveRetrievalMode);

    // Assert: budget is always set by the compiler
    expect(result.compiled.execution.budget).toBeDefined();

    // Assert: plan() was called (not planWithCompiled)
    expect(plannerWithoutCompiled.plan).toHaveBeenCalledOnce();
  });

  it('falls back to plan() when planWithCompiled is explicitly undefined', async () => {
    // Arrange: planner with planWithCompiled set to undefined
    const plannerWithUndefinedCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({ route: 'entity', retrievalMode: 'entity_lookup' })),
      planWithCompiled: undefined,
    };

    const ctx = makeBaseContext({ queryPlanner: plannerWithUndefinedCompiled });

    // Act
    const result = await runSearchPreRoutePhase(ctx);

    // Assert
    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(result.compiled).toBeDefined();

    const validRoutes = ['entity', 'hybrid', 'mixed'] as const;
    expect(validRoutes).toContain(result.compiled.execution.effectiveRoute);

    // Assert: effectiveRetrievalMode is set and is a known mode
    expect(result.compiled.execution.effectiveRetrievalMode).toBeDefined();
    expect(['entity_lookup', 'attribute_search', 'similar_items', 'entity_resolution',
            'constraint_filter', 'producer_browse', 'region_browse', 'compare_candidates',
            'recommendation', 'no_match_detection']).toContain(result.compiled.execution.effectiveRetrievalMode);

    // Assert: budget is always set by the compiler
    expect(result.compiled.execution.budget).toBeDefined();

    expect(plannerWithUndefinedCompiled.plan).toHaveBeenCalledOnce();
  });

  it('grants sensory soft-promotion authority only when runtime field coverage is available', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({
        constraints: {
          hard: [],
          soft: [{
            attribute: 'acidity',
            operator: '>=',
            value: 0.6,
            source_phrase: '상큼/산미',
            confidence: 0.8,
            mapping_version: 'rule-based-v1.0',
          }],
          inferred: [],
        },
      })),
    };

    const ctx = makeBaseContext({
      queryPlanner: plannerWithoutCompiled,
      fieldAvailability: HIGH_SENSORY_FIELD_AVAILABILITY,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(result.plan.constraints.soft[0]?.soft_promotion_authority).toBe('allow');
    expect(result.compiled.query.constraints.soft[0]?.soft_promotion_authority).toBe('allow');
  });

  it('strips sensory soft-promotion authority when runtime field coverage is below the capability gate', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({
        constraints: {
          hard: [],
          soft: [{
            attribute: 'acidity',
            operator: '>=',
            value: 0.6,
            source_phrase: 'acidity>=0.6',
            confidence: 1,
            soft_promotion_authority: 'allow',
            mapping_version: 'claude_tool_v1',
          }],
          inferred: [],
        },
      })),
    };

    const ctx = makeBaseContext({
      queryPlanner: plannerWithoutCompiled,
      fieldAvailability: LOW_SENSORY_FIELD_AVAILABILITY,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(result.plan.constraints.soft[0]?.soft_promotion_authority).toBeUndefined();
    expect(result.compiled.query.constraints.soft[0]?.soft_promotion_authority).toBeUndefined();
  });

  it('skips decomposed search when request latency budget is already exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T00:00:00.000Z'));

    const decomposedSearch = {
      execute: vi.fn(),
    };
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({ route: 'hybrid', retrievalMode: 'attribute_search' })),
    };

    const nowMs = Date.now();
    const ctx = makeBaseContext({
      request: {
        query: 'opus one vs dominus',
        queryBudget: {
          maxLatencyMs: 50,
          maxCandidates: 100,
          rerankLimit: 20,
        },
      },
      startTime: nowMs - 60,
      decomposedSearch,
      securityGateDeps: {
        querySanitizer: {
          sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'opus one vs dominus' }),
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    expect(decomposedSearch.execute).not.toHaveBeenCalled();
    expect(plannerWithoutCompiled.plan).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('caps decomposed search timeout to the remaining request budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T00:00:00.000Z'));

    const decomposedSearch = {
      execute: vi.fn().mockImplementation(
        async (
          _subQueries: [string, string],
          _comparisonLegs: unknown,
          _comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
          _originalQuery: string,
          _requestId: string,
          _startTime: number,
          _parentContext: unknown,
          options?: { abortSignal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            reject(new Error('decomposed_abort'));
          });
        }),
      ),
    };
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({ route: 'hybrid', retrievalMode: 'attribute_search' })),
    };

    const nowMs = Date.now();
    const ctx = makeBaseContext({
      request: {
        query: 'opus one vs dominus',
        queryBudget: {
          maxLatencyMs: 50,
          maxCandidates: 100,
          rerankLimit: 20,
        },
      },
      startTime: nowMs - 20,
      decomposedSearch,
      securityGateDeps: {
        querySanitizer: {
          sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'opus one vs dominus' }),
        },
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const resultPromise = runSearchPreRoutePhase(ctx);

    await vi.advanceTimersByTimeAsync(29);
    expect(decomposedSearch.execute).toHaveBeenCalledOnce();
    const options = decomposedSearch.execute.mock.calls[0]?.[7] as { abortSignal?: AbortSignal } | undefined;
    expect(options?.abortSignal?.aborted).toBe(false);
    expect(plannerWithoutCompiled.plan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.outcome).toBe('continue');
    expect(options?.abortSignal?.aborted).toBe(true);
    expect(plannerWithoutCompiled.plan).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('promotes planner entity route to hybrid recommendation when structured set filters are present', async () => {
    const plannerWithoutCompiled = {
      plan: vi.fn().mockResolvedValue(makeV1Plan({
        route: 'entity',
        retrievalMode: 'entity_lookup',
        constraints: { hard: [], soft: [], inferred: [] },
      })),
    };

    const ctx = makeBaseContext({
      request: {
        query: 'Bordeaux wine',
        filters: [
          {
            attribute: 'region',
            operator: '=',
            value: 'Bordeaux',
            source_phrase: 'Bordeaux',
            confidence: 1,
            mapping_version: 'test',
          },
        ],
      },
      queryPlanner: plannerWithoutCompiled,
    });

    const result = await runSearchPreRoutePhase(ctx);

    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') throw new Error('narrowing guard');
    expect(result.plan.route).toBe('hybrid');
    expect(result.plan.retrievalMode).toBe('recommendation');
    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('recommendation');
    expect(result.compiled.execution.budget.enablePrecisionRerank).toBe(true);
  });

  it('fail-closes on Layer 2 timeout without waiting for pre-route planner work to finish', async () => {
    vi.useFakeTimers();

    const neverResolvingPlanner = {
      plan: vi.fn().mockImplementation(
        () => new Promise<QueryPlanV1>(() => {
          // Intentionally never resolves: reproduces planner / alias lookup
          // work that ignores cancellation after the security gate blocks.
        }),
      ),
    };

    const ctx = makeBaseContext({
      queryPlanner: neverResolvingPlanner,
      securityGateDeps: {
        querySanitizer: {
          sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'red wine' }),
        },
        injectionJudge: {
          judge: vi.fn().mockImplementation(
            () => new Promise<boolean>(() => {
              // Never resolves; Layer 2 timeout must fail-close the request
              // without waiting for the planner promise above.
            }),
          ),
        },
        judgeFailureMode: 'fail_closed',
        judgeTimeoutMs: 5_000,
      },
    });

    const blockedExpectation = expect(runSearchPreRoutePhase(ctx)).rejects.toBeInstanceOf(PolicyBlockedError);
    await vi.advanceTimersByTimeAsync(5_000);

    await blockedExpectation;
    expect(neverResolvingPlanner.plan).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});
