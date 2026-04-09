import type { AliasType } from '../model/alias.js';
import type {
  AliasConflict,
  AliasConflictEntry,
  AliasConflictResolution,
} from '../model/alias-conflict.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';

/**
 * Type priority weights for conflict resolution scoring.
 * Higher weight = stronger claim to the alias.
 * See RFC-003 §4.4.1.
 */
const TYPE_PRIORITY_WEIGHTS: Readonly<Record<AliasType, number>> = {
  canonical: 1.0,
  translation: 0.95,
  phonetic: 0.85,
  misspelling: 0.6,
  observed_query_alias: 0.7,
  catalog_noise_alias: 0.4,
};

/**
 * Minimum margin between winner and runner-up scores required for
 * auto-resolution. Conflicts with margin below this threshold must
 * be registered in the ambiguity registry for manual review.
 */
const AUTO_RESOLVE_MARGIN_THRESHOLD = 0.2;

/**
 * Computes a conflict-resolution score for a single alias claim.
 *
 * Formula: typePriorityWeight(type) * confidencePrior * sourceTrust * (1 - scopeMismatchPenalty)
 *
 * The scopeMismatchPenalty is 0 (no penalty) when the alias scope matches
 * the query context. Since conflict resolution operates on raw claims without
 * a query context, penalty is always 0 here; downstream matchers may apply
 * scope penalties.
 *
 * @param entry - The alias conflict entry to score.
 * @returns The computed score in [0, 1].
 */
function computeScore(entry: AliasConflictEntry): number {
  const typeWeight = TYPE_PRIORITY_WEIGHTS[entry.aliasType];
  const scopePenalty = 0; // No query context in conflict resolution
  return typeWeight * entry.confidencePrior * entry.sourceTrust * (1 - scopePenalty);
}

/**
 * Resolves alias conflicts per RFC-003 §4.4.1.
 *
 * Auto-resolution criteria:
 * - Type priority is clearly higher for one entity.
 * - Prior confidence is >= 0.9 vs <= 0.5.
 * - Scope differs (non-overlapping claims).
 * - The margin between winner and runner-up is >= 0.2.
 *
 * Returns `null` when the margin is too small, indicating the conflict
 * should be forwarded to the ambiguity registry.
 */
export class ConflictResolver {
  /**
   * Attempts to resolve an alias conflict.
   *
   * @param conflict - The conflict to resolve.
   * @returns A resolution if auto-resolvable, or `null` if manual review is needed.
   */
  resolveConflict(conflict: AliasConflict): AliasConflictResolution | null {
    const entries = conflict.conflictingEntities;

    if (entries.length < 2) {
      // No actual conflict with fewer than 2 claimants
      if (entries.length === 1) {
        return {
          winnerId: entries[0]!.entityId,
          score: computeScore(entries[0]!),
          margin: 1.0,
          method: 'auto',
        };
      }
      return null;
    }

    // Score all entries and sort descending with NaN-safe comparator and a
    // deterministic tiebreaker (entityId) so equal-score conflicts resolve
    // the same way across processes. (Bugbash R19)
    const scored = entries
      .map((entry) => ({ entry, score: computeScore(entry) }))
      .sort(
        compareScoreWithTiebreaker<{ entry: AliasConflictEntry; score: number }>(
          (s) => s.score,
          (s) => String(s.entry.entityId),
        ),
      );

    const winner = scored[0]!;
    const runnerUp = scored[1]!;
    const margin = winner.score - runnerUp.score;

    if (margin < AUTO_RESOLVE_MARGIN_THRESHOLD) {
      // Margin too small for auto-resolution
      return null;
    }

    return {
      winnerId: winner.entry.entityId,
      score: winner.score,
      margin,
      method: 'auto',
    };
  }
}
