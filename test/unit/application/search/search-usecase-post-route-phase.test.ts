import { describe, it, expect, vi } from 'vitest';
import { runSearchPostRoutePhase } from '../../../../src/application/search/search-usecase-post-route-phase.js';
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
    expect(decisionInput?.evidenceSummary?.identityEvidencePresent).toBe(false);
    expect(decisionInput?.evidenceSummary?.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(
      false,
    );
  });
});
