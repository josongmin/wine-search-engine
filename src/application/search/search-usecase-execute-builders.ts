import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { DecisionOutput } from '../../domain/decision/model/decision-output.js';
import type {
  StructuredClarifyPayload,
  StructuredClarifyOptionEntity,
  TypedAbstainDecision,
} from '../../domain/query/model/abstain-decision.js';
import {
  type DecisionSnapshot,
  type EvidenceItem,
  deriveDecisionConfidenceSemantics,
} from '../../domain/shared/types/index.js';
import type { ResponseBuildParams } from '../../domain/response/service/response-builder.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import type { EvalProvenanceSlice } from '../../domain/retrieval/model/provenance.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';
import { buildDisplayIdentitySignature } from '../../domain/response/service/display-identity.js';

const ENTROPY_SNAPSHOT_REASON_FRACTION_DIGITS = 4;
const ENTROPY_CLARIFICATION_REASON_FRACTION_DIGITS = 3;

function buildAbstainDecisionTraceReason(
  abstainDecision: TypedAbstainDecision,
  entropy: number,
): { readonly rulesApplied: readonly string[]; readonly finalReason: string } {
  switch (abstainDecision.reason) {
    case 'low_confidence':
      return {
        rulesApplied: ['ENTROPY_ABSTAIN'],
        finalReason: `Normalized entropy ${
          Number.isFinite(entropy)
            ? entropy.toFixed(ENTROPY_SNAPSHOT_REASON_FRACTION_DIGITS)
            : 'unknown'
        } exceeds threshold; query is ambiguous`,
      };
    case 'no_match':
      return {
        rulesApplied: ['ABSTAIN_NO_MATCH'],
        finalReason: abstainDecision.detail,
      };
    case 'semantic_conflict':
      return {
        rulesApplied: ['ABSTAIN_SEMANTIC_CONFLICT'],
        finalReason: abstainDecision.detail,
      };
    case 'insufficient_evidence':
      return {
        rulesApplied: ['ABSTAIN_INSUFFICIENT_EVIDENCE'],
        finalReason: abstainDecision.detail,
      };
  }
}

function buildAbstainClarificationReason(
  abstainDecision: TypedAbstainDecision,
  entropy: number,
): string {
  if (abstainDecision.reason === 'low_confidence') {
    return `Query is ambiguous (entropy=${
      Number.isFinite(entropy)
        ? entropy.toFixed(ENTROPY_CLARIFICATION_REASON_FRACTION_DIGITS)
        : 'unknown'
    }). Please refine your search.`;
  }
  return abstainDecision.detail;
}

function deriveAbstainDecisionOutcome(
  abstainDecision: TypedAbstainDecision,
): { readonly decisionStatus: DecisionOutput['decisionStatus']; readonly nextAction: DecisionOutput['nextAction']; readonly ambiguity: boolean } {
  if (abstainDecision.reason === 'no_match') {
    return {
      decisionStatus: 'failed',
      nextAction: 'fail',
      ambiguity: false,
    };
  }
  return {
    decisionStatus: 'ambiguous',
    nextAction: 'clarify',
    ambiguity: true,
  };
}

function deriveDecisionEvidenceItems(
  rankedResults?: readonly RankedResult[],
): readonly EvidenceItem[] {
  return rankedResults?.[0]?.evidenceItems ?? [];
}

const AUTHORITATIVE_IDENTITY_MATCH_TYPES = new Set<ResultItem['match']['matchType']>([
  'exact',
  'alias_exact',
  'alias_fuzzy',
]);

function filterAmbiguousShortFormPresentation(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  results: readonly ResultItem[],
): readonly RankedResult[] {
  if (plan.queryClass !== 'ambiguous_short_form') {
    return rankedResults;
  }
  if (results.length === 0) {
    return rankedResults;
  }
  // The ambiguous_short_form filter exists to drop list-shaped results that
  // don't have an exact/alias identity-bearing match — keeps a "Sass" query
  // from surfacing fuzzy non-identity rankings as if they were the resolved
  // wine. But for similarity / similar_items / recommendation queries the
  // user is explicitly asking for a LIST shaped by an anchor + constraints
  // (`마고 비슷한 레드` = "red wines similar to Margaux"); the planner
  // surfaces this by emitting `requires_identity_seal: false`. When the
  // admission context says identity isn't required, this filter would
  // empty the result list (no candidate has an identity matchType because
  // there is no identity claim being made) — the same `!required ||
  // satisfied` pattern we applied in evidence-gate.ts Rule 1 and
  // admission-gate identitySeal applies here at the presentation seam.
  if (plan.admission_context?.requires_identity_seal !== true) {
    return rankedResults;
  }

  const supportedEntityIds = new Set(
    results
      .filter((result) => AUTHORITATIVE_IDENTITY_MATCH_TYPES.has(result.match.matchType))
      .map((result) => result.entity.entityId),
  );
  if (supportedEntityIds.size === 0) {
    return [];
  }

  return rankedResults.filter((result) => supportedEntityIds.has(result.entityId));
}

function dedupeRankedResultsByDisplayIdentity(
  rankedResults: readonly RankedResult[],
): readonly RankedResult[] {
  const deduped = new Map<string, RankedResult>();
  for (const result of rankedResults) {
    const signature = buildDisplayIdentitySignature({
      canonicalLabel: result.canonicalLabel,
      producer: result.producer,
      region: result.region,
      country: result.country,
      vintage: result.vintageYear,
      type: result.wineType,
    });
    const existing = deduped.get(signature);
    if (existing === undefined || result.finalScore > existing.finalScore) {
      deduped.set(signature, result);
    }
  }
  return [...deduped.values()].sort((left, right) => left.rank - right.rank);
}

function dedupeResultItemsByEntityId(
  results: readonly ResultItem[],
): readonly ResultItem[] {
  const deduped = new Map<string, ResultItem>();
  for (const result of results) {
    const key = String(result.entity.entityId);
    const existing = deduped.get(key);
    if (existing === undefined || result.relevanceScore > existing.relevanceScore) {
      deduped.set(key, result);
    }
  }
  return [...deduped.values()];
}

function buildClarificationDistinguishingFeatures(
  result: RankedResult,
  candidates: readonly RankedResult[],
): readonly string[] {
  const features: string[] = [];
  const distinctVintageCount = new Set(
    candidates
      .map((candidate) => candidate.vintageYear)
      .filter((value): value is number => value !== undefined),
  ).size;
  const distinctRegionCount = new Set(
    candidates
      .map((candidate) => candidate.region)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  ).size;
  const distinctWineTypeCount = new Set(
    candidates
      .map((candidate) => candidate.wineType)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  ).size;
  const distinctClassificationCount = new Set(
    candidates
      .map((candidate) => candidate.classification)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  ).size;

  if (
    result.vintageYear !== undefined &&
    distinctVintageCount > 1 &&
    !result.canonicalLabel.includes(String(result.vintageYear))
  ) {
    features.push(String(result.vintageYear));
  }
  if (typeof result.region === 'string' && result.region.length > 0 && distinctRegionCount > 1) {
    features.push(result.region);
  }
  if (typeof result.wineType === 'string' && result.wineType.length > 0 && distinctWineTypeCount > 1) {
    features.push(result.wineType);
  }
  if (
    typeof result.classification === 'string' &&
    result.classification.length > 0 &&
    distinctClassificationCount > 1
  ) {
    features.push(result.classification);
  }

  return features;
}

function shouldFailClosedIdentityClarification(
  plan: QueryPlanV1,
  abstainDecision: TypedAbstainDecision,
): boolean {
  if (abstainDecision.reason !== 'low_confidence') {
    return false;
  }
  if (plan.queryClass !== 'ambiguous_short_form') {
    return false;
  }
  if (plan.admission_context?.requires_identity_seal === true) {
    return true;
  }
  return plan.intent === 'entity_exact' || plan.intent === 'entity_fuzzy';
}

function buildStructuredClarifyPayload(
  plan: QueryPlanV1,
  abstainDecision: TypedAbstainDecision,
  rankedResults: readonly RankedResult[],
): StructuredClarifyPayload {
  // E6: Use the pre-computed clarifyPayload from AbstainPolicy when available.
  // AbstainPolicy derives budget_gap / preference_gap from ConstraintAtom analysis;
  // that signal is more precise than the fallback heuristics below.
  if (abstainDecision.clarifyPayload !== undefined) {
    return abstainDecision.clarifyPayload;
  }

  const topLabels = shouldFailClosedIdentityClarification(plan, abstainDecision)
    ? []
    : rankedResults
      .slice(0, 3)
      .map((result) => result.canonicalLabel)
      .filter((label) => label.trim().length > 0);
  const topAmbiguousEntityHint = plan.expansions.ambiguousEntityHints?.[0];
  const compilerClarifyQuestion = plan.expansions.ambiguityIntentInterpretation?.branchSelections
    .map((selection) => selection.clarifyQuestion)
    .find((question): question is string => question !== undefined && question.trim().length > 0);

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
      if (topAmbiguousEntityHint !== undefined) {
        return {
          kind: 'anchor_disambiguation',
          question: compilerClarifyQuestion ?? `${topAmbiguousEntityHint.surface}는 어떤 계열을 찾으시나요?`,
          options: topAmbiguousEntityHint.clarifyOptions,
        };
      }
      return {
        kind: topLabels.length > 0 ? 'anchor_disambiguation' : 'preference_gap',
        question: topLabels.length > 0
          ? '결과가 모호합니다. 어떤 후보를 찾으시나요?'
          : '결과가 모호합니다. 조건을 더 구체적으로 알려주세요.',
        ...(topLabels.length > 0
          ? {
              options: topLabels,
              optionEntities: rankedResults
                .slice(0, 3)
                .map((result): StructuredClarifyOptionEntity => ({
                  entityId: result.entityId,
                  label: result.canonicalLabel,
                  distinguishingFeatures: buildClarificationDistinguishingFeatures(
                    result,
                    rankedResults.slice(0, 3),
                  ),
                })),
            }
          : {}),
      };
  }
}
/**
 * Builds the {@link ResponseBuildParams} for a constraint-SAT contradiction (failed decision).
 */
export function buildConstraintContradictionResponseParams(options: {
  readonly plan: QueryPlanV1;
  readonly compiled: CompiledWineQuery;
  readonly snapshot: DecisionSnapshot;
  readonly requestId: string;
  readonly startTime: number;
  readonly conflictDesc: string;
  readonly effectiveRoute: QueryRoute;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: ExecutionRetrievalMode;
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
    confidenceSemantics: deriveDecisionConfidenceSemantics(false),
    calibrationTrusted: false,
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
      retrievalMode: compiled.execution.effectiveRetrievalMode,
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
        calibratedGap: undefined,
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
    compiled,
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
  readonly compiled: CompiledWineQuery;
  readonly snapshot: DecisionSnapshot;
  readonly requestId: string;
  readonly startTime: number;
  readonly effectiveRoute: QueryRoute;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: ExecutionRetrievalMode;
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
  const presentationRankedResults = dedupeRankedResultsByDisplayIdentity(
    filterAmbiguousShortFormPresentation(plan, rankedResults, results),
  );
  const presentationEntityIds = new Set(presentationRankedResults.map((result) => result.entityId));
  const presentationResults = dedupeResultItemsByEntityId(
    results.filter((result) => presentationEntityIds.has(result.entity.entityId)),
  );
  const failClosedIdentityClarification = shouldFailClosedIdentityClarification(plan, abstainDecision);
  const abstainTraceReason = buildAbstainDecisionTraceReason(abstainDecision, entropy);
  const abstainOutcome = deriveAbstainDecisionOutcome(abstainDecision);

  const decisionOutput: DecisionOutput = {
    decisionStatus: abstainOutcome.decisionStatus,
    nextAction: abstainOutcome.nextAction,
    decisionConfidence: 0,
    confidenceSemantics: deriveDecisionConfidenceSemantics(false),
    calibrationTrusted: false,
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
    evidenceItems: deriveDecisionEvidenceItems(presentationRankedResults),
    decisionTraceRef: buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot,
      route: effectiveRoute,
      retrievalMode: compiled.execution.effectiveRetrievalMode,
      decisionStatus: abstainOutcome.decisionStatus,
      nextAction: abstainOutcome.nextAction,
    }),
    decisionSnapshot: snapshot,
    decisionTrace: {
      decisionStatus: abstainOutcome.decisionStatus,
      nextAction: abstainOutcome.nextAction,
      inputs: {
        queryClass: plan.queryClass,
        policy: plan.policy,
      },
      signals: {
        decisionConfidence: 0,
        calibratedGap: undefined,
        ambiguity: abstainOutcome.ambiguity,
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
      rulesApplied: [...abstainTraceReason.rulesApplied],
      finalReason: abstainTraceReason.finalReason,
    },
  };

  return {
    queryPlan: plan,
    compiled,
    decisionOutput,
    abstainReason: abstainDecision.reason,
    results: failClosedIdentityClarification ? [] : presentationResults,
    clarification: {
      reason: buildAbstainClarificationReason(abstainDecision, entropy),
      structuredPayload: buildStructuredClarifyPayload(plan, abstainDecision, presentationRankedResults),
      candidates: failClosedIdentityClarification
        ? []
        : presentationRankedResults.slice(0, 3).map((r) => ({
          entityId: r.entityId,
          label: r.canonicalLabel,
          distinguishingFeatures: buildClarificationDistinguishingFeatures(
            r,
            presentationRankedResults.slice(0, 3),
          ),
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
