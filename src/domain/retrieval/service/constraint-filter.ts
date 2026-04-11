import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { CandidateDropRecord } from '../model/candidate-envelope.js';

/**
 * Post-retrieval constraint gate.
 *
 * Architecture note — why two passes instead of three:
 *
 * The original design had a triple gate:
 *   (1) Vespa YQL WHERE clause (retrieval time)
 *   (2) applyHardFilters() — memory filter (post-retrieval)
 *   (3) Ranker hardConstraintPass → -Infinity → coarse prune
 *
 * Gates (2) and (3) were semantically redundant: both removed candidates that
 * violated hard constraints. But (2) ran BEFORE protected-recall policy, so it
 * could kill high-confidence recall-protected candidates before the ranker even
 * saw them. This caused silent no-results for queries where geography metadata
 * is imperfect (e.g. "Bordeaux AOC" ≠ "Bordeaux" under exact match).
 *
 * Current design — 2-gate:
 *   (1) Vespa YQL WHERE — broad pre-filter at index level (recall-oriented)
 *   (2) Ranker hardConstraintPass → -Infinity → coarse prune (precision gate)
 *
 * This class now acts as a **soft gate**: it partitions candidates into
 * compliant and non-compliant buckets, but only removes non-compliant
 * candidates when the result set remains above a minimum recall floor.
 * Protected-recall candidates (sparse rank 1, known-item, anchor-conditioned)
 * are NEVER removed regardless of hard constraint status — the ranker gives
 * them -Infinity and the coarse prune handles them cleanly.
 */
export class ConstraintFilter {
  /**
   * Soft-gate: retain candidates that violate hard constraints when:
   *   (a) doing so is required to maintain minimum recall floor, OR
   *   (b) the candidate is protected (sparse rank 1 / anchor).
   *
   * The ranker's coarse prune (hardConstraintPass → -Infinity) is the
   * authoritative precision gate. This method only early-exits non-compliant
   * candidates when there are enough compliant ones to fill the result set.
   *
   * @param candidates - Pool annotated with matchedConstraints / unmetHardConstraints.
   * @param constraints - Hard constraints from the query plan.
   * @param minRecallFloor - Minimum number of candidates to retain even if
   *   non-compliant (default 10 — enough for ranker diversity).
   */
  applyHardFilters(
    candidates: readonly HybridCandidate[],
    constraints: readonly NormalizedConstraint[],
    minRecallFloor = 10,
  ): readonly HybridCandidate[] {
    if (constraints.length === 0) {
      return candidates;
    }

    const compliant: HybridCandidate[] = [];
    const nonCompliant: HybridCandidate[] = [];

    for (const candidate of candidates) {
      const unmet = candidate.unmetHardConstraints ?? [];
      // Protected candidates (sparse rank 1 / anchor-conditioned) are NEVER removed
      // regardless of hard constraint status — the ranker's hardConstraintPass assigns
      // -Infinity and handles them via the coarse prune. Removing them here would drop
      // the most likely correct answer for known-item queries before the ranker sees it.
      const isProtected =
        candidate.sparseRank === 1 ||
        candidate.anchorRank !== undefined;
      if (unmet.length === 0 || isProtected) {
        compliant.push(candidate);
      } else {
        nonCompliant.push(candidate);
      }
    }

    // If compliant pool already meets the recall floor, drop non-compliant
    // candidates — the ranker does not need to see constraint violators.
    if (compliant.length >= minRecallFloor) {
      return compliant;
    }

    // Below floor: retain non-compliant candidates to preserve ranker diversity.
    // The ranker's coarse prune (hardConstraintPass → -Infinity) is the
    // authoritative gate. Preserving them here costs nothing: they score
    // -Infinity and are removed before final ranking.
    return candidates;
  }

  /**
   * E4: Variant of applyHardFilters() that also returns a drop log.
   *
   * Returns:
   *   filtered — same result as applyHardFilters() (compliant or full list).
   *   drops    — CandidateDropRecord[] for every non-compliant, non-protected
   *              candidate that was actually removed.
   *
   * When the compliant pool is below minRecallFloor, NO candidates are
   * removed, so drops is always empty in that case.
   */
  applyHardFiltersWithDropLog(
    candidates: readonly HybridCandidate[],
    constraints: readonly NormalizedConstraint[],
    minRecallFloor = 10,
  ): { filtered: readonly HybridCandidate[]; drops: readonly CandidateDropRecord[] } {
    if (constraints.length === 0) {
      return { filtered: candidates, drops: [] };
    }

    const compliant: HybridCandidate[] = [];
    const dropped: HybridCandidate[] = [];

    for (const candidate of candidates) {
      const unmet = candidate.unmetHardConstraints ?? [];
      const isProtected =
        candidate.sparseRank === 1 ||
        candidate.anchorRank !== undefined;
      if (unmet.length === 0 || isProtected) {
        compliant.push(candidate);
      } else {
        dropped.push(candidate);
      }
    }

    // Only materialise the drop log when candidates are actually removed.
    if (compliant.length >= minRecallFloor) {
      const drops: CandidateDropRecord[] = dropped.map((candidate) => {
        const channels: CandidateDropRecord['channels'][number][] = [];
        if (candidate.sparseRank !== undefined) {
          channels.push({
            channel: 'sparse_bm25',
            rawScore: candidate.sparseRawScore ?? 0,
            rank: candidate.sparseRank,
          });
        }
        if (candidate.denseRank !== undefined) {
          channels.push({
            channel: 'dense_semantic',
            rawScore: candidate.denseRawScore ?? 0,
            rank: candidate.denseRank,
          });
        }
        if (candidate.learnedSparseRank !== undefined) {
          channels.push({
            channel: 'learned_sparse',
            rawScore: candidate.learnedSparseRawScore ?? 0,
            rank: candidate.learnedSparseRank,
          });
        }
        if (candidate.anchorRank !== undefined) {
          channels.push({
            channel: 'anchor_similarity',
            rawScore: candidate.anchorRawScore ?? 0,
            rank: candidate.anchorRank,
          });
        }
        return {
          entityId: candidate.entityId,
          dropStage: 'hard_filter',
          dropReason: (candidate.unmetHardConstraints ?? []).join(', '),
          // TODO(cleanup): remove retrievalFusionScore fallback after migration
          lastKnownScore: candidate.fusionRrfTotal ?? candidate.sparseRawScore ?? 0,
          channels,
        };
      });
      return { filtered: compliant, drops };
    }

    // Below recall floor — nothing removed, no drops.
    return { filtered: candidates, drops: [] };
  }
}
