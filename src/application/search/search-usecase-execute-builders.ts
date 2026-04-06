import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { DecisionOutput } from '../../domain/decision/model/decision-output.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { ResponseBuildParams } from '../../domain/response/service/response-builder.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';
/**
 * Builds the {@link ResponseBuildParams} for a constraint-SAT contradiction (failed decision).
 */
export function buildConstraintContradictionResponseParams(options: {
  readonly plan: QueryPlanV1;
  readonly snapshot: DecisionSnapshot;
  readonly requestId: string;
  readonly startTime: number;
  readonly conflictDesc: string;
  readonly effectiveRoute: string;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: string;
}): ResponseBuildParams {
  const {
    plan,
    snapshot,
    requestId,
    startTime,
    conflictDesc,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
  } = options;

  const decisionOutput: DecisionOutput = {
    decisionStatus: 'failed',
    nextAction: 'fail',
    decisionConfidence: 0,
    confidenceSemantics: 'calibrated_decision_confidence',
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
    decisionTraceRef: buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot,
      decisionStatus: 'failed',
      nextAction: 'fail',
      failureReason: 'HARD_CONSTRAINT_VIOLATION',
    }),
    decisionSnapshot: snapshot,
    failureReason: 'HARD_CONSTRAINT_VIOLATION',
    decisionTrace: {
      decisionStatus: 'failed',
      nextAction: 'fail',
      inputs: {
        queryClass: plan.queryClass,
        policy: plan.policy,
      },
      signals: {
        decisionConfidence: 0,
        calibratedGap: 0,
        ambiguity: false,
      },
      thresholds: {
        resolveThreshold: 0,
        gapThreshold: 0,
      },
      versions: {
        plannerVersion: plan.plannerVersion,
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
      },
      rulesApplied: ['CONSTRAINT_SAT'],
      finalReason: `Contradictory constraints: ${conflictDesc}`,
    },
    candidates: [],
  };

  return {
    queryPlan: plan,
    decisionOutput,
    results: [],
    requestId,
    queryTimeMs: Date.now() - startTime,
    route: effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
  };
}

/**
 * Builds entropy-abstain clarification response params (after {@link mapRankedToResultItems}).
 */
export function buildEntropyAbstainResponseParams(options: {
  readonly plan: QueryPlanV1;
  readonly snapshot: DecisionSnapshot;
  readonly requestId: string;
  readonly startTime: number;
  readonly effectiveRoute: string;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: string;
  readonly entropy: number;
  readonly results: readonly ResultItem[];
  readonly rankedResults: readonly RankedResult[];
}): ResponseBuildParams {
  const {
    plan,
    snapshot,
    requestId,
    startTime,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
    entropy,
    results,
    rankedResults,
  } = options;

  const decisionOutput: DecisionOutput = {
    decisionStatus: 'ambiguous',
    nextAction: 'clarify',
    decisionConfidence: 0,
    confidenceSemantics: 'calibrated_decision_confidence',
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
    decisionTraceRef: buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot,
      decisionStatus: 'ambiguous',
      nextAction: 'clarify',
    }),
    decisionSnapshot: snapshot,
    decisionTrace: {
      decisionStatus: 'ambiguous',
      nextAction: 'clarify',
      inputs: {
        queryClass: plan.queryClass,
        policy: plan.policy,
      },
      signals: {
        decisionConfidence: 0,
        calibratedGap: 0,
        ambiguity: true,
      },
      thresholds: {
        resolveThreshold: 0,
        gapThreshold: 0,
      },
      versions: {
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
        plannerVersion: plan.plannerVersion,
      },
      rulesApplied: ['ENTROPY_ABSTAIN'],
      finalReason: `Normalized entropy ${entropy.toFixed(4)} exceeds threshold; query is ambiguous`,
    },
  };

  return {
    queryPlan: plan,
    decisionOutput,
    results,
    clarification: {
      reason: `Query is ambiguous (entropy=${entropy.toFixed(3)}). Please refine your search.`,
      candidates: rankedResults.slice(0, 3).map((r) => ({
        entityId: r.entityId,
        label: r.canonicalLabel,
        distinguishingFeatures: [],
      })),
      suggestionType: 'disambiguation',
    },
    requestId,
    queryTimeMs: Date.now() - startTime,
    route: effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
  };
}
