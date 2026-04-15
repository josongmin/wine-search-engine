/**
 * Wine style classification.
 */
export type WineStyle = 'red' | 'white' | 'sparkling' | 'rose' | 'dessert';

/**
 * Price band classification for the Korean market.
 */
export type PriceBand = 'low' | 'mid' | 'high';

/**
 * The normalized attribute space for a wine entity.
 * All numeric attributes are normalized to [0.0, 1.0].
 *
 * This is the structured representation used by constraint evaluation and scoring.
 * It is distinct from the freeform {@link EntityAttributes} in the entity domain.
 */
export interface AttributeSpace {
  /** Body score: 0.0 (light) to 1.0 (full). */
  readonly body: number;
  /** Sweetness score: 0.0 (bone dry) to 1.0 (lusciously sweet). */
  readonly sweetness: number;
  /** Acidity score: 0.0 to 1.0. */
  readonly acidity?: number;
  /** Tannin score: 0.0 to 1.0. */
  readonly tannin?: number;
  /** Wine style classification. */
  readonly style?: WineStyle;
  /** Price band classification for Korean market. */
  readonly priceBand?: PriceBand;
  /** Food pairing suggestions. */
  readonly pairing?: readonly string[];
  /** Occasion suggestions (e.g. "gift", "party", "daily"). */
  readonly occasion?: readonly string[];
}
