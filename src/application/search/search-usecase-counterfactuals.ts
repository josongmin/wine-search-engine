/**
 * E4-U5: Query-Family Explanation Obligation Map
 *
 * Counterfactual and clarification obligations by query family:
 *
 *  entity_exact / entity_fuzzy  — resolver alternates as counterfactuals (primary)
 *  attribute_constrained        — ranked tail beyond window as counterfactuals
 *  comparison / compare         — anchor resolution path; no counterfactuals
 *  producer_browse / region_browse — no counterfactuals (browse families)
 *  recommendation / pairing     — preference-matched tail items as counterfactuals
 *  no_match / ambiguous         — clarification preferred over counterfactuals
 *  multi_intent                 — clarification preferred
 *
 * E4-U7: Clarification/Counterfactual Semantics Lock
 *  - counterfactuals: candidates that COULD have been top but weren't (transparency)
 *  - clarifications: queries where more info from user improves precision (ask-first)
 *  - abstain: engine withholds — not a clarification request, just a gate hold
 *  These three must remain distinct; do NOT conflate in response meta.
 */
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { CounterfactualReject } from '../../domain/response/model/counterfactual.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';

/**
 * RFC-008 §5 — resolver alternates + ranked tail beyond the response window.
 *
 * Deduplication: for hybrid/mixed routes the resolver result is synthetic —
 * its `candidates` array is built directly from `rankedResults`. This means
 * ranked-tail items (position > topResultWindow) already appear as resolver
 * alternates. We track emitted entity IDs and skip any tail item whose ID
 * was already added from the resolver-alternate section.
 */
export function buildSearchCounterfactuals(
  resolverResult: EntityResolveResult,
  rankedResults: readonly RankedResult[],
  topResultWindow: number = 5,
): readonly CounterfactualReject[] {
  const counterfactuals: CounterfactualReject[] = [];
  const topEntityId = resolverResult.topEntity?.entityId;
  const emittedEntityIds = new Set<string>();

  if (resolverResult.candidates.length > 1) {
    for (const candidate of resolverResult.candidates) {
      if (candidate.entityId === topEntityId) continue;
      counterfactuals.push({
        entityId: candidate.entityId,
        canonicalLabel: candidate.canonicalLabel,
        rejectedReason:
          `Calibrated score ${candidate.calibratedScore.toFixed(3)} below top candidate` +
          (topEntityId !== undefined
            ? ` (rank ${candidate.rank} of ${resolverResult.candidates.length})`
            : ''),
        ...(candidate.evidenceRefs[0] !== undefined
          ? { evidenceRef: candidate.evidenceRefs[0] }
          : {}),
      });
      emittedEntityIds.add(String(candidate.entityId));
    }
  }

  if (rankedResults.length > topResultWindow) {
    for (const result of rankedResults.slice(topResultWindow)) {
      // Skip duplicates: synthetic hybrid resolve results already include all
      // ranked results as resolver candidates, so tail items would be emitted twice
      // if we do not guard here.
      if (emittedEntityIds.has(String(result.entityId))) continue;
      counterfactuals.push({
        entityId: result.entityId,
        canonicalLabel: result.canonicalLabel,
        rejectedReason:
          `Lower ranking (rank ${result.rank}/${rankedResults.length}); ` +
          `final_score=${result.finalScore.toFixed(3)}, ` +
          `hard_constraint_pass=${String(result.componentScores.hardConstraintPass)}`,
      });
      emittedEntityIds.add(String(result.entityId));
    }
  }

  return counterfactuals;
}
