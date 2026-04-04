/**
 * All recognized ambiguity types that the resolver can detect,
 * per RFC-006 §7.
 */
export const AMBIGUITY_TYPES = [
  'wine_vs_producer',
  'wine_vs_region',
  'multi_vintage',
  'alias_collision',
  'producer_family_collision',
  'underspecified_short_form',
] as const;

/**
 * A specific kind of ambiguity detected among resolution candidates.
 */
export type AmbiguityType = (typeof AMBIGUITY_TYPES)[number];

/**
 * The ambiguity classification result for a set of resolution candidates.
 */
export interface AmbiguityState {
  /** Whether any ambiguity was detected. */
  readonly detected: boolean;

  /** The specific ambiguity types found. Empty when `detected` is false. */
  readonly types: readonly AmbiguityType[];

  /** Severity of the overall ambiguity situation. */
  readonly severity: 'low' | 'medium' | 'high';
}
