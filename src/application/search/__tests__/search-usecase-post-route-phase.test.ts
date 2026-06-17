import { describe, expect, it, vi } from 'vitest';
import {
  runSearchPostRoutePhase,
  selectDisplayRankedResultsForDecision,
} from '../search-usecase-post-route-phase.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { CompiledWineQuery } from '../../../domain/query/model/compiled-wine-query.js';
import type { RankedResult } from '../../../domain/ranking/model/ranked-result.js';

function makeTestCompiled(): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'q', normalizedQuery: 'q', intent: 'semantic_discovery',
      queryClass: 'unknown', anchors: [], constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] }, uncertainty: {} as never,
      plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      retrievalPlan: { hardFilterTokens: [], softBoosts: [], inferredBoosts: [], sensoryPriors: [], planVersion: 'retrieval-plan-v1.0' },
    },
    execution: {
      effectiveRoute: 'hybrid', effectiveRetrievalMode: 'attribute_search', routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
    },
  } as CompiledWineQuery;
}

const GENERIC_HYBRID_EXECUTION_FACTS = {
  effectiveRetrievalMode: 'attribute_search',
  retrievalKind: 'generic_hybrid',
  sparseExecuted: true,
  specializedRouteExecuted: null,
  usedCompiledExecution: false,
} as const;

const ENTITY_ROUTE_EXECUTION_FACTS = {
  effectiveRetrievalMode: 'entity_lookup',
  retrievalKind: 'entity_lookup',
  sparseExecuted: false,
  specializedRouteExecuted: null,
  usedCompiledExecution: false,
} as const;

const SPECIALIZED_HYBRID_EXECUTION_FACTS = {
  effectiveRetrievalMode: 'region_browse',
  retrievalKind: 'specialized_hybrid',
  sparseExecuted: false,
  specializedRouteExecuted: 'region_browse',
  usedCompiledExecution: false,
} as const;

const EMPTY_LANE_ARTIFACTS = {
  identity: [],
  general: [],
  fused: [],
} as const;

const minimalResolveResult: EntityResolveResult = {
  status: 'ambiguous',
  candidates: [],
  conformalSetSize: 1,
  decisionTrace: {
    queryClass: 'short_entity',
    top1CalibratedScore: 0,
    top2CalibratedScore: 0,
    calibratedGap: 0,
    decisionConfidenceC: 0,
    ambiguityDetected: false,
    ambiguityTypes: [],
    appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
    outcomeReasonCodes: [],
  },
};

describe('runSearchPostRoutePhase', () => {
  it('limits resolved entity-lookup display results to the selected identity', () => {
    const rankedResults = [
      { entityId: 'wine-top', canonicalLabel: 'Château Margaux', finalScore: 1 },
      { entityId: 'wine-tail', canonicalLabel: 'Pavillon Rouge du Château Margaux', finalScore: 0.2 },
    ] as unknown as readonly RankedResult[];

    const selected = selectDisplayRankedResultsForDecision(
      rankedResults,
      {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        decisionConfidence: 1,
        confidenceSemantics: 'calibrated_decision_confidence',
        selectedEntity: {
          entityId: 'wine-top' as never,
          canonicalLabel: 'Château Margaux',
          identity_signature: 'sig',
          snapshot_ref: 'snapshot',
        },
        signalSet: {},
        evidenceItems: [],
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
        decisionTrace: {} as never,
      },
      'entity_lookup',
    );

    expect(selected).toEqual([rankedResults[0]]);
  });

  describe('selectDisplayRankedResultsForDecision: entity_lookup contract', () => {
    const baseSnapshot = {
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1',
      threshold_profile_id: 'default',
      planner_version: '1',
      feature_flags: {},
    } as const;
    const baseDecisionShape = {
      decisionConfidence: 0,
      confidenceSemantics: 'calibrated_decision_confidence' as const,
      signalSet: {} as never,
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: baseSnapshot,
      decisionTrace: {} as never,
    };
    const twoRanked = [
      { entityId: 'wine-top', canonicalLabel: 'Château Margaux 2015', finalScore: 0.7 },
      { entityId: 'wine-tail', canonicalLabel: 'Château Margaux 2014', finalScore: 0.5 },
    ] as unknown as readonly RankedResult[];

    it('slices to top-1 closest-miss when decisionStatus is failed (lookup caller still sees the candidate, status conveys correctness)', () => {
      const selected = selectDisplayRankedResultsForDecision(
        twoRanked,
        {
          ...baseDecisionShape,
          decisionStatus: 'failed',
          nextAction: 'fail',
          failureReason: 'HARD_CONSTRAINT_VIOLATION',
        },
        'entity_lookup',
      );
      expect(selected).toEqual([twoRanked[0]]);
    });

    it('slices to top-1 when decisionStatus is ambiguous (clarification info travels separately in the payload)', () => {
      const selected = selectDisplayRankedResultsForDecision(
        twoRanked,
        {
          ...baseDecisionShape,
          decisionStatus: 'ambiguous',
          nextAction: 'clarify',
        },
        'entity_lookup',
      );
      expect(selected).toEqual([twoRanked[0]]);
    });

    it('returns empty when there are no ranked results', () => {
      const selected = selectDisplayRankedResultsForDecision(
        [],
        {
          ...baseDecisionShape,
          decisionStatus: 'failed',
          nextAction: 'fail',
        },
        'entity_lookup',
      );
      expect(selected).toEqual([]);
    });

    it('does NOT slice for non-entity_lookup retrievalKind (preserves existing hybrid behaviour)', () => {
      const selected = selectDisplayRankedResultsForDecision(
        twoRanked,
        {
          ...baseDecisionShape,
          decisionStatus: 'ambiguous',
          nextAction: 'clarify',
        },
        'generic_hybrid',
      );
      expect(selected).toEqual(twoRanked);
    });

    it('falls back to rankedResults[0] when resolved decision lacks selectedEntity/chosenEntityId', () => {
      const selected = selectDisplayRankedResultsForDecision(
        twoRanked,
        {
          ...baseDecisionShape,
          decisionStatus: 'resolved',
          nextAction: 'return_result',
        },
        'entity_lookup',
      );
      expect(selected).toEqual([twoRanked[0]]);
    });
  });

  it('bypasses entropy-abstain deflection when retrievalKind=entity_lookup AND options.clarification=false AND rankedResults non-empty (lookup contract: "direct answer, not a did-you-mean")', async () => {
    const evaluate = vi.fn().mockReturnValue({
      shouldAbstain: true,
      reason: 'low_confidence',
      detail: 'entropy=0.99',
      recoverableBy: 'clarify',
      entropy: 0.99,
    });
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.6,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-closest',
        canonicalLabel: 'Château Margaux 2015',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-closest',
      candidates: [],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0,
        semantic_relevance_score: 0.6,
        preference_alignment_score: 0,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: { queryClass: 'short_entity', effectiveRoute: 'entity', policy: { requireExact: false, allowApproximate: true, requireClarification: false, fallbackMode: 'clarify' } },
        signals: { decisionConfidence: 0.6, calibratedGap: 0.1, ambiguity: false },
        thresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
        versions: { plannerVersion: '1.0.0', policyRuleVersion: '1.0.0', thresholdProfileId: 'default' },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'entity',
        decisionConfidence: 0.6,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-lookup-bypass',
        queryTimeMs: 1,
        route: 'entity',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'chateau margaux 2016',
        normalizedQuery: 'chateau margaux 2016',
        intent: 'entity_exact',
        queryClass: 'short_entity',
        policy: { requireExact: false, allowApproximate: true, requireClarification: false, fallbackMode: 'clarify', policyReasonCodes: [] },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'entity',
        retrievalMode: 'entity_lookup',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      // Lookup-style request shape (legacy /v1/lookup/wine callers removed post-V2 cutover).
      request: { query: 'chateau margaux 2016', options: { mode: 'auto', explain: false, clarification: false } },
      requestId: 'req-lookup-bypass',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        candidates: [{
          entityId: 'wine-closest',
          canonicalLabel: 'Château Margaux 2015',
          calibratedScore: 0.6,
          rank: 1,
          evidenceRefs: ['alias'],
        }],
      },
      identityResolveResult: null,
      rankedResults: [{
        entityId: 'wine-closest',
        canonicalLabel: 'Château Margaux 2015',
        finalScore: 0.6,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.6,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      }] as RankedResult[],
      effectiveRoute: 'entity',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...ENTITY_ROUTE_EXECUTION_FACTS,
      plannerSuggestedMode: 'entity_lookup',
      retrievalModeSource: 'planner',
      abstainPolicy: { shouldAbstain: vi.fn(), evaluate } as never,
      snapshotVersions: { modelVersions: {}, indexVersions: {}, featureFlags: {} },
      decisionEngine: { decide } as never,
      responseBuilder: { build: vi.fn().mockReturnValue(response) } as never,
    });

    // Bypass honored → ranked-route decision phase runs → decisionEngine.decide called.
    // (Without the bypass, the abstain branch returns early without invoking decide.)
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('passes ltrAvailable=false to abstainPolicy when reranking metadata is absent', async () => {
    const evaluate = vi.fn().mockReturnValue(false);
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.74,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-1',
      candidates: [{
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        calibratedScore: 0.74,
        rank: 1,
        evidenceRefs: ['country'],
      }],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0.6,
        semantic_relevance_score: 0.7,
        preference_alignment_score: 0.4,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'pure_constraint',
          effectiveRoute: 'hybrid',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.74,
          calibratedGap: 0.2,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.5,
          gapThreshold: 0.1,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.74,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-ltr-unavailable',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'barolo under 150',
        normalizedQuery: 'barolo under 150',
        intent: 'facet_search',
        queryClass: 'pure_constraint',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'constraint_filter',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'barolo under 150' },
      requestId: 'req-ltr-unavailable',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: 'Barolo Example',
          calibratedScore: 0.74,
          rank: 1,
          evidenceRefs: ['country'],
        }],
      },
      identityResolveResult: null,
      rankedResults: [{
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        finalScore: 0.74,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.74,
          hardConstraintPass: true,
          softConstraint: 0.6,
          attributeAlignment: 0.6,
          preferenceAlignment: 0.4,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      }] as RankedResult[],
      effectiveRoute: 'hybrid',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'constraint_filter',
      retrievalModeSource: 'planner',
      abstainPolicy: { shouldAbstain: vi.fn(), evaluate } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: { decide } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[3]).toEqual({ ltrAvailable: false });
  });

  it('passes ltrAvailable=false to abstainPolicy for cross-encoder-only rerank metadata', async () => {
    const evaluate = vi.fn().mockReturnValue(false);
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.74,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-1',
      candidates: [{
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        calibratedScore: 0.74,
        rank: 1,
        evidenceRefs: ['country'],
      }],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0.6,
        semantic_relevance_score: 0.7,
        preference_alignment_score: 0.4,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'semantic_preference',
          effectiveRoute: 'hybrid',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.74,
          calibratedGap: 0.2,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.5,
          gapThreshold: 0.1,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.74,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-cross-encoder-only',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'medium body united states red',
        normalizedQuery: 'medium body united states red',
        intent: 'semantic_discovery',
        queryClass: 'semantic_preference',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'medium body united states red' },
      requestId: 'req-cross-encoder-only',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: 'Barolo Example',
          calibratedScore: 0.74,
          rank: 1,
          evidenceRefs: ['country'],
        }],
      },
      identityResolveResult: null,
      rankedResults: [{
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        finalScore: 0.74,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.74,
          hardConstraintPass: true,
          softConstraint: 0.6,
          attributeAlignment: 0.6,
          preferenceAlignment: 0.4,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      }] as RankedResult[],
      rankingMetadata: {
        coarsePruneSummary: undefined,
        rerankExecuted: true,
        rerankGateReason: undefined,
        rerankDecision: {
          applied: true,
          decision: 'applied',
          modelId: 'rerank-v4.0-pro',
          inputCount: 20,
          outputCount: 20,
        },
        runtimeSignal: undefined,
        preRerankTop5: ['wine-1'],
      },
      effectiveRoute: 'hybrid',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: { shouldAbstain: vi.fn(), evaluate } as never,
      snapshotVersions: {
        model_versions: {},
        index_versions: {},
        feature_flags: {},
      },
      decisionEngine: { decide } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[3]).toEqual({ ltrAvailable: false });
  });

  it('keeps routeHealthy=true for mixed constraint-guided hybrid fallback degradations', async () => {
    const evaluate = vi.fn().mockReturnValue(false);
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.74,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-1',
      candidates: [{
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        calibratedScore: 0.74,
        rank: 1,
        evidenceRefs: ['country'],
      }],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0.6,
        semantic_relevance_score: 0.7,
        preference_alignment_score: 0.4,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'pure_constraint',
          effectiveRoute: 'hybrid',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.74,
          calibratedGap: 0.2,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.5,
          gapThreshold: 0.1,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.74,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-mixed-fallback-health',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'barolo under 150',
        normalizedQuery: 'barolo under 150',
        intent: 'facet_search',
        queryClass: 'pure_constraint',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'constraint_filter',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'barolo under 150' },
      requestId: 'req-mixed-fallback-health',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: 'Barolo Example',
          calibratedScore: 0.74,
          rank: 1,
          evidenceRefs: ['country'],
        }],
      },
      identityResolveResult: null,
      rankedResults: [{
        entityId: 'wine-1',
        canonicalLabel: 'Barolo Example',
        finalScore: 0.74,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.74,
          hardConstraintPass: true,
          softConstraint: 0.6,
          attributeAlignment: 0.6,
          preferenceAlignment: 0.4,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      }] as RankedResult[],
      effectiveRoute: 'hybrid',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'constraint_filter',
      retrievalModeSource: 'planner',
      abstainPolicy: { shouldAbstain: vi.fn(), evaluate } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      routeDegradation: {
        executionMode: 'degraded',
        degradationReasons: ['mixed_constraint_guided_hybrid_fallback'],
      },
      decisionEngine: { decide } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ routeHealthy: true, executionMode: 'degraded' }),
    );
  });

  it('keeps routeHealthy=true when recovered mixed fallback carries both pre-fallback and guided-hybrid degradation reasons', async () => {
    const evaluate = vi.fn().mockReturnValue(false);
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.74,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-1',
        canonicalLabel: 'Fallback White',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-1',
      candidates: [{
        entityId: 'wine-1',
        canonicalLabel: 'Fallback White',
        calibratedScore: 0.74,
        rank: 1,
        evidenceRefs: ['wine_type'],
      }],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0.2,
        semantic_relevance_score: 0.7,
        preference_alignment_score: 0.2,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'pure_constraint',
          effectiveRoute: 'hybrid',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.74,
          calibratedGap: 0.2,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.5,
          gapThreshold: 0.1,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.74,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-mixed-fallback-combo-health',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'white dessert wine',
        normalizedQuery: 'white dessert wine',
        intent: 'facet_search',
        queryClass: 'pure_constraint',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'constraint_filter',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: '클라우디베이 말고 다른 화이트' },
      requestId: 'req-mixed-fallback-combo-health',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: 'Fallback White',
          calibratedScore: 0.74,
          rank: 1,
          evidenceRefs: ['wine_type'],
        }],
      },
      identityResolveResult: null,
      rankedResults: [{
        entityId: 'wine-1',
        canonicalLabel: 'Fallback White',
        finalScore: 0.74,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.74,
          hardConstraintPass: true,
          softConstraint: 0.2,
          attributeAlignment: 0.2,
          preferenceAlignment: 0.2,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      }] as RankedResult[],
      effectiveRoute: 'hybrid',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'constraint_filter',
      retrievalModeSource: 'planner',
      abstainPolicy: { shouldAbstain: vi.fn(), evaluate } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      routeDegradation: {
        executionMode: 'degraded',
        degradationReasons: [
          'mixed_similar_retrieval_fallback',
          'mixed_constraint_guided_hybrid_fallback',
        ],
      },
      decisionEngine: { decide } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ routeHealthy: true, executionMode: 'degraded' }),
    );
  });

  it('stores entropy-abstain responses in the cache', async () => {
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'ambiguous',
        nextAction: 'clarify',
        route: 'hybrid',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-1',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    };
    const setSearchResponse = vi.fn().mockResolvedValue(true);

    const result = await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'find bordeaux',
        normalizedQuery: 'find bordeaux',
        intent: 'search',
        additionalIntents: [],
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'entity_lookup',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'find bordeaux' },
      requestId: 'req-1',
      startTime: Date.now(),
      resolveResult: minimalResolveResult,
      identityResolveResult: null,
      rankedResults: [],
      effectiveRoute: 'hybrid',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: {
        shouldAbstain: vi.fn().mockReturnValue({ abstain: true, entropy: 0.99 }),
        evaluate: vi.fn().mockReturnValue({ shouldAbstain: true, reason: 'low_confidence', detail: 'entropy=0.99', recoverableBy: 'clarify', entropy: 0.99 }),
      } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: {
        decide: vi.fn(),
      } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
      cacheService: {
        setSearchResponse,
      } as never,
    });

    expect(result).toBe(response);
    expect(setSearchResponse).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedQuery: 'find bordeaux' }),
      {},
      response,
      expect.objectContaining({ execution: expect.any(Object) }),
    );
  });

  it('does not classify entity-route resolver results as sparse-zero-hit evidence failures', async () => {
    const evaluate = vi.fn().mockReturnValue(false);
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.97,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-1',
        canonicalLabel: '2014 Kalaris Merlot',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-1',
      candidates: [{
        entityId: 'wine-1',
        canonicalLabel: '2014 Kalaris Merlot',
        calibratedScore: 0.97,
        rank: 1,
        evidenceRefs: ['Kalaris Merlot'],
      }],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0,
        semantic_relevance_score: 0.97,
        preference_alignment_score: 0,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [{
        type: 'identity',
        source: 'entity_resolver',
        contribution: '+0.97',
        strength: 'high',
        provenance: 'Entity resolved via alias match',
      }],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'short_entity',
          effectiveRoute: 'entity',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.97,
          calibratedGap: 0.97,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.5,
          gapThreshold: 0.1,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'entity',
        decisionConfidence: 0.97,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-entity-1',
        queryTimeMs: 1,
        route: 'entity',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'Kalaris Merlot',
        normalizedQuery: 'kalaris merlot',
        intent: 'entity_exact',
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: {
          overall: 0.05,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 0.95,
          anchorConfidence: 0.95,
          constraintConfidence: 0.95,
        },
        route: 'entity',
        retrievalMode: 'entity_lookup',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'Kalaris Merlot' },
      requestId: 'req-entity-1',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        decisionConfidenceC: 0.97,
        topEntity: {
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.97,
        },
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.97,
          rank: 1,
          evidenceRefs: ['Kalaris Merlot'],
        }],
        decisionTrace: {
          ...minimalResolveResult.decisionTrace,
          top1CalibratedScore: 0.97,
          calibratedGap: 0.97,
          decisionConfidenceC: 0.97,
          outcomeReasonCodes: ['SINGLETON_BYPASS_RESOLVED'],
        },
      },
      identityResolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        decisionConfidenceC: 0.97,
        topEntity: {
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.97,
        },
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.97,
          rank: 1,
          evidenceRefs: ['Kalaris Merlot'],
        }],
        decisionTrace: {
          ...minimalResolveResult.decisionTrace,
          top1CalibratedScore: 0.97,
          calibratedGap: 0.97,
          decisionConfidenceC: 0.97,
          outcomeReasonCodes: ['SINGLETON_BYPASS_RESOLVED'],
        },
      },
      rankedResults: [{
        entityId: 'wine-1',
        canonicalLabel: '2014 Kalaris Merlot',
        finalScore: 0.97,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.97,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        evidenceItems: [{
          type: 'identity',
          source: 'entity_resolver',
          contribution: '+0.97',
          strength: 'high',
          provenance: 'Entity resolved via alias match',
        }],
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
      }],
      effectiveRoute: 'entity',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...ENTITY_ROUTE_EXECUTION_FACTS,
      plannerSuggestedMode: 'entity_lookup',
      retrievalModeSource: 'planner',
      abstainPolicy: {
        shouldAbstain: vi.fn(),
        evaluate,
      } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: {
        decide,
      } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(evaluate).toHaveBeenCalledWith(
      [0.97],
      expect.any(Array),
      expect.objectContaining({ sparseZeroHits: false }),
      expect.anything(),
      expect.any(Array),
    );
    expect(decide).toHaveBeenCalled();
  });

  it('does not treat successful specialized browse routes as sparse-zero-hit dense-only results', async () => {
    const evaluate = vi.fn().mockReturnValue(false);
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-specialized',
        canonicalLabel: 'Region Browse Wine',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-specialized',
      candidates: [],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0,
        semantic_relevance_score: 0.9,
        preference_alignment_score: 0,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'unknown',
          effectiveRoute: 'hybrid',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.9,
          calibratedGap: 0.9,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.7,
          gapThreshold: 0.2,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response = {
      queryType: 'search' as const,
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.9,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-specialized',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    } as const;

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'specialized browse',
        normalizedQuery: 'specialized browse',
        intent: 'search',
        additionalIntents: [],
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'region_browse',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'specialized browse' },
      requestId: 'req-specialized',
      startTime: Date.now() - 10,
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        candidates: [{
          entityId: 'wine-specialized',
          canonicalLabel: 'Region Browse Wine',
          calibratedScore: 0.9,
          rank: 1,
          evidenceRefs: ['anchor:region'],
        }],
        topEntity: {
          entityId: 'wine-specialized',
          canonicalLabel: 'Region Browse Wine',
          calibratedScore: 0.9,
        },
        decisionTrace: {
          ...minimalResolveResult.decisionTrace,
          top1CalibratedScore: 0.9,
          calibratedGap: 0.9,
          decisionConfidenceC: 0.9,
          outcomeReasonCodes: ['HYBRID_ROUTE'],
        },
      },
      identityResolveResult: null,
      rankedResults: [{
        entityId: 'wine-specialized',
        canonicalLabel: 'Region Browse Wine',
        finalScore: 0.9,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.85,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 1,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      }] as RankedResult[],
      effectiveRoute: 'hybrid',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...SPECIALIZED_HYBRID_EXECUTION_FACTS,
      specializedRouteObservability: {
        specializedRouteRequested: 'region_browse',
        specializedRouteExecuted: 'region_browse',
        fallbackApplied: false,
      },
      plannerSuggestedMode: 'region_browse',
      retrievalModeSource: 'planner',
      abstainPolicy: {
        shouldAbstain: vi.fn(),
        evaluate,
      } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: {
        decide,
      } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(evaluate).toHaveBeenCalledWith(
      [0.9],
      expect.any(Array),
      expect.objectContaining({ sparseZeroHits: false }),
      expect.anything(),
      expect.any(Array),
    );
  });

  it('forwards entity-route hard-constraint evidence into the decision input', async () => {
    const decide = vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.99,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'wine-1',
        canonicalLabel: '2014 Kalaris Merlot',
        identity_signature: 'sig',
        snapshot_ref: 'snap',
      },
      chosenEntityId: 'wine-1',
      candidates: [{
        entityId: 'wine-1',
        canonicalLabel: '2014 Kalaris Merlot',
        calibratedScore: 0.99,
        rank: 1,
        evidenceRefs: ['Kalaris Merlot'],
      }],
      signalSet: {
        entity_integrity_score: 1,
        hard_constraint_pass: 1,
        soft_constraint_score: 0,
        semantic_relevance_score: 0.99,
        preference_alignment_score: 0,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: [{
        type: 'identity',
        source: 'entity_resolver',
        contribution: '+0.99',
        strength: 'high',
        provenance: 'Entity resolved via alias match',
      }],
      decisionTraceRef: 'trace',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
      decisionTrace: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        inputs: {
          queryClass: 'short_entity',
          effectiveRoute: 'entity',
          policy: {
            requireExact: false,
            allowApproximate: true,
            requireClarification: false,
            fallbackMode: 'clarify',
          },
        },
        signals: {
          decisionConfidence: 0.99,
          calibratedGap: 0.99,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0.5,
          gapThreshold: 0.1,
        },
        versions: {
          plannerVersion: '1.0.0',
          policyRuleVersion: '1.0.0',
          thresholdProfileId: 'default',
        },
        rulesApplied: [],
        finalReason: 'ok',
      },
    });
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'entity',
        decisionConfidence: 0.99,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-entity-constraint',
        queryTimeMs: 1,
        route: 'entity',
        version: '1.0.0',
      },
    };

    await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'Kalaris Merlot',
        normalizedQuery: 'kalaris merlot',
        intent: 'entity_exact',
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: {
          overall: 0.05,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 0.95,
          anchorConfidence: 0.95,
          constraintConfidence: 0.95,
        },
        route: 'entity',
        retrievalMode: 'entity_lookup',
        constraints: {
          hard: [{
            attribute: 'grape_primary',
            operator: '=',
            value: 'Merlot',
            source_phrase: 'Merlot',
            confidence: 1,
          }],
          soft: [],
          inferred: [],
        },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      compiled: makeTestCompiled(),
      request: { query: 'Kalaris Merlot' },
      requestId: 'req-entity-constraint',
      startTime: Date.now(),
      resolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        decisionConfidenceC: 0.99,
        topEntity: {
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.99,
        },
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.99,
          rank: 1,
          evidenceRefs: ['Kalaris Merlot'],
        }],
        decisionTrace: {
          ...minimalResolveResult.decisionTrace,
          top1CalibratedScore: 0.99,
          calibratedGap: 0.99,
          decisionConfidenceC: 0.99,
          outcomeReasonCodes: ['SINGLETON_BYPASS_RESOLVED'],
        },
      },
      identityResolveResult: {
        ...minimalResolveResult,
        status: 'resolved',
        decisionConfidenceC: 0.99,
        topEntity: {
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.99,
        },
        candidates: [{
          entityId: 'wine-1',
          canonicalLabel: '2014 Kalaris Merlot',
          calibratedScore: 0.99,
          rank: 1,
          evidenceRefs: ['Kalaris Merlot'],
        }],
        decisionTrace: {
          ...minimalResolveResult.decisionTrace,
          top1CalibratedScore: 0.99,
          calibratedGap: 0.99,
          decisionConfidenceC: 0.99,
          outcomeReasonCodes: ['SINGLETON_BYPASS_RESOLVED'],
        },
      },
      rankedResults: [{
        entityId: 'wine-1',
        canonicalLabel: '2014 Kalaris Merlot',
        finalScore: 0.99,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.99,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 0,
          uncertaintyPenalty: 0,
        },
        evidenceItems: [
          {
            type: 'identity',
            source: 'entity_resolver',
            contribution: '+0.99',
            strength: 'high',
            provenance: 'Entity resolved via alias match',
          },
          {
            type: 'constraint_pass',
            source: 'entity_route_constraint_projection',
            contribution: '+pass',
            strength: 'high',
            provenance: 'Matched hard constraint grape_primary',
          },
        ],
        matchedConstraints: ['grape_primary'],
        unmetConstraints: [],
        inferredConstraints: [],
      }],
      effectiveRoute: 'entity',
      laneArtifacts: EMPTY_LANE_ARTIFACTS,
      ...ENTITY_ROUTE_EXECUTION_FACTS,
      plannerSuggestedMode: 'entity_lookup',
      retrievalModeSource: 'planner',
      abstainPolicy: {
        shouldAbstain: vi.fn(),
        evaluate: vi.fn().mockReturnValue(false),
      } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: {
        decide,
      } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
    });

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceSummary: expect.objectContaining({
          constraintEvidencePresent: true,
          constraintEvidence: expect.objectContaining({
            matchedRequiredAttributes: ['grape_primary'],
            unmetRequiredAttributes: [],
          }),
        }),
      }),
      expect.anything(),
    );
  });
});
