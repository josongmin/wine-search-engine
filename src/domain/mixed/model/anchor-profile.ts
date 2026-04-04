import type { EntityId } from '../../shared/types/index.js';

/**
 * Detailed profile of an anchor entity used for "wines like X" queries.
 *
 * Built by the {@link AnchorProfiler} from a resolved entity's data.
 * Used by the similarity scorer to find wines that share characteristics
 * with the anchor while allowing for user-specified constraints to modify
 * the search space.
 */
export interface AnchorProfile {
  /** The resolved entity this profile represents. */
  readonly entityId: EntityId;

  /** Canonical display label (e.g. "Opus One 2018"). */
  readonly canonicalLabel: string;

  /** Wine region (e.g. "Napa Valley", "Bordeaux"). */
  readonly region: string;

  /** Grape varieties used in this wine. */
  readonly grapes: readonly string[];

  /** Body level on a 1-5 scale (1 = light, 5 = full). */
  readonly body: number;

  /** Sweetness level on a 1-5 scale (1 = bone dry, 5 = sweet). */
  readonly sweetness: number;

  /** Style descriptor (e.g. "bold red", "crisp white", "sparkling"). */
  readonly style: string;

  /** Pre-computed embedding vector for nearest-neighbor similarity search. */
  readonly embedding?: readonly number[] | undefined;

  /**
   * Confidence that the anchor entity was correctly resolved, in [0, 1].
   * Derived from the resolution pipeline's calibrated confidence.
   */
  readonly anchorConfidence: number;
}
