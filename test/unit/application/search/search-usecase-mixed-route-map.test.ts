import { describe, it, expect } from 'vitest';
import {
  buildFailedMixedRouteExecution,
  mixedQueryResultToSearchRouteExecution,
} from '../../../../src/application/search/search-usecase-mixed-route.js';
import type { MixedQueryResult } from '../../../../src/domain/mixed/model/mixed-query-result.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import { MIXED_FALLBACK_REASONS } from '../../../../src/domain/mixed/model/mixed-degradation.js';

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

function minimalCompiled(): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'q',
      normalizedQuery: 'q',
      intent: 'mixed_query',
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
      effectiveRoute: 'mixed',
      effectiveRetrievalMode: 'similar_items',
      routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: false,
        requireAnchorEvidence: true,
      },
    },
  };
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
      routeDegradation: {
        executionMode: 'degraded',
        degradationReasons: ['mixed_similar_retrieval_fallback'],
      },
      fallbackReason: 'mixed_similar_retrieval_fallback',
    };
    const out = mixedQueryResultToSearchRouteExecution(plan, mixedResult, minimalCompiled());
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
    expect(out.routeDegradation).toEqual({
      executionMode: 'degraded',
      degradationReasons: ['mixed_similar_retrieval_fallback'],
    });
    expect(out.fallbackReason).toBe('mixed_similar_retrieval_fallback');
    expect(out.resolveResult.decisionTrace.outcomeReasonCodes).toContain('MIXED_ROUTE');
  });

  it('keeps the mixed fallback taxonomy stable', () => {
    expect(MIXED_FALLBACK_REASONS).toMatchInlineSnapshot(`
      [
        "mixed_anchor_resolution_failed",
        "mixed_similar_retrieval_unavailable",
        "mixed_similar_retrieval_fallback",
        "mixed_ranker_unavailable",
        "mixed_constraint_overlay_failed",
      ]
    `);
  });

  it('builds a structured failed mixed-route execution for anchor degradation', () => {
    const out = buildFailedMixedRouteExecution(
      minimalPlan(),
      'mixed_anchor_resolution_failed',
      minimalCompiled(),
    );

    expect(out.rankedResults).toEqual([]);
    expect(out.routeDegradation).toEqual({
      executionMode: 'degraded',
      degradationReasons: ['mixed_anchor_resolution_failed'],
    });
    expect(out.fallbackReason).toBe('mixed_anchor_resolution_failed');
    expect(out.resolveResult.status).toBe('failed');
    expect(out.resolveResult.degradation?.reasons).toEqual(['mixed_anchor_resolution_failed']);
  });
});
