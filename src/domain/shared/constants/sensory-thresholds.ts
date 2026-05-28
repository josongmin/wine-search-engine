/**
 * Canonical sensory thresholds on the normalized [0,1] catalog scale.
 *
 * These constants bridge lexical categorical palate intents
 * ("sweet", "dry", "full-bodied", "light-bodied") onto the numeric sensory
 * fields used by retrieval promotion, candidate evidence, and ranking.
 */

export const BODY_FULL_MIN = 0.7;
export const BODY_LIGHT_MAX = 0.3;
export const BODY_MEDIUM_MIN = 0.4;
export const BODY_MEDIUM_MAX = 0.6;

export const SWEETNESS_DRY_MAX = 0.2;
export const SWEETNESS_SWEET_MIN = 0.5;
export const SWEETNESS_OFF_DRY_MIN = 0.2;
export const SWEETNESS_OFF_DRY_MAX = 0.6;
