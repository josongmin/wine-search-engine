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
import type { SignalSet } from '../../domain/shared/types/index.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
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
): DecisionInput {
  const topResult = rankedResults?.[0];
  const topEntity = resolverResult.topEntity;
  const resolverTopCandidate = resolverResult.candidates[0];

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
  const requiredConstraintAttributes = unique(
    plan.constraints.hard.map((constraint) => constraint.attribute),
  );
  const matchedRequiredAttributes =
    topResult !== undefined
      ? unique(
          (topResult.matchedConstraints ?? []).filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];
  const unmetRequiredAttributes =
    topResult !== undefined
      ? unique(
          (topResult.unmetConstraints ?? []).filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];

  const identityEvidence: NonNullable<EvidenceSummary['identityEvidence']> = {
    topEntityPresent: topEntity !== undefined,
    resolverTopCandidateMatchesTopEntity,
    resolverEvidenceRefCount,
    ...(topResult !== undefined ? { rankedTopResultPresent: true } : {}),
    ...(topResult !== undefined && topEntity !== undefined
      ? { rankedTopResultMatchesTopEntity }
      : {}),
    ...(topResult !== undefined
      ? { rankedEvidenceItemCount: (topResult.evidenceItems ?? []).length }
      : {}),
    ...(resolverTopCandidateMatchesTopEntity
      ? { exactMatchCandidatePresent: resolverTopCandidate.calibratedScore >= 0.99 }
      : {}),
  };

  const constraintEvidence =
    topResult !== undefined
      ? {
          requiredAttributes: requiredConstraintAttributes,
          matchedRequiredAttributes,
          unmetRequiredAttributes,
          inferredAttributes: unique(topResult.inferredConstraints ?? []),
        }
      : undefined;

  const anchorEvidenceRequired = effectiveRoute === 'mixed' && plan.anchors.length > 0;
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
                (topResult.evidenceItems ?? []).some((item) => item.type === 'anchor_similarity'),
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
    ...(anchorEvidence !== undefined ? { anchorEvidence } : {}),
    ...((resolverEvidenceRefCount > 0 || topResult !== undefined)
      ? {
          evidenceRefCount:
            resolverEvidenceRefCount +
              (rankedTopResultMatchesTopEntity ? (topResult.evidenceItems ?? []).length : 0),
        }
      : {}),
  };
  const evidenceSummary: EvidenceSummary = {
    ...evidenceSummaryBase,
    identityEvidencePresent: hasIdentityEvidence(evidenceSummaryBase),
    ...(constraintEvidence !== undefined
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
    ...(rankingSignals !== undefined ? { rankingSignals } : {}),
    evidenceSummary,
    ...(topResult !== undefined ? { evidenceItems: topResult.evidenceItems ?? [] } : {}),
    conformalSetSize: resolverResult.conformalSetSize,
  };
}
