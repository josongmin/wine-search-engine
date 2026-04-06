/**
 * Relational operator extracted from an anchor-conditioned or relative query.
 *
 * Maps surface-level Korean / English patterns to a canonical operator label.
 */
export type RelativeOperator =
  | 'cheaper_than'        // 보다 저렴한, less expensive than
  | 'more_expensive_than' // 보다 비싼
  | 'lighter_than'        // 보다 가벼운
  | 'fuller_than'         // 보다 묵직한
  | 'drier_than'          // 보다 드라이한
  | 'sweeter_than'        // 보다 달달한
  | 'similar_to'          // 같은, 비슷한, like, similar to
  | 'not'                 // 말고, 대신, instead of
  | 'better_than';        // 보다 좋은

/**
 * A single relative expression extracted from a user query.
 *
 * Represents one "X <operator>" phrase where X is the anchor surface form.
 */
export interface RelativeQueryExpression {
  /** The anchor entity name (surface form from user query). */
  readonly anchorSurfaceForm: string;
  /** The relational operator. */
  readonly operator: RelativeOperator;
  /**
   * Additional constraint axis implied by the operator.
   *
   * - cheaper_than / more_expensive_than → 'price_band'
   * - lighter_than / fuller_than         → 'body'
   * - drier_than / sweeter_than          → 'sweetness'
   * - similar_to / better_than / not     → omitted
   */
  readonly impliedAxis?: string;
  /** Confidence [0, 1] that this extraction is correct. */
  readonly confidence: number;
}

/**
 * Structured representation of an anchor-conditioned or relative query.
 *
 * Produced by {@link RelativeQueryExtractor} when the user query references a
 * named wine entity and expresses a relational or similarity constraint.
 */
export interface AnchorConditionedQuery {
  /** The anchor reference(s) in the query. */
  readonly anchorSurfaceForm: string;
  /** All relative expressions found. */
  readonly relativeExpressions: readonly RelativeQueryExpression[];
  /** True if this is a "wines like X" query (similarity), false if relative attribute comparison. */
  readonly isSimilarityQuery: boolean;
}
