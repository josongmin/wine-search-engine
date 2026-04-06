import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { CounterfactualReject } from '../../domain/response/model/counterfactual.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';

/**
 * RFC-008 §5 — resolver alternates + ranked tail beyond the response window.
 */
export function buildSearchCounterfactuals(
  resolverResult: EntityResolveResult,
  rankedResults: readonly RankedResult[],
  topResultWindow: number = 5,
): readonly CounterfactualReject[] {
  const counterfactuals: CounterfactualReject[] = [];
  const topEntityId = resolverResult.topEntity?.entityId;

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
    }
  }

  if (rankedResults.length > topResultWindow) {
    for (const result of rankedResults.slice(topResultWindow)) {
      counterfactuals.push({
        entityId: result.entityId,
        canonicalLabel: result.canonicalLabel,
        rejectedReason:
          `Lower ranking (rank ${result.rank}/${rankedResults.length}); ` +
          `final_score=${result.finalScore.toFixed(3)}, ` +
          `hard_constraint_pass=${String(result.componentScores.hardConstraintPass)}`,
      });
    }
  }

  return counterfactuals;
}
