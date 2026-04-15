import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type {
  ExecutionRetrievalMode,
  ProvenancePolicy,
} from '../../domain/query/model/engine-execution-contract.js';
import type { ConstraintGraph } from '../../domain/query/model/constraint-graph.js';
import { resolveRequiredAttributes } from '../../domain/query/service/graph-required-attributes.js';
import {
  type DecisionInput,
  type EvidenceSummary,
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
} from '../../domain/decision/model/decision-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EvidenceItem, SignalSet } from '../../domain/shared/types/index.js';
import type { SearchRouteDecisionContext } from './search-usecase-route-dispatch.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isPositiveEvidenceItem(item: EvidenceItem): boolean {
  return item.contribution.startsWith('+');
}

function isSyntheticRankedRouteResolve(result: EntityResolveResult): boolean {
  return result.decisionTrace.outcomeReasonCodes.some(
    (code) => code === 'HYBRID_ROUTE' || code === 'MIXED_ROUTE',
  );
}

/**
 * Assembles {@link DecisionInput} from planner output, resolver output, and optional ranking.
 * RFC-007 §4 — ranking signals and evidence wiring for the Decision Engine.
 *
 * doc_guard E3-U6: Calibrator insertion point is NOT here.
 * Score calibration for ranked routes must be applied in
 * search-usecase-ranked-route-resolve.ts (buildRankedRouteResolveResult),
 * before decisionTrace/confidence scores are emitted. This function receives
 * already-calibrated resolver output and must not re-calibrate or adjust scores.
 */
export function buildSearchDecisionInput(
  plan: QueryPlanV1,
  resolverResult: EntityResolveResult,
  rankedResults?: readonly RankedResult[],
  effectiveRoute: QueryRoute = plan.route,
  decisionContext?: SearchRouteDecisionContext,
  executionContext?: {
    readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
    readonly retrievalKind?:
      | 'entity_lookup'
      | 'generic_hybrid'
      | 'specialized_hybrid'
      | 'mixed_similarity'
      | undefined;
    readonly provenancePolicy?: ProvenancePolicy | undefined;
    /**
     * ADR-011 Phase 1b.3a: when the planner emitted a ConstraintGraph
     * (`compiled.constraintGraph`), callers pass it through here so the
     * decision-input's matched/unmet computation follows the same AND / OR
     * / XOR group semantics as the provenance-closure reader. Absent in
     * the flat/rollback path — computation falls back byte-identical to
     * the pre-Phase-1b.3a behaviour.
     */
    readonly constraintGraph?: ConstraintGraph | undefined;
  },
  honestyContract?: {
    readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory' | undefined;
    readonly routeHealthy?: boolean | undefined;
    readonly blockingRequested?: boolean | undefined;
  },
): DecisionInput {
  const topResult = rankedResults?.[0];
  const topEntity = resolverResult.topEntity;
  const resolverTopCandidate = resolverResult.candidates[0];
  const syntheticRankedRoute = isSyntheticRankedRouteResolve(resolverResult);

  const rankingSignals: SignalSet | undefined =
    topResult !== undefined
      ? {
          entity_integrity_score: topResult.componentScores.entityIntegrity,
          hard_constraint_pass: topResult.componentScores.hardConstraintPass ? 1 : 0,
          soft_constraint_score: topResult.componentScores.softConstraint,
          ...(topResult.componentScores.semantic !== undefined
            ? { semantic_relevance_score: topResult.componentScores.semantic }
            : {}),
          ...(topResult.componentScores.preferenceAlignment !== undefined
            ? { preference_alignment_score: topResult.componentScores.preferenceAlignment }
            : {}),
          ...(topResult.componentScores.popularity !== undefined
            ? { popularity_score: topResult.componentScores.popularity }
            : {}),
          ...(topResult.componentScores.availability !== undefined
            ? { availability_score: topResult.componentScores.availability }
            : {}),
          uncertainty_penalty: topResult.componentScores.uncertaintyPenalty,
        }
      : undefined;

  const resolverTopCandidateMatchesTopEntity =
    resolverTopCandidate !== undefined &&
    topEntity !== undefined &&
    resolverTopCandidate.entityId === topEntity.entityId;
  const resolverEvidenceRefCount =
    resolverTopCandidateMatchesTopEntity ? resolverTopCandidate.evidenceRefs.length : 0;
  const rankedTopResultMatchesTopEntity =
    topResult !== undefined &&
    topEntity !== undefined &&
    topResult.entityId === topEntity.entityId;
  const rankedCorroborationItems =
    topResult !== undefined && rankedTopResultMatchesTopEntity
      ? topResult.evidenceItems.filter(isPositiveEvidenceItem)
      : [];
  const rankedCorroborationTypes =
    rankedCorroborationItems.length > 0
      ? unique(rankedCorroborationItems.map((item) => item.type))
      : [];
  const resolverIdentityTrailPresent =
    resolverTopCandidateMatchesTopEntity &&
    (syntheticRankedRoute || resolverEvidenceRefCount > 0);
  const exactMatchCandidatePresent =
    resolverIdentityTrailPresent &&
    (topResult === undefined
      ? true
      : rankedTopResultMatchesTopEntity);
  // ADR-011 Phase 1b.3a: when a ConstraintGraph is threaded through
  // `executionContext.constraintGraph`, matched/unmet attributes are resolved
  // via the shared helper under AND / OR / XOR group semantics so
  // provenance-closure and decision-input stay in lockstep. In the flat path
  // the computation is unchanged from pre-Phase-1b.3a behaviour.
  const requiredConstraintAttributes = unique(
    plan.constraints.hard.map((constraint) => constraint.attribute),
  );
  const constraintGraph = executionContext?.constraintGraph;
  const graphResolution =
    constraintGraph !== undefined && topResult !== undefined
      ? resolveRequiredAttributes({
          plan,
          graph: constraintGraph,
          satisfiedAttributes: topResult.matchedConstraints,
        })
      : undefined;
  const matchedRequiredAttributes =
    graphResolution !== undefined
      ? graphResolution.matched
      : topResult !== undefined
      ? unique(
          topResult.matchedConstraints.filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];
  const unmetRequiredAttributes =
    graphResolution !== undefined
      ? graphResolution.unmet
      : topResult !== undefined
      ? unique(
          topResult.unmetConstraints.filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];
  const anchorSignalItems =
    topResult !== undefined && rankedTopResultMatchesTopEntity
      ? topResult.evidenceItems.filter(
          (item) => item.type === 'anchor_similarity' && isPositiveEvidenceItem(item),
        )
      : [];
  const anchorSignalTypes =
    anchorSignalItems.length > 0
      ? unique(anchorSignalItems.map((item) => item.type))
      : [];

  const identityEvidence: NonNullable<EvidenceSummary['identityEvidence']> = {
    ...(syntheticRankedRoute ? { source: 'ranked_synthetic' as const } : {}),
    topEntityPresent: topEntity !== undefined,
    resolverTopCandidateMatchesTopEntity,
    resolverEvidenceRefCount,
    ...(syntheticRankedRoute ? { syntheticRankedRoute: true } : {}),
    ...(topResult !== undefined ? { rankedTopResultPresent: true } : {}),
    ...(topResult !== undefined && topEntity !== undefined
      ? { rankedTopResultMatchesTopEntity }
      : {}),
    ...(topResult !== undefined ? { rankedEvidenceItemCount: topResult.evidenceItems.length } : {}),
    ...(rankedCorroborationTypes.length > 0
      ? {
          rankedCorroborationItemCount: rankedCorroborationItems.length,
          rankedCorroborationTypes,
        }
      : {}),
    ...(exactMatchCandidatePresent ? { exactMatchCandidatePresent: true } : {}),
  };

  const constraintEvidence =
    topResult !== undefined
      ? {
          requiredAttributes: requiredConstraintAttributes,
          matchedRequiredAttributes,
          unmetRequiredAttributes,
          inferredAttributes: unique(topResult.inferredConstraints),
          matchedRequiredAttributeCount: matchedRequiredAttributes.length,
          unmetRequiredAttributeCount: unmetRequiredAttributes.length,
        }
      : undefined;

  const anchorEvidenceRequired = effectiveRoute === 'mixed' && plan.anchors.length > 0;
  const mixedAnchor = decisionContext?.mixedAnchor;
  const anchorEvidence = anchorEvidenceRequired
    ? {
        topEntityPresent: topEntity !== undefined,
        ...(topResult !== undefined ? { rankedTopResultPresent: true } : {}),
        ...(topResult !== undefined && topEntity !== undefined
          ? { rankedTopResultMatchesTopEntity }
          : {}),
        ...(topResult !== undefined
          ? {
              rankedSignalPresent:
                (topResult.componentScores.anchorSimilarity ?? 0) > 0 ||
                anchorSignalTypes.length > 0,
              ...(anchorSignalTypes.length > 0
                ? {
                    rankedSignalItemCount: anchorSignalItems.length,
                    rankedSignalTypes: anchorSignalTypes,
                  }
                : {}),
            }
          : {}),
      }
    : undefined;
  const anchorResolution = anchorEvidenceRequired
    ? {
        anchorEntityPresent: mixedAnchor !== undefined,
        ...(mixedAnchor !== undefined
          ? {
              anchorEntityId: mixedAnchor.entityId,
              anchorCanonicalLabel: mixedAnchor.canonicalLabel,
              anchorConfidence: mixedAnchor.confidence,
            }
          : {}),
      }
    : undefined;

  const provenancePolicy = executionContext?.provenancePolicy ?? {
    requireIdentitySeal:
      plan.admission_context?.requires_identity_seal === true ||
      effectiveRoute === 'mixed',
    requireConstraintEvidence:
      plan.admission_context?.requires_constraint_evidence === true ||
      plan.constraints.hard.length > 0,
    requireAnchorEvidence:
      plan.admission_context?.requires_anchor_evidence === true ||
      anchorEvidenceRequired,
  };
  const evidenceSummaryBase: EvidenceSummary = {
    identityEvidencePresent: false,
    identityEvidence,
    ...(constraintEvidence !== undefined ? { constraintEvidence } : {}),
    ...(anchorResolution !== undefined ? { anchorResolution } : {}),
    ...(anchorEvidence !== undefined ? { anchorEvidence } : {}),
    ...((resolverEvidenceRefCount > 0 || topResult !== undefined)
      ? {
          evidenceRefCount:
            resolverEvidenceRefCount +
            (topResult !== undefined && rankedTopResultMatchesTopEntity
              ? topResult.evidenceItems.length
              : 0),
        }
      : {}),
  };
  const evidenceSummary: EvidenceSummary = {
    ...evidenceSummaryBase,
    identityEvidencePresent: hasIdentityEvidence(evidenceSummaryBase),
    ...(constraintEvidence !== undefined
      ? { constraintEvidencePresent: hasConstraintEvidence(evidenceSummaryBase) }
      : {}),
    ...(anchorEvidence !== undefined
      ? { anchorEvidencePresent: hasAnchorEvidence(evidenceSummaryBase) }
      : {}),
  };
  const provenanceContract = {
    policy: provenancePolicy,
    observed: {
      identityEvidenceSatisfied: hasIdentityEvidence(evidenceSummary),
      constraintEvidenceSatisfied: hasConstraintEvidence(evidenceSummary),
      anchorEvidenceSatisfied: hasAnchorEvidence(evidenceSummary),
      topEntityPresent: topEntity !== undefined,
      rankedTopResultPresent: topResult !== undefined,
      ...(topResult !== undefined && topEntity !== undefined
        ? { rankedTopResultMatchesTopEntity }
        : {}),
      matchedConstraintAttributes: matchedRequiredAttributes,
      unmetConstraintAttributes: unmetRequiredAttributes,
      anchorSignalTypes,
    },
    missing: [
      ...(provenancePolicy.requireIdentitySeal && !hasIdentityEvidence(evidenceSummary)
        ? ['identity_evidence' as const]
        : []),
      ...(provenancePolicy.requireConstraintEvidence && !hasConstraintEvidence(evidenceSummary)
        ? ['constraint_evidence' as const]
        : []),
      ...(provenancePolicy.requireAnchorEvidence && !hasAnchorEvidence(evidenceSummary)
        ? ['anchor_evidence' as const]
        : []),
    ],
  } as const;

  return {
    queryPlan: plan,
    effectiveRoute,
    ...(executionContext?.effectiveRetrievalMode !== undefined
      ? { effectiveRetrievalMode: executionContext.effectiveRetrievalMode }
      : {}),
    ...(executionContext?.retrievalKind !== undefined
      ? { retrievalKind: executionContext.retrievalKind }
      : {}),
    resolverResult,
    policy: plan.policy,
    uncertainty: plan.uncertainty,
    provenanceContract,
    ...(honestyContract?.executionMode !== undefined
      ? { executionMode: honestyContract.executionMode }
      : {}),
    ...(honestyContract?.routeHealthy !== undefined
      ? { routeHealthy: honestyContract.routeHealthy }
      : {}),
    ...(honestyContract?.blockingRequested !== undefined
      ? { blockingRequested: honestyContract.blockingRequested }
      : {}),
    ...(rankingSignals !== undefined ? { rankingSignals } : {}),
    evidenceSummary,
    ...(topResult !== undefined ? { evidenceItems: topResult.evidenceItems } : {}),
    conformalSetSize: resolverResult.conformalSetSize,
  };
}
