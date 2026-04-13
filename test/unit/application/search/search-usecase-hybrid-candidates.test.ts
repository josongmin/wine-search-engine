import { describe, expect, it, vi } from 'vitest';
import { retrieveHybridCandidatesForPlan } from '../../../../src/application/search/search-usecase-hybrid-candidates.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'bordeaux producer',
    normalizedQuery: 'bordeaux producer',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'known_item',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
    ...overrides,
  } as QueryPlanV1;
}

function buildCompiled(
  plan: QueryPlanV1,
  overrides: Partial<CompiledWineQuery['execution']> = {},
): CompiledWineQuery {
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
      plannerVersion: plan.plannerVersion,
      policyRuleVersion: plan.policyRuleVersion,
      thresholdProfileId: plan.thresholdProfileId,
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: {
        maxCandidates: 25,
        enablePrecisionRerank: true,
      },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
      ...overrides,
    },
  };
}

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: createEntityId('wine-1'),
    canonicalLabel: 'Wine One',
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: ['wine'],
      semanticQueriesUsed: ['wine'],
      filtersApplied: [],
      candidateSources: ['sparse'],
    },
    ...overrides,
  };
}

function failedResolveResult(): EntityResolveResult {
  return {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: 'known_item',
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 0,
  };
}

describe('retrieveHybridCandidatesForPlan', () => {
  it('projects retrieval provenance coverage and shortfall on the generic candidate-pool path', async () => {
    const plan = minimalPlan({
      constraints: {
        hard: [{
          attribute: 'region',
          operator: '=',
          value: 'Bordeaux',
          source_phrase: 'Bordeaux',
          confidence: 0.95,
        }],
        soft: [],
        inferred: [],
      },
    });
    const compiled = buildCompiled(plan, {
      effectiveRetrievalMode: 'attribute_search',
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: true,
        requireAnchorEvidence: false,
      },
    });
    const candidatePool = {
      execute: vi.fn().mockResolvedValue([
        makeCandidate({
          matchedConstraints: [],
        }),
      ]),
    };

    const result = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: candidatePool as never,
      },
      async () => failedResolveResult(),
      compiled,
    );

    expect(result.effectiveRetrievalMode).toBe('attribute_search');
    expect(result.retrievalKind).toBe('generic_hybrid');
    expect(result.sparseExecuted).toBe(true);
    expect(result.usedCompiledExecution).toBe(true);
    expect(result.retrievalProvenanceCoverage).toEqual({
      candidateCount: 1,
      identityEvidenceSatisfied: true,
      constraintEvidenceSatisfied: false,
      anchorEvidenceSatisfied: true,
      matchedConstraintAttributes: [],
      unmetConstraintAttributes: ['region'],
      anchorSignalTypes: [],
    });
    expect(result.routeDegradation?.degradationReasons).toContain(
      'retrieval_provenance_shortfall:constraint_evidence',
    );
  });

  it('marks specialized browse retrieval as non-sparse while preserving provenance coverage', async () => {
    const plan = minimalPlan({
      retrievalMode: 'producer_browse',
      anchors: [{
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: [createEntityId('wine-anchor')],
        confidence: 0.99,
      }],
    });
    const compiled = buildCompiled(plan, {
      effectiveRetrievalMode: 'producer_browse',
      provenancePolicy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    });
    const browseRetriever = {
      browseProducer: vi.fn().mockResolvedValue([
        makeCandidate({
          retrievalProvenance: {
            channels: ['sparse'],
            protectedInclusionReason: 'exact_alias_match',
          },
        }),
      ]),
    };

    const result = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: { generate: vi.fn() } as never,
        browseRetriever: browseRetriever as never,
      },
      async () => failedResolveResult(),
      compiled,
    );

    expect(browseRetriever.browseProducer).toHaveBeenCalledWith(
      'Opus One',
      plan.constraints,
      20,
    );
    expect(result.effectiveRetrievalMode).toBe('producer_browse');
    expect(result.retrievalKind).toBe('specialized_hybrid');
    expect(result.sparseExecuted).toBe(false);
    expect(result.usedCompiledExecution).toBe(true);
    expect(result.specializedRouteObservability).toEqual({
      specializedRouteRequested: 'producer_browse',
      specializedRouteExecuted: 'producer_browse',
      fallbackApplied: false,
    });
    expect(result.retrievalProvenanceCoverage).toEqual({
      candidateCount: 1,
      identityEvidenceSatisfied: true,
      constraintEvidenceSatisfied: true,
      anchorEvidenceSatisfied: true,
      matchedConstraintAttributes: [],
      unmetConstraintAttributes: [],
      anchorSignalTypes: [],
    });
    expect(result.routeDegradation).toBeUndefined();
  });
});
