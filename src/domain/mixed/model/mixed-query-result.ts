import type { ConstraintBundle } from '../../shared/types/index.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';
import type { AnchorProfile } from './anchor-profile.js';
import type { MixedDegradationState } from './mixed-degradation.js';

/**
 * Result of a mixed query ("wines like X but ...") execution.
 *
 * Contains the resolved anchor profile, ranked similar wines with
 * constraint overlays applied, and diagnostic metrics about how well
 * the anchor's characteristics were preserved in the result set.
 */
export interface MixedQueryResult extends MixedDegradationState {
  /** The resolved anchor entity profile. */
  readonly anchor: AnchorProfile;

  /** Ranked results ordered by combined anchor-similarity and constraint satisfaction. */
  readonly rankedResults: readonly RankedResult[];

  /**
   * The constraint bundle that was overlaid on top of anchor similarity.
   * Includes hard, soft, and inferred constraints.
   */
  readonly constraintOverlay: ConstraintBundle;

  /**
   * Fraction of ranked results that preserved core anchor characteristics
   * (region, grape overlap, style). In [0, 1].
   *
   * A low rate may indicate that user constraints conflict with anchor
   * characteristics (e.g. "wines like Opus One but from Burgundy").
   */
  readonly anchorPreservationRate: number;
}
