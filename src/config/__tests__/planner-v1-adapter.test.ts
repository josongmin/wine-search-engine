import { describe, it, expect, vi } from 'vitest';
import { PlannerV1Adapter } from '../planner-v1-adapter.js';
import type { Planner } from '../../domain/query/service/planner.js';
import type { QueryPlanV2 } from '../../domain/query/model/query-plan.js';
import type { PlanWithCompiledResult } from '../../application/search/port/search-pipeline-deps.port.js';

/** Minimal V2 plan fixture. */
function makeV2Plan(overrides: Partial<QueryPlanV2> = {}): QueryPlanV2 {
  return {
    rawQuery: 'Barolo vs Amarone',
    normalizedQuery: 'barolo vs amarone',
    intent: 'comparison_search',
    suggestedRoute: 'entity',
    suggestedRetrievalMode: 'compare_candidates',
    queryClass: 'comparison_query',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    uncertainty: {
      overall: 0.15,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 0.85,
      constraintConfidence: 0.9,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

describe('PlannerV1Adapter', () => {
  it('preserves decompositionHint when the V2 plan carries one', async () => {
    const v2WithHint = makeV2Plan({
      decompositionHint: {
        strategy: 'comparison',
        subQueryCount: 2,
        confidence: 0.9,
        reason: 'comparison:compare',
      },
    });

    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2WithHint),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const v1 = await adapter.plan('Barolo vs Amarone');

    expect(v1.decompositionHint).toBeDefined();
    expect(v1.decompositionHint?.strategy).toBe('comparison');
    expect(v1.decompositionHint?.subQueryCount).toBe(2);
    expect(v1.decompositionHint?.confidence).toBe(0.9);
  });

  it('omits decompositionHint when the V2 plan has none', async () => {
    const v2WithoutHint = makeV2Plan(); // no decompositionHint

    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2WithoutHint),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const v1 = await adapter.plan('Barolo');

    expect(v1.decompositionHint).toBeUndefined();
    // Exact-optional semantics: the key must not be present at all.
    expect('decompositionHint' in v1).toBe(false);
  });

  it('maps suggestedRoute → route and suggestedRetrievalMode → retrievalMode', async () => {
    const v2 = makeV2Plan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
    });

    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const v1 = await adapter.plan('red wine under $30');

    expect(v1.route).toBe('hybrid');
    expect(v1.retrievalMode).toBe('attribute_search');
    // V1 must NOT carry the V2-only fields.
    expect('suggestedRoute' in v1).toBe(false);
    expect('suggestedRetrievalMode' in v1).toBe(false);
  });
});

describe('planWithCompiled', () => {
  it('returns both v1 and compiled fields', async () => {
    const v2 = makeV2Plan();
    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const result: PlanWithCompiledResult = await adapter.planWithCompiled('Barolo vs Amarone');

    expect(result).toHaveProperty('v1');
    expect(result).toHaveProperty('compiled');
    expect(result.compiled.execution.effectiveRetrievalMode).toBeDefined();
  });

  it('compiled.execution.effectiveRoute is set (not undefined)', async () => {
    const v2 = makeV2Plan({ suggestedRoute: 'entity', suggestedRetrievalMode: 'entity_lookup' });
    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const result = await adapter.planWithCompiled('Barolo');

    expect(result.compiled.execution.effectiveRoute).toBeDefined();
    expect(result.compiled.execution.effectiveRoute).toBe('entity');
  });

  it('compiled.execution.effectiveRetrievalMode is set', async () => {
    const v2 = makeV2Plan({ suggestedRoute: 'hybrid', suggestedRetrievalMode: 'attribute_search' });
    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const result = await adapter.planWithCompiled('red wine under $30');

    expect(result.compiled.execution.effectiveRetrievalMode).toBeDefined();
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('attribute_search');
  });

  it('v1 result matches what plan() returns for the same query', async () => {
    const v2 = makeV2Plan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      intent: 'search',
    });
    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const [planResult, compiledResult] = await Promise.all([
      adapter.plan('red wine under $30'),
      adapter.planWithCompiled('red wine under $30'),
    ]);

    // v1 from planWithCompiled must carry the same route/mode as plan().
    expect(compiledResult.v1.route).toBe(planResult.route);
    expect(compiledResult.v1.retrievalMode).toBe(planResult.retrievalMode);
    expect(compiledResult.v1.intent).toBe(planResult.intent);
    expect(compiledResult.v1.rawQuery).toBe(planResult.rawQuery);
  });

  it('hybrid-forced modes cause effectiveRoute to be hybrid regardless of suggestedRoute', async () => {
    // compare_candidates is a HYBRID_FORCED_MODE — should always compile to hybrid route.
    const v2 = makeV2Plan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'compare_candidates',
    });
    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const result = await adapter.planWithCompiled('Barolo vs Amarone');

    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('compare_candidates');
    expect(result.compiled.execution.routeSource).toBe('planner');
  });

  it('forces effectiveRoute to hybrid for recommendation mode regardless of suggestedRoute', async () => {
    // recommendation is a HYBRID_FORCED_MODE — should always compile to hybrid route
    // even when the planner suggests entity. Regression guard for the HYBRID_FORCED bug.
    const v2 = makeV2Plan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'recommendation',
    });
    const mockPlanner: Planner = {
      plan: vi.fn().mockResolvedValue(v2),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);
    const result = await adapter.planWithCompiled('recommend me a Burgundy');

    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('recommendation');
    // route is forced to hybrid but the retrieval mode itself stays recommendation
  });

  it('propagates planner errors from planWithCompiled', async () => {
    const mockPlanner: Planner = {
      plan: vi.fn().mockRejectedValue(new Error('planner timeout')),
    };

    const adapter = new PlannerV1Adapter(mockPlanner);

    await expect(adapter.planWithCompiled('anything')).rejects.toThrow('planner timeout');
  });
});
