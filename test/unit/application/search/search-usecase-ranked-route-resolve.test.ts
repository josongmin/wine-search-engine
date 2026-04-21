import { describe, expect, it } from 'vitest';
import { buildRankedRouteResolveResult } from '../../../../src/application/search/search-usecase-ranked-route-resolve.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
    normalizedQuery: '와인 잘 모르는 사람한테 선물할 거 실패 없는 걸로',
    intent: 'pairing_search',
    route: 'hybrid',
    retrievalMode: 'recommendation',
    queryClass: 'semantic_preference',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'heuristic-v1.0',
  } as QueryPlanV1;
}

function makeRankedResult(
  entityId: string,
  canonicalLabel: string,
  finalScore: number,
): RankedResult {
  return {
    entityId: createEntityId(entityId),
    canonicalLabel,
    finalScore,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.5,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.5,
      availability: 1,
      uncertaintyPenalty: 0,
      giftSuitability: 0.5,
      beginnerSuitability: 0.5,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

describe('buildRankedRouteResolveResult', () => {
  it('uses candidate-set confidence for recommendation-style ranked routes', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('romanee-conti-2019', 'Romanee-Conti 2019', 0.3122959942365978),
      makeRankedResult('moet-brut', 'Moet Brut', 0.3121726279785977),
      makeRankedResult('cloudy-bay-2022', 'Cloudy Bay Sauvignon Blanc 2022', 0.311609788249404),
    ];

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      effectiveRetrievalMode: 'recommendation',
    });

    expect(result.decisionTrace.top1CalibratedScore).toBeCloseTo(0.3122959942365978, 10);
    expect(result.decisionTrace.decisionConfidenceC).toBeGreaterThan(0.35);
    expect(result.conformalSetSize).toBe(1);
  });

  it('keeps top-1 confidence semantics for entity-style ranked routes', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('opus-one-2018', 'Opus One 2018', 0.72),
      makeRankedResult('sassicaia-2018', 'Sassicaia 2018', 0.31),
    ];

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      effectiveRetrievalMode: 'entity_lookup',
    });

    expect(result.decisionTrace.decisionConfidenceC).toBeCloseTo(0.72, 10);
    expect(result.conformalSetSize).toBeGreaterThanOrEqual(1);
  });
});
