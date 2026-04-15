import { describe, expect, it, vi } from 'vitest';
import { runSearchPostRoutePhase } from '../search-usecase-post-route-phase.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { CompiledWineQuery } from '../../../domain/query/model/compiled-wine-query.js';

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
      rankedResults: [],
      effectiveRoute: 'hybrid',
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
      }] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
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
