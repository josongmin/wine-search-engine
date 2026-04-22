import { describe, expect, it, vi } from 'vitest';
import { runSearchPreRoutePhase } from '../search-usecase-pre-route-phase.js';
import type { SearchPreRoutePhaseContext } from '../search-usecase-pre-route-phase.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';

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
});
