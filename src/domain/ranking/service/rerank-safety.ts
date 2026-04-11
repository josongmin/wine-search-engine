import type { RerankSafetyResult } from '../model/score-decomposition.js';
import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';

/**
 * E5-T2: Rerank Safety Envelope.
 *
 * Evaluates whether a candidate is safe to rerank via LTR. Applied before
 * `applyLearnedLtrRerank()` in the ranker pipeline.
 *
 * Safety rules (RFC E5 §design — rank/normalized invariants):
 *
 *   Rule 1 (hard_constraint_violation):
 *     A candidate that fails any hard constraint CANNOT be promoted above
 *     a candidate that satisfies all hard constraints. Its heuristic rank
 *     is the ceiling.
 *
 *   Rule 2 (rank_invariant_breach):
 *     After applying LTR scores, if the proposed rank ordering would place
 *     a hard-constraint-failing candidate ABOVE a passing one → block.
 *
 *   Rule 3 (protected_candidate_eviction):
 *     A candidate with sparseRank=1 OR exact-anchor evidence (anchorSimilarity ≥ threshold)
 *     is "protected". If LTR would move it to rank > its heuristic rank + EVICTION_SLACK → block.
 *
 * NOT a rule: raw score ratio comparisons (ltrScore < heuristicScore × 0.5).
 *   The safety envelope operates on rank direction + constraint membership, not raw ratios.
 */

/**
 * Minimum anchor similarity to classify a candidate as anchor-protected.
 * A candidate with anchorSimilarity ≥ this value cannot be evicted by LTR
 * beyond PROTECTED_CANDIDATE_EVICTION_SLACK positions.
 */
const ANCHOR_PROTECTION_SIMILARITY_THRESHOLD = 0.85;

/**
 * Maximum rank positions a protected candidate (exact-anchor or sparse rank-1)
 * is allowed to fall due to LTR reranking.
 *
 * Rationale: exact-anchor candidates have strong recall evidence; allowing
 * them to fall more than this many positions suggests the LTR model is
 * misfiring on known-item queries.
 */
const PROTECTED_CANDIDATE_EVICTION_SLACK = 2;

// ─── Candidate descriptor for safety evaluation ──────────────────────────────

/**
 * Minimal descriptor for a single candidate entering the safety evaluation.
 * The safety envelope reads only the fields it needs — it does NOT access
 * the full RankedResult or internal ScoredEntry.
 */
export interface SafetyCandidateDescriptor {
  readonly entityId: string;
  /** Pre-rerank heuristic rank (1-based). */
  readonly heuristicRank: number;
  /** Whether all hard constraints are satisfied by this candidate. */
  readonly hardConstraintPass: boolean;
  /** List of hard constraint attribute names that FAILED for this candidate. */
  readonly hardConstraintViolations: readonly string[];
  /** Anchor similarity score, if available. 0 when absent. */
  readonly anchorSimilarity: number;
  /** Sparse BM25 rank from retrieval (1-based). Infinity when absent. */
  readonly sparseRank: number;
  /** Normalized heuristic score in [0, 1]. */
  readonly heuristicScoreNormalized: number;
  /** Proposed LTR rank (1-based). Infinity when LTR did not rank this candidate. */
  readonly proposedLtrRank: number;
}

// ─── List-level context ───────────────────────────────────────────────────────

/**
 * List-level context — pre-computed aggregate over all candidates in the batch.
 * Passed to evaluateRerankSafety() so candidate-level checks can use list info.
 */
export interface RerankSafetyListContext {
  /**
   * True if there exists at least one candidate with hardConstraintPass=true
   * in the pre-rerank list. Used for Rule 1 — if no candidate passes hard
   * constraints, Rule 1 cannot block anything.
   */
  readonly anyHardConstraintPassingCandidate: boolean;

  /**
   * Set of entity IDs that pass all hard constraints.
   * Used for Rule 2 (rank invariant breach check).
   */
  readonly hardConstraintPassingIds: ReadonlySet<string>;

  /**
   * The best (lowest-numbered) heuristic rank held by any hard-constraint-passing
   * candidate. Used for Rule 2: a non-passing candidate is blocked if LTR would
   * place it strictly above this position (proposedRank < bestHardConstraintPassingRank).
   *
   * Undefined when no candidate passes hard constraints (Rule 2 cannot fire).
   */
  readonly bestHardConstraintPassingRank: number | undefined;

  /**
   * Entity ID of the rank-1 candidate in heuristic ordering.
   * Used for gap-delta check.
   */
  readonly heuristicRank1Id: string | undefined;
}

// ─── Core safety evaluation ───────────────────────────────────────────────────

/**
 * Evaluate whether a single candidate is safe to have its LTR rank applied.
 *
 * Returns `allowed: true` when all invariants hold.
 * Returns `allowed: false` with `blockedReason` when an invariant would be violated.
 *
 * @param candidate     Descriptor for the candidate being evaluated.
 * @param listContext   Pre-computed list-level aggregate context.
 * @param _hardConstraintAtoms  Full ConstraintAtom list (hard tier only).
 *                              Reserved for future attribute-level checks.
 */
export function evaluateRerankSafety(
  candidate: SafetyCandidateDescriptor,
  listContext: RerankSafetyListContext,
  _hardConstraintAtoms: readonly ConstraintAtom[],
): RerankSafetyResult {
  // Rule 1: Hard constraint violation — candidate fails hard constraints and
  // LTR is trying to promote it. Block the promotion unconditionally: a
  // constraint-failing candidate must never move above its heuristic position
  // when compliant candidates exist.
  if (
    !candidate.hardConstraintPass &&
    listContext.anyHardConstraintPassingCandidate &&
    candidate.proposedLtrRank < candidate.heuristicRank
  ) {
    return {
      allowed: false,
      blockedReason: 'hard_constraint_violation',
      constraintViolations: [...candidate.hardConstraintViolations],
      metrics: {
        heuristicScoreNormalized: candidate.heuristicScoreNormalized,
        preRerankRank: candidate.heuristicRank,
        postRerankRank: candidate.proposedLtrRank,
      },
    };
  }

  // Rule 2: Rank invariant breach — LTR would place a non-passing candidate
  // ABOVE a candidate that satisfies all hard constraints. We detect this by
  // checking whether the proposed rank is strictly better (lower number) than
  // the best (lowest-numbered) rank currently held by any passing candidate.
  if (!candidate.hardConstraintPass && listContext.bestHardConstraintPassingRank !== undefined) {
    if (candidate.proposedLtrRank < listContext.bestHardConstraintPassingRank) {
      return {
        allowed: false,
        blockedReason: 'rank_invariant_breach',
        constraintViolations: [...candidate.hardConstraintViolations],
        metrics: {
          heuristicScoreNormalized: candidate.heuristicScoreNormalized,
          preRerankRank: candidate.heuristicRank,
          postRerankRank: candidate.proposedLtrRank,
        },
      };
    }
  }

  // Rule 3: Protected candidate eviction.
  // A candidate is protected if:
  //   - sparseRank === 1 (top BM25 hit = high recall confidence), OR
  //   - anchorSimilarity >= ANCHOR_PROTECTION_SIMILARITY_THRESHOLD
  const isExactAnchorProtected =
    candidate.anchorSimilarity >= ANCHOR_PROTECTION_SIMILARITY_THRESHOLD;
  const isSparseRank1Protected = candidate.sparseRank === 1;
  const isProtected = isExactAnchorProtected || isSparseRank1Protected;

  if (isProtected) {
    const allowedWorstRank = candidate.heuristicRank + PROTECTED_CANDIDATE_EVICTION_SLACK;
    if (candidate.proposedLtrRank > allowedWorstRank) {
      return {
        allowed: false,
        blockedReason: 'protected_candidate_eviction',
        metrics: {
          heuristicScoreNormalized: candidate.heuristicScoreNormalized,
          preRerankRank: candidate.heuristicRank,
          postRerankRank: candidate.proposedLtrRank,
        },
      };
    }
  }

  return { allowed: true };
}

// ─── List-level context builder ───────────────────────────────────────────────

/**
 * Build the list-level context from a batch of candidate descriptors.
 * Called once per reranking pass before iterating candidates.
 */
export function buildRerankSafetyListContext(
  candidates: readonly SafetyCandidateDescriptor[],
): RerankSafetyListContext {
  const hardConstraintPassingIds = new Set<string>();
  let heuristicRank1Id: string | undefined;
  let minRank = Infinity;
  let bestHardConstraintPassingRank: number | undefined;

  for (const c of candidates) {
    if (c.hardConstraintPass) {
      hardConstraintPassingIds.add(c.entityId);
      if (bestHardConstraintPassingRank === undefined || c.heuristicRank < bestHardConstraintPassingRank) {
        bestHardConstraintPassingRank = c.heuristicRank;
      }
    }
    if (c.heuristicRank < minRank) {
      minRank = c.heuristicRank;
      heuristicRank1Id = c.entityId;
    }
  }

  return {
    anyHardConstraintPassingCandidate: hardConstraintPassingIds.size > 0,
    hardConstraintPassingIds,
    bestHardConstraintPassingRank,
    heuristicRank1Id,
  };
}
