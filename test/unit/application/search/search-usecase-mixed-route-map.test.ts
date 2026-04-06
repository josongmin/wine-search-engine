import { describe, it, expect } from 'vitest';
import { mixedQueryResultToSearchRouteExecution } from '../../../../src/application/search/search-usecase-mixed-route.js';
import type { MixedQueryResult } from '../../../../src/domain/mixed/model/mixed-query-result.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'mixed_query',
    route: 'mixed',
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

describe('mixedQueryResultToSearchRouteExecution', () => {
  it('maps mixed solver output to dispatch shape', () => {
    const plan = minimalPlan();
    const eid = createEntityId();
    const resultEid = createEntityId('result-1');
    const mixedResult: MixedQueryResult = {
      anchor: {
        entityId: eid,
        canonicalLabel: 'Wine',
        region: 'Napa',
        grapes: ['Cabernet'],
        body: 3,
        sweetness: 2,
        style: 'bold',
        anchorConfidence: 0.88,
      },
      rankedResults: [
        {
          entityId: resultEid,
          canonicalLabel: 'Result Wine',
          finalScore: 0.64,
          rank: 1,
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.64,
            hardConstraintPass: true,
            softConstraint: 0.4,
            attributeAlignment: 0.3,
            preferenceAlignment: 0.2,
            popularity: 0.1,
            availability: 1,
            uncertaintyPenalty: 0,
          },
          evidenceItems: [],
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
        },
      ],
      constraintOverlay: { hard: [], soft: [], inferred: [] },
      anchorPreservationRate: 1,
    };
    const out = mixedQueryResultToSearchRouteExecution(plan, mixedResult);
    expect(out.rankedResults).toHaveLength(1);
    expect(out.resolveResult.decisionConfidenceC).toBe(0.64);
    expect(out.resolveResult.topEntity).toEqual({
      entityId: resultEid,
      canonicalLabel: 'Result Wine',
      calibratedScore: 0.64,
    });
    expect(out.decisionContext?.mixedAnchor).toEqual({
      entityId: eid,
      canonicalLabel: 'Wine',
      confidence: 0.88,
    });
    expect(out.resolveResult.decisionTrace.outcomeReasonCodes).toContain('MIXED_ROUTE');
  });
});
