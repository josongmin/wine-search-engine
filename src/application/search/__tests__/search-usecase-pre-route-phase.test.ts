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
});
