import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { DecisionInput, EvidenceSummary } from '../../domain/decision/model/decision-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { SignalSet } from '../../domain/shared/types/index.js';

/**
 * Assembles {@link DecisionInput} from planner output, resolver output, and optional ranking.
 * RFC-007 §4 — ranking signals and evidence wiring for the Decision Engine.
 */
export function buildSearchDecisionInput(
  plan: QueryPlanV1,
  resolverResult: EntityResolveResult,
  rankedResults?: readonly RankedResult[],
): DecisionInput {
  const topResult = rankedResults?.[0];

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

  const identityEvidencePresent =
    (rankedResults !== undefined && rankedResults.length > 0) ||
    resolverResult.topEntity !== undefined;

  const anchorEvidencePresent =
    plan.route === 'mixed' && resolverResult.topEntity !== undefined;

  const evidenceSummary: EvidenceSummary = {
    identityEvidencePresent,
    ...(topResult !== undefined
      ? {
          constraintEvidencePresent: topResult.componentScores.hardConstraintPass,
          evidenceRefCount: topResult.evidenceItems.length,
        }
      : {}),
    ...(anchorEvidencePresent ? { anchorEvidencePresent } : {}),
  };

  return {
    queryPlan: plan,
    resolverResult,
    policy: plan.policy,
    uncertainty: plan.uncertainty,
    ...(rankingSignals !== undefined ? { rankingSignals } : {}),
    evidenceSummary,
    ...(topResult !== undefined ? { evidenceItems: topResult.evidenceItems } : {}),
    conformalSetSize: resolverResult.conformalSetSize,
  };
}
