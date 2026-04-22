export type AliasMatchConfidenceStrategy =
  | 'exact'
  | 'lexical_exact'
  | 'compact_exact'
  | 'prefix_exact'
  | 'transliterated_exact'
  | 'transliterated_prefix'
  | 'phonetic_exact'
  | 'transliterated_fuzzy'
  | 'hangul_ime_completion';

const STRATEGY_CONFIDENCE_MULTIPLIER: Readonly<Record<AliasMatchConfidenceStrategy, number>> = {
  exact: 1.0,
  lexical_exact: 1.0,
  compact_exact: 0.93,
  prefix_exact: 0.9,
  transliterated_exact: 0.91,
  transliterated_prefix: 0.89,
  phonetic_exact: 0.88,
  transliterated_fuzzy: 0.89,
  hangul_ime_completion: 0.9,
};

const ALIAS_CONFIDENCE_DECIMAL_PLACES = 6;

export function resolveAliasMatchConfidence(
  baseConfidence: number,
  strategy: AliasMatchConfidenceStrategy,
): number {
  const multiplier = STRATEGY_CONFIDENCE_MULTIPLIER[strategy];
  return Number((baseConfidence * multiplier).toFixed(ALIAS_CONFIDENCE_DECIMAL_PLACES));
}
