import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { DecisionOutput } from '../../domain/decision/model/decision-output.js';
import type { StructuredClarifyPayload, TypedAbstainDecision } from '../../domain/query/model/abstain-decision.js';
import type { DecisionSnapshot, EvidenceItem } from '../../domain/shared/types/index.js';
import type { ResponseBuildParams } from '../../domain/response/service/response-builder.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import type { EvalProvenanceSlice } from '../../domain/retrieval/model/provenance.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';

const ENTROPY_SNAPSHOT_REASON_FRACTION_DIGITS = 4;
const ENTROPY_CLARIFICATION_REASON_FRACTION_DIGITS = 3;

function deriveDecisionEvidenceItems(
  rankedResults?: readonly RankedResult[],
): readonly EvidenceItem[] {
  return rankedResults?.[0]?.evidenceItems ?? [];
}

function buildStructuredClarifyPayload(
  abstainDecision: TypedAbstainDecision,
  rankedResults: readonly RankedResult[],
): StructuredClarifyPayload {
  // E6: Use the pre-computed clarifyPayload from AbstainPolicy when available.
  // AbstainPolicy derives budget_gap / preference_gap from ConstraintAtom analysis;
  // that signal is more precise than the fallback heuristics below.
  if (abstainDecision.clarifyPayload !== undefined) {
    return abstainDecision.clarifyPayload;
  }

  const topLabels = rankedResults
    .slice(0, 3)
    .map((result) => result.canonicalLabel)
    .filter((label) => label.trim().length > 0);

  switch (abstainDecision.reason) {
    case 'semantic_conflict':
      return {
        kind: 'constraint_conflict',
        question: '입력한 조건들이 서로 충돌합니다. 어떤 조건을 우선할까요?',
      };
    case 'insufficient_evidence':
      return {
        kind: 'preference_gap',
        question: '검색 신호가 부족합니다. 조건을 조금 더 구체화하거나 범위를 넓혀주세요.',
        ...(topLabels.length > 0 ? { options: topLabels } : {}),
      };
    case 'no_match':
      return {
        kind: 'preference_gap',
        question: '조건에 맞는 결과를 찾지 못했습니다. 조건을 완화해 보시겠어요?',
      };
    case 'low_confidence':
    default:
      return {
        kind: topLabels.length > 0 ? 'anchor_disambiguation' : 'preference_gap',
        question: topLabels.length > 0
          ? '결과가 모호합니다. 어떤 후보를 찾으시나요?'
          : '결과가 모호합니다. 조건을 더 구체적으로 알려주세요.',
        ...(topLabels.length > 0 ? { options: topLabels } : {}),
      };
  }
}
/**
 * Builds the {@link ResponseBuildParams} for a constraint-SAT contradiction (failed decision).
 */
export function buildConstraintContradictionResponseParams(options: {
  readonly plan: QueryPlanV1;
  readonly compiled?: CompiledWineQuery | undefined;
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
    compiled,
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
    evidenceItems: deriveDecisionEvidenceItems(),
    decisionTraceRef: buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot,
      route: effectiveRoute,
      ...(compiled !== undefined
        ? { retrievalMode: compiled.execution.effectiveRetrievalMode }
        : {}),
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
    ...(compiled !== undefined ? { compiled } : {}),
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
  readonly compiled?: CompiledWineQuery | undefined;
  readonly snapshot: DecisionSnapshot;
  readonly requestId: string;
  readonly startTime: number;
  readonly effectiveRoute: string;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: string;
  readonly abstainDecision: TypedAbstainDecision;
  readonly entropy: number;
  readonly results: readonly ResultItem[];
  readonly rankedResults: readonly RankedResult[];
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[];
}): ResponseBuildParams {
  const {
    plan,
    compiled,
    snapshot,
    requestId,
    startTime,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
    abstainDecision,
    entropy,
    results,
    rankedResults,
    retrievalProvenanceSlices,
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
    evidenceItems: deriveDecisionEvidenceItems(rankedResults),
    decisionTraceRef: buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot,
      route: effectiveRoute,
      ...(compiled !== undefined
        ? { retrievalMode: compiled.execution.effectiveRetrievalMode }
        : {}),
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
      finalReason: `Normalized entropy ${
        Number.isFinite(entropy)
          ? entropy.toFixed(ENTROPY_SNAPSHOT_REASON_FRACTION_DIGITS)
          : 'unknown'
      } exceeds threshold; query is ambiguous`,
    },
  };

  return {
    queryPlan: plan,
    ...(compiled !== undefined ? { compiled } : {}),
    decisionOutput,
    results,
    clarification: {
      reason: `Query is ambiguous (entropy=${
        Number.isFinite(entropy)
          ? entropy.toFixed(ENTROPY_CLARIFICATION_REASON_FRACTION_DIGITS)
          : 'unknown'
      }). Please refine your search.`,
      structuredPayload: buildStructuredClarifyPayload(abstainDecision, rankedResults),
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
    ...(retrievalProvenanceSlices !== undefined && retrievalProvenanceSlices.length > 0
      ? { retrievalProvenanceSlices }
      : {}),
  };
}
