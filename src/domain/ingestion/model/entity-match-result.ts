import type { CanonicalEntityId } from '../../shared/types/index.js';

/**
 * The outcome status of an entity matching attempt.
 *
 * - `matched`              — Unambiguous match to one or more existing entities.
 * - `ambiguous`            — Multiple plausible matches; requires human review.
 * - `new_entity_candidate` — No match found; the candidate may become a new entity.
 * - `rejected`             — The candidate was rejected (spam, abuse, etc.).
 */
export type EntityMatchStatus = 'matched' | 'ambiguous' | 'new_entity_candidate' | 'rejected';

/**
 * Result of attempting to match a {@link CanonicalizationCandidate} against
 * the existing entity catalog.
 */
export interface EntityMatchResult {
  /** Outcome of the matching attempt. */
  readonly status: EntityMatchStatus;
  /** Entity IDs that were matched (present when status is 'matched' or 'ambiguous'). */
  readonly matchedEntityIds?: readonly CanonicalEntityId[] | undefined;
  /** Confidence of the match in [0, 1]. */
  readonly confidence: number;
  /** Human-readable reasons explaining the match decision. */
  readonly reasons: readonly string[];
}
