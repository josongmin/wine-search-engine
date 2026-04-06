import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
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
 */
export function buildSearchDecisionInput(
  plan: QueryPlanV1,
  resolverResult: EntityResolveResult,
  rankedResults?: readonly RankedResult[],
  effectiveRoute: QueryRoute = plan.route,
  decisionContext?: SearchRouteDecisionContext,
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
          semantic_relevance_score: topResult.componentScores.semantic,
          preference_alignment_score: topResult.componentScores.preferenceAlignment,
          popularity_score: topResult.componentScores.popularity,
          availability_score: topResult.componentScores.availability,
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
  const requiredConstraintAttributes = unique(
    plan.constraints.hard.map((constraint) => constraint.attribute),
  );
  const matchedRequiredAttributes =
    topResult !== undefined
      ? unique(
          topResult.matchedConstraints.filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];
  const unmetRequiredAttributes =
    topResult !== undefined
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

  const admissionContext = {
    requires_identity_seal:
      plan.admission_context?.requires_identity_seal === true ||
      effectiveRoute === 'mixed',
    requires_constraint_evidence: plan.constraints.hard.length > 0,
    requires_anchor_evidence: anchorEvidenceRequired,
  } as const;

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
    ...(constraintEvidence !== undefined && topResult !== undefined
      ? {
          constraintEvidencePresent:
            topResult.componentScores.hardConstraintPass &&
            hasConstraintEvidence(evidenceSummaryBase),
        }
      : {}),
    ...(anchorEvidence !== undefined
      ? { anchorEvidencePresent: hasAnchorEvidence(evidenceSummaryBase) }
      : {}),
  };

  return {
    queryPlan: plan,
    effectiveRoute,
    resolverResult,
    policy: plan.policy,
    uncertainty: plan.uncertainty,
    admissionContext,
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
