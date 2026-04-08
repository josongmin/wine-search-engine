import { KRW_PER_MAN_WON } from '../../shared/constants.js';

/**
 * Wine style classification.
 */
export type WineStyle = 'red' | 'white' | 'sparkling' | 'rose' | 'dessert';

/**
 * Price band classification for the Korean market.
 */
export type PriceBand = 'low' | 'mid' | 'high';

/**
 * Price band boundaries in Korean Won (KRW).
 * Each band is a [min, max) range.
 */
/** Low band ceiling in 만원 units (5 × 10,000 KRW). */
const PRICE_BAND_LOW_MAX_MAN_WON_UNITS = 5;
/** Mid band ceiling in 만원 units (15 × 10,000 KRW). */
const PRICE_BAND_MID_MAX_MAN_WON_UNITS = 15;
/** ~5만원: typical "low" retail ceiling in KR market banding. */
const PRICE_BAND_LOW_MAX_KRW = PRICE_BAND_LOW_MAX_MAN_WON_UNITS * KRW_PER_MAN_WON;
/** ~15만원: upper bound of "mid" before "high" luxury band. */
const PRICE_BAND_MID_MAX_KRW = PRICE_BAND_MID_MAX_MAN_WON_UNITS * KRW_PER_MAN_WON;

export const PRICE_BAND_BOUNDARIES_KRW = {
  low: [0, PRICE_BAND_LOW_MAX_KRW],
  mid: [PRICE_BAND_LOW_MAX_KRW, PRICE_BAND_MID_MAX_KRW],
  high: [PRICE_BAND_MID_MAX_KRW, Infinity],
} as const;

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

/**
 * Determines the price band for a given price in KRW.
 *
 * @param priceKrw - The price in Korean Won.
 * @returns The corresponding price band.
 */
export function priceBandFromKRW(priceKrw: number): PriceBand {
  if (priceKrw < PRICE_BAND_BOUNDARIES_KRW.mid[0]) {
    return 'low';
  }
  if (priceKrw < PRICE_BAND_BOUNDARIES_KRW.high[0]) {
    return 'mid';
  }
  return 'high';
}
