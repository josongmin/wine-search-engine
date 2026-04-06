import { describe, it, expect, vi } from 'vitest';
import {
  runRankedRouteDecisionPhase,
  runSearchPostRoutePhase,
} from '../../../../src/application/search/search-usecase-post-route-phase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
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

describe('runSearchPostRoutePhase', () => {
  it('returns entropy abstain response when policy abstains', async () => {
    const built = { queryType: 'search' as const, meta: {} } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1;
    const responseBuilder = { build: vi.fn(() => built) };
    const decisionEngine = { decide: vi.fn() };
    const abstainPolicy = {
      shouldAbstain: vi.fn(() => ({ abstain: true, entropy: 0.95 })),
    };
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const eid = createEntityId();
    const rankedResults = [
      {
        entityId: eid,
        canonicalLabel: 'W',
        finalScore: 0.5,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.5,
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
      },
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];

    const out = await runSearchPostRoutePhase({
      plan,
      request,
      requestId: 'r1',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        candidates: [],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.5,
          top2CalibratedScore: 0.5,
          calibratedGap: 0,
          decisionConfidenceC: 0.5,
          ambiguityDetected: true,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 2,
      },
      rankedResults,
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: 'hybrid',
      retrievalModeSource: 'planner',
      abstainPolicy: abstainPolicy as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine,
      responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
      cacheService: undefined,
    });

    expect(out).toBe(built);
    expect(responseBuilder.build).toHaveBeenCalledOnce();
    expect(decisionEngine.decide).not.toHaveBeenCalled();
  });

  it('passes richer identity evidence into the shared decision input for ranked routes', async () => {
    const eid = createEntityId('entity-top');
    const otherId = createEntityId('entity-other');
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [
      {
        entityId: otherId,
        canonicalLabel: 'Other',
        finalScore: 0.9,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.8,
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
        evidenceItems: [{
          type: 'semantic_relevance',
          source: 'ranker',
          contribution: '+0.80',
          strength: 'high' as const,
          provenance: 'semantic match',
        }],
      },
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const decisionEngine = {
      decide: vi.fn().mockResolvedValue({
        decisionStatus: 'ambiguous' as const,
        nextAction: 'clarify' as const,
        decisionConfidence: 0.4,
        confidenceSemantics: 'calibrated_decision_confidence' as const,
        candidates: [],
        signalSet: {
          entity_integrity_score: 0,
          hard_constraint_pass: 0,
          soft_constraint_score: 0,
          semantic_relevance_score: 0,
          preference_alignment_score: 0,
          popularity_score: 0,
          availability_score: 0,
          uncertainty_penalty: 0,
        },
        evidenceItems: [],
        decisionTraceRef: 'trace-1',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
        decisionTrace: {
          decisionStatus: 'ambiguous' as const,
          nextAction: 'clarify' as const,
          inputs: {
            queryClass: 'unknown' as const,
            effectiveRoute: 'hybrid' as const,
            policy: {
              requireExact: false,
              allowApproximate: true,
              requireClarification: false,
              fallbackMode: 'hybrid' as const,
            },
          },
          signals: {
            decisionConfidence: 0.4,
            calibratedGap: 0.1,
            ambiguity: true,
          },
          thresholds: {
            resolveThreshold: 0.75,
            gapThreshold: 0.15,
          },
          versions: {
            plannerVersion: '1',
            policyRuleVersion: '1',
            thresholdProfileId: 'default',
          },
          rulesApplied: ['EVIDENCE_GATE_DOWNGRADE'],
          finalReason: 'test',
        },
      }),
    };
    const responseBuilder = {
      build: vi.fn(() => ({ queryType: 'search' as const, meta: {} })),
    };

    await runSearchPostRoutePhase({
      plan,
      request,
      requestId: 'r2',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        topEntity: { entityId: eid, canonicalLabel: 'Top', calibratedScore: 0.92 },
        candidates: [{
          entityId: eid,
          canonicalLabel: 'Top',
          calibratedScore: 0.92,
          rank: 1,
          evidenceRefs: ['alias:top'],
        }],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.92,
          top2CalibratedScore: 0.6,
          calibratedGap: 0.32,
          decisionConfidenceC: 0.92,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      },
      rankedResults,
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: 'hybrid',
      retrievalModeSource: 'planner',
      abstainPolicy: {
        shouldAbstain: vi.fn(() => ({ abstain: false, entropy: 0.1 })),
      } as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine: decisionEngine as import('../../../../src/application/search/port/search-pipeline-deps.port.js').DecisionEnginePort,
      responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
      cacheService: undefined,
    });

    const decisionInput = decisionEngine.decide.mock.calls[0]?.[0];
    const responseParams = responseBuilder.build.mock.calls[0]?.[0];
    expect(decisionInput?.evidenceSummary?.identityEvidencePresent).toBe(false);
    expect(decisionInput?.evidenceSummary?.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(
      false,
    );
    expect(responseParams?.retrievalModeSource).toBe('planner');
    expect(responseParams?.plannerSuggestedMode).toBe('hybrid');
  });

  it('keeps the shared ranked-route decision phase aligned with the main post-route response shape', async () => {
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [{
      entityId: createEntityId('entity-ranked'),
      canonicalLabel: 'Ranked Wine',
      finalScore: 0.91,
      rank: 1,
      componentScores: {
        entityIntegrity: 1,
        semantic: 0.82,
        hardConstraintPass: true,
        softConstraint: 0.2,
        attributeAlignment: 0.1,
        preferenceAlignment: 0.1,
        popularity: 0.4,
        availability: 1,
        uncertaintyPenalty: 0,
      },
      matchedConstraints: [],
      unmetConstraints: [],
      inferredConstraints: [],
      evidenceItems: [{
        type: 'semantic_relevance',
        source: 'ranker',
        contribution: '+0.82',
        strength: 'high' as const,
        provenance: 'semantic match',
      }],
    }] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const resolveResult = {
      status: 'resolved' as const,
      topEntity: {
        entityId: createEntityId('entity-ranked'),
        canonicalLabel: 'Ranked Wine',
        calibratedScore: 0.94,
      },
      candidates: [{
        entityId: createEntityId('entity-ranked'),
        canonicalLabel: 'Ranked Wine',
        calibratedScore: 0.94,
        rank: 1,
        evidenceRefs: ['alias:ranked'],
      }],
      decisionTrace: {
        queryClass: 'unknown' as const,
        top1CalibratedScore: 0.94,
        top2CalibratedScore: 0.52,
        calibratedGap: 0.42,
        decisionConfidenceC: 0.94,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      conformalSetSize: 1,
    };
    const decisionOutput = {
      decisionStatus: 'resolved' as const,
      nextAction: 'respond' as const,
      route: 'hybrid' as const,
      decisionConfidence: 0.94,
      confidenceSemantics: 'calibrated_decision_confidence' as const,
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    };
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };
    const decisionEngine = { decide: vi.fn().mockResolvedValue(decisionOutput) };
    const abstainPolicy = { shouldAbstain: vi.fn(() => ({ abstain: false, entropy: 0.1 })) };
    const startTime = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_010);

    const rankedRouteResponse = await runRankedRouteDecisionPhase({
      plan,
      requestId: 'req-ranked',
      startTime,
      resolveResult,
      rankedResults,
      effectiveRoute: 'hybrid',
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: undefined,
      includeCounterfactuals: false,
    });

    const mainRouteResponse = await runSearchPostRoutePhase({
      plan,
      request,
      requestId: 'req-ranked',
      startTime,
      resolveResult,
      rankedResults,
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: 'hybrid',
      retrievalModeSource: 'planner',
      abstainPolicy: abstainPolicy as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: undefined,
      cacheService: undefined,
    });

    nowSpy.mockRestore();

    const {
      retrievalModeSource: _retrievalModeSource,
      plannerSuggestedMode: _plannerSuggestedMode,
      counterfactuals: _counterfactuals,
      ...sharedMainRouteResponse
    } = mainRouteResponse as Record<string, unknown>;

    expect(rankedRouteResponse).toEqual(sharedMainRouteResponse);
    expect(responseBuilder.build).toHaveBeenCalledTimes(2);
    expect(decisionEngine.decide).toHaveBeenCalledTimes(2);
  });

  it('passes route degradation into the response contract for ranked routes', async () => {
    const responseBuilder = {
      build: vi.fn(() => ({ queryType: 'search' as const, meta: {} })),
    };

    await runRankedRouteDecisionPhase({
      plan: minimalPlan(),
      requestId: 'req-degraded',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        candidates: [],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.9,
          top2CalibratedScore: 0.1,
          calibratedGap: 0.8,
          decisionConfidenceC: 0.9,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.7, gapThreshold: 0.2 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      },
      rankedResults: [],
      effectiveRoute: 'hybrid',
      snapshotVersions: undefined,
      decisionEngine: {
        decide: vi.fn().mockResolvedValue({
          decisionStatus: 'resolved',
          nextAction: 'return_result',
          decisionConfidence: 0.9,
          confidenceSemantics: 'calibrated_decision_confidence',
          signalSet: {
            entity_integrity_score: 1,
            hard_constraint_pass: 1,
            soft_constraint_score: 1,
            semantic_relevance_score: 1,
            preference_alignment_score: 1,
            popularity_score: 1,
            availability_score: 1,
            uncertainty_penalty: 0,
          },
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
          decisionTrace: {
            decisionStatus: 'resolved',
            nextAction: 'return_result',
            inputs: {
              queryClass: 'unknown',
              policy: minimalPlan().policy,
            },
            signals: {
              decisionConfidence: 0.9,
              calibratedGap: 0.8,
              ambiguity: false,
            },
            thresholds: {
              resolveThreshold: 0.7,
              gapThreshold: 0.2,
            },
            versions: {
              plannerVersion: '1',
              policyRuleVersion: '1',
              thresholdProfileId: 'default',
            },
            rulesApplied: [],
            finalReason: 'ok',
          },
        }),
      } as never,
      responseBuilder: responseBuilder as never,
      routeDegradation: {
        executionMode: 'degraded',
        degradationReasons: ['reranker_timeout'],
      },
    });

    expect(responseBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: {
          executionMode: 'degraded',
          degradationReasons: ['reranker_timeout'],
        },
      }),
    );
  });

  it('marks learning kill switch as degraded in the surfaced response contract', async () => {
    const responseBuilder = {
      build: vi.fn(() => ({ queryType: 'search' as const, meta: {} })),
    };

    await runRankedRouteDecisionPhase({
      plan: minimalPlan(),
      requestId: 'req-learning-ks',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        candidates: [],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.9,
          top2CalibratedScore: 0.1,
          calibratedGap: 0.8,
          decisionConfidenceC: 0.9,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.7, gapThreshold: 0.2 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      },
      rankedResults: [],
      effectiveRoute: 'hybrid',
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {
          killSwitchLearning: true,
        },
      },
      decisionEngine: {
        decide: vi.fn().mockResolvedValue({
          decisionStatus: 'resolved',
          nextAction: 'return_result',
          decisionConfidence: 0.9,
          confidenceSemantics: 'calibrated_decision_confidence',
          signalSet: {
            entity_integrity_score: 1,
            hard_constraint_pass: 1,
            soft_constraint_score: 1,
            semantic_relevance_score: 1,
            preference_alignment_score: 1,
            popularity_score: 1,
            availability_score: 1,
            uncertainty_penalty: 0,
          },
          evidenceItems: [],
          decisionTraceRef: 'trace',
          decisionSnapshot: {
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1',
            threshold_profile_id: 'default',
            planner_version: '1',
            feature_flags: {
              killSwitchLearning: true,
            },
          },
          decisionTrace: {
            decisionStatus: 'resolved',
            nextAction: 'return_result',
            inputs: {
              queryClass: 'unknown',
              policy: minimalPlan().policy,
            },
            signals: {
              decisionConfidence: 0.9,
              calibratedGap: 0.8,
              ambiguity: false,
            },
            thresholds: {
              resolveThreshold: 0.7,
              gapThreshold: 0.2,
            },
            versions: {
              plannerVersion: '1',
              policyRuleVersion: '1',
              thresholdProfileId: 'default',
            },
            rulesApplied: [],
            finalReason: 'ok',
          },
        }),
      } as never,
      responseBuilder: responseBuilder as never,
    });

    expect(responseBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: {
          executionMode: 'degraded',
          degradationReasons: ['learning_kill_switch'],
        },
      }),
    );
  });
});
