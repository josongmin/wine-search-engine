import { describe, it, expect, vi } from 'vitest';
import { PlannerV1Adapter } from '../planner-v1-adapter.js';
import type { Planner } from '../../domain/query/service/planner.js';
import type { QueryPlanV2 } from '../../domain/query/model/query-plan.js';

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
