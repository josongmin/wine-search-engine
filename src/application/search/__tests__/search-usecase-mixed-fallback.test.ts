import { describe, expect, it } from 'vitest';
import {
  buildMixedConstraintFallbackExecution,
  buildMixedHybridFallbackExecution,
} from '../search.usecase.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../domain/query/model/compiled-wine-query.js';
import type { SearchRouteExecutionResult } from '../search-usecase-route-dispatch.js';
import type { MixedQueryResult } from '../../../domain/mixed/model/mixed-query-result.js';

function makePlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'Barolo red under $150',
    normalizedQuery: 'barolo red under $150',
    intent: 'mixed_query',
    route: 'mixed',
    retrievalMode: 'similar_items',
    queryClass: 'anchored_similarity',
    anchors: [{
      surfaceForm: 'barolo',
      normalizedForm: 'barolo',
      candidateEntityIds: ['wine-ce-anchor'] as never,
      lookupVariants: ['barolo'],
      confidence: 0.95,
      source: 'alias',
    }],
    constraints: {
      hard: [{
        attribute: 'wine_type',
        operator: 'eq',
        value: 'red',
        source_phrase: 'red',
        confidence: 0.95,
        mapping_version: 'test',
      }],
      soft: [],
      inferred: [],
    },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 0.95,
      constraintConfidence: 0.95,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
    admission_context: {
      requires_identity_seal: true,
      requires_constraint_evidence: true,
      requires_anchor_evidence: true,
    },
    retrievalPlan: { hardFilters: [], optionalBoosts: [] } as never,
    retrievalObjective: { hardConstraintCount: 1 } as never,
    ...overrides,
  } as QueryPlanV1;
}

function makeCompiled(plan: QueryPlanV1): CompiledWineQuery {
  return {
    query: {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      intent: plan.intent,
      queryClass: plan.queryClass,
      anchors: plan.anchors,
      constraints: plan.constraints,
      expansions: plan.expansions,
      uncertainty: plan.uncertainty,
      retrievalPlan: plan.retrievalPlan,
      retrievalObjective: plan.retrievalObjective,
    } as never,
    execution: {
      effectiveRoute: 'mixed',
      effectiveRetrievalMode: 'similar_items',
      executionTopology: 'general_only',
      routeSource: 'planner',
      budget: { maxCandidates: 50, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: true,
        requireAnchorEvidence: true,
      },
    },
  };
}

describe('mixed fallback helpers', () => {
  it('rebuilds fallback plan and compiled objective on the pure-constraint authority path', () => {
    const plan = makePlan();
    const compiled = makeCompiled(plan);

    const fallback = buildMixedConstraintFallbackExecution(plan, compiled);

    expect(fallback.plan.queryClass).toBe('pure_constraint');
    expect(fallback.plan.intent).toBe('facet_search');
    expect(fallback.plan.route).toBe('hybrid');
    expect(fallback.plan.retrievalMode).toBe('constraint_filter');
    expect(fallback.plan.anchors).toEqual([]);
    expect(fallback.compiled.query.queryClass).toBe('pure_constraint');
    expect(fallback.compiled.query.retrievalPlan).not.toBe(compiled.query.retrievalPlan);
    expect(fallback.compiled.query.retrievalObjective).not.toBe(compiled.query.retrievalObjective);
    expect(fallback.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(fallback.compiled.execution.effectiveRetrievalMode).toBe('constraint_filter');
  });

  it('expands anchored white fallback constraints to the white-family filter set', () => {
    const plan = makePlan({
      rawQuery: '클라우디베이 말고 다른 화이트',
      normalizedQuery: '클라우디베이 말고 다른 화이트',
      constraints: {
        hard: [{
          attribute: 'wine_type',
          operator: '=',
          value: 'white',
          source_phrase: '화이트',
          confidence: 0.95,
          mapping_version: 'test',
        }],
        soft: [],
        inferred: [],
      },
    });
    const compiled = makeCompiled(plan);

    const fallback = buildMixedConstraintFallbackExecution(plan, compiled);

    expect(fallback.plan.constraints.hard).toEqual([
      expect.objectContaining({
        attribute: 'wine_type',
        operator: 'in',
        value: ['white', 'dessert'],
      }),
    ]);
    expect(fallback.compiled.query.constraints.hard).toEqual([
      expect.objectContaining({
        attribute: 'wine_type',
        operator: 'in',
        value: ['white', 'dessert'],
      }),
    ]);
  });

  it('keeps the executed fallback plan authoritative when mixed route recovers via hybrid fallback', () => {
    const fallbackPlan = makePlan({
      intent: 'facet_search',
      route: 'hybrid',
      retrievalMode: 'constraint_filter',
      queryClass: 'pure_constraint',
      anchors: [],
    });
    const fallbackCompiled: CompiledWineQuery = {
      ...makeCompiled(fallbackPlan),
      execution: {
        ...makeCompiled(fallbackPlan).execution,
        effectiveRoute: 'hybrid',
        effectiveRetrievalMode: 'constraint_filter',
      },
    };

    const hybridFallback: SearchRouteExecutionResult = {
      executedPlan: fallbackPlan,
      executedCompiled: fallbackCompiled,
      executionTopology: 'general_only',
      identityResolveResult: null,
      fusedResolveResult: {
        status: 'resolved',
        topEntity: {
          entityId: 'wine-ce-candidate' as never,
          canonicalLabel: 'Candidate',
          calibratedScore: 0.82,
        },
        candidates: [],
        decisionConfidenceC: 0.82,
        decisionTrace: {
          queryClass: 'pure_constraint',
          top1CalibratedScore: 0.82,
          top2CalibratedScore: 0.4,
          calibratedGap: 0.42,
          decisionConfidenceC: 0.82,
          calibrationTrusted: false,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
          outcomeReasonCodes: ['HYBRID_ROUTE'],
        },
        conformalSetSize: 1,
      },
      laneArtifacts: { identity: [], general: [], fused: [] },
      laneTrace: {
        identity: { participated: false, artifactCount: 0 },
        general: { participated: true, artifactCount: 0 },
        fused: { participated: true, artifactCount: 0, resolveStatus: 'resolved' },
      },
      rankedResults: [
        { entityId: 'wine-ce-anchor', canonicalLabel: 'Anchor', finalScore: 0.95 } as never,
        { entityId: 'wine-ce-candidate', canonicalLabel: 'Candidate', finalScore: 0.82 } as never,
      ],
      effectiveRetrievalMode: 'constraint_filter',
      retrievalKind: 'generic_hybrid',
      sparseExecuted: true,
      specializedRouteExecuted: null,
      usedCompiledExecution: true,
    };
    const mixedResult: MixedQueryResult = {
      anchor: {
        entityId: 'wine-ce-anchor' as never,
        canonicalLabel: 'Anchor',
        anchorConfidence: 0.94,
      },
      rankedResults: [],
    } as MixedQueryResult;

    const recovered = buildMixedHybridFallbackExecution(
      fallbackPlan,
      mixedResult,
      hybridFallback,
    );

    expect(recovered.executedPlan.queryClass).toBe('pure_constraint');
    expect(recovered.executedCompiled.execution.effectiveRoute).toBe('hybrid');
    expect(recovered.fusedResolveResult.decisionTrace.queryClass).toBe('pure_constraint');
    expect(recovered.rankedResults.map((result) => result.entityId)).toEqual(['wine-ce-candidate']);
  });
});
