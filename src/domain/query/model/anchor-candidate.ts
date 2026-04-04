import type { EntityId } from '../../shared/types/index.js';

/**
 * A candidate anchor entity extracted from the query surface form.
 *
 * The `confidence` field represents the planner's estimate that this surface
 * form refers to the candidate entities. This is an anchor confidence score,
 * NOT a calibrated decision confidence C.
 */
export interface AnchorCandidate {
  /** The original text span as it appeared in the query. */
  readonly surfaceForm: string;

  /** Lowercased, accent-stripped, whitespace-collapsed form used for matching. */
  readonly normalizedForm: string;

  /** Entity IDs that this surface form may refer to. */
  readonly candidateEntityIds: readonly EntityId[];

  /**
   * Anchor confidence in [0, 1].
   * This is NOT a calibrated decision confidence C.
   */
  readonly confidence: number;

  /** How this anchor candidate was discovered. */
  readonly source: 'alias' | 'planner_heuristic' | 'entity_lookup';
}
