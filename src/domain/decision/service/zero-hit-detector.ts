/**
 * Zero-hit detector — Wave 1 (Cluster F) decision-engine asymmetry fix.
 *
 * Classifies the candidate-pool / resolver outcome so the decision engine
 * can distinguish:
 *
 *   - **`corpus_gap`**: the user asked something specific (≥1 anchor at or
 *     above {@link CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR}) but the corpus
 *     returned NO candidates. The entity is not in the catalogue.
 *     Clarification cannot help — the user cannot clarify their way to an
 *     answer for an entity that does not exist. The right next action is
 *     either a deterministic relax-and-retry (broaden filters, drop the
 *     identity-bearing constraint, recover via similar candidates) or an
 *     honest admission to the user ("not in our catalogue").
 *
 *   - **`low_confidence`**: candidates exist but every one is below the
 *     scoring floor. The existing path (clarify / hybrid_search) is
 *     correct — the system has signal to work with.
 *
 *   - **`normal`**: candidates exist with reasonable confidence. The
 *     existing decision-engine flow handles this.
 *
 * ## Why an anchor-confidence floor (not a magic confidence threshold)
 *
 * The classifier uses ONE explicit signal — anchor confidence — and ONE
 * named const ({@link CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR}). The floor
 * mirrors the existing soft→hard promotion floor in
 * `constraint-to-sparse-filter-tokens.ts`
 * (`SOFT_PROMOTION_DEFAULT_CONFIDENCE_FLOOR = 0.8`) which is itself the
 * tier-1 (rule-based) / tier-2 (entity-resolver) confidence emission
 * watermark. A query that produced an anchor at or above this floor is one
 * the planner is highly confident extracted a specific entity surface —
 * exactly the case where "we just didn't find it in the corpus" is the
 * right diagnosis.
 *
 * The floor is intentionally NOT a heuristic estimate; it is the same
 * deterministic watermark used by every other identity-bearing gate in the
 * system, sourced from the planner's deterministic confidence emission.
 */

import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';

/**
 * Anchor confidence at or above which an empty candidate pool indicates a
 * corpus gap (the user asked something specific and we didn't have it),
 * rather than low-confidence retrieval noise.
 *
 * Pinned to the tier-1 / tier-2 deterministic confidence watermark used by
 * `constraint-to-sparse-filter-tokens.ts`'s
 * `SOFT_PROMOTION_DEFAULT_CONFIDENCE_FLOOR`. NOT a heuristic — every
 * planner path that emits an anchor at or above this floor has gone through
 * either rule-based-v1.0, entity-resolver-v1.0, or the curated nl-mapper
 * v1.0 vocabulary, each of which has a deterministic-replay guarantee.
 */
export const CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR = 0.8;

/**
 * Classification of the candidate-pool / resolver outcome from the
 * decision engine's perspective. Used to choose the next-action.
 */
export type EmptyCandidatePoolClassification =
  | 'corpus_gap'
  | 'low_confidence'
  | 'normal';

/**
 * Input shape for {@link classifyEmptyCandidatePool}. Intentionally minimal
 * so this can be called from the decision-engine without coupling to the
 * full DecisionInput surface.
 */
export interface ClassifyEmptyCandidatePoolInput {
  /** Number of candidates the resolver / fused-ranker produced. */
  readonly candidateCount: number;
  /**
   * Planner-extracted anchors (with confidence). May be empty when the
   * planner could not identify any specific entity surface.
   */
  readonly anchors: readonly AnchorCandidate[];
}

/**
 * Returns the {@link EmptyCandidatePoolClassification} for the given
 * candidate-pool / anchor signal.
 *
 * Decision logic — explicit, no heuristics:
 *  1. `candidateCount === 0` AND at least one anchor with
 *     `confidence >= CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR` → `corpus_gap`.
 *     The user asked something specific; the corpus had nothing.
 *  2. `candidateCount === 0` AND no high-confidence anchors → `low_confidence`.
 *     The system has no specific identity signal AND no candidates; the
 *     existing low-confidence fallback (hybrid_search / clarify) handles
 *     this.
 *  3. `candidateCount > 0` → `normal`. Existing decision flow.
 *
 * Pure function — no I/O, no shared state.
 */
export function classifyEmptyCandidatePool(
  input: ClassifyEmptyCandidatePoolInput,
): EmptyCandidatePoolClassification {
  if (input.candidateCount > 0) {
    return 'normal';
  }
  const hasHighConfidenceAnchor = input.anchors.some(
    (anchor) =>
      Number.isFinite(anchor.confidence)
      && anchor.confidence >= CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR,
  );
  if (hasHighConfidenceAnchor) {
    return 'corpus_gap';
  }
  return 'low_confidence';
}
