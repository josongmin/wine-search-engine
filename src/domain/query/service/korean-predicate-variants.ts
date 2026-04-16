/**
 * Korean Predicate Variant Generator
 *
 * Generates adnominal (관형형) variants from connective (연결형) Korean
 * predicate endings. This is a well-defined morphological transformation,
 * not a heuristic — Korean connective→adnominal mappings are regular and
 * productive.
 *
 * Purpose: the NL mapper's DEFAULT_MAPPINGS use adnominal forms ("높은",
 * "좋은", "풍부한") but user queries often use connective forms ("높고",
 * "좋고", "풍부하고"). Instead of duplicating every mapping, we generate
 * variants before lookup.
 *
 * Transformation rules (order matters — more specific patterns first):
 *   하고 → 한   (하다 verbs: 풍부하고→풍부한, 묵직하고→묵직한)
 *   없고 → 없는  (없다: 타닌 없고→타닌 없는)
 *   있고 → 있는  (있다: 바디감 있고→바디감 있는)
 *   고 → 은     (regular adjectives: 높고→높은, 좋고→좋은, 낮고→낮은)
 *   하며 → 한
 *   없으며 → 없는
 *   하면서 → 한
 *   하지만 → 한
 *   며 → 은     (regular adjectives: 높며→높은)
 *   면서 → 은   (regular adjectives: 높으면서→높은)  — strips 으면서
 *   지만 → 은   (regular adjectives: 높지만→높은)
 */

/**
 * Connective→adnominal suffix replacement rules.
 * Order matters: more specific (longer) suffixes must come before shorter ones
 * to prevent partial matches (e.g. "하고" before "고").
 *
 * Each entry: [connective suffix to match, adnominal replacement]
 */
const SUFFIX_RULES: readonly (readonly [string, string])[] = [
  // 하다-verb connective forms → 한 (adnominal)
  ['하고', '한'],
  ['하며', '한'],
  ['하면서', '한'],
  ['하지만', '한'],
  // 없다 connective forms → 없는
  ['없고', '없는'],
  ['없으며', '없는'],
  ['없으면서', '없는'],
  ['없지만', '없는'],
  // 있다 connective forms → 있는
  ['있고', '있는'],
  ['있으며', '있는'],
  ['있으면서', '있는'],
  ['있지만', '있는'],
  // Regular adjective connective forms → 은 (adnominal)
  // These are last because they are the least specific (single char "고")
  ['으면서', '은'],
  ['으며', '은'],
  ['지만', '은'],
  ['고', '은'],
  ['며', '은'],
];

/**
 * Generates adnominal (관형형) variants from a phrase that may end with
 * a connective (연결형) Korean predicate ending.
 *
 * Returns the original phrase PLUS any adnominal variants.
 * If no transformation applies, returns a single-element array with just
 * the original phrase.
 *
 * @example
 * generateKoreanPredicateVariants("높고")    // → ["높고", "높은"]
 * generateKoreanPredicateVariants("풍부하고") // → ["풍부하고", "풍부한"]
 * generateKoreanPredicateVariants("좋은")    // → ["좋은"] (already adnominal)
 * generateKoreanPredicateVariants("high")    // → ["high"] (no Korean suffix)
 */
export function generateKoreanPredicateVariants(phrase: string): readonly string[] {
  if (phrase.length === 0) {
    return [phrase];
  }

  for (const [suffix, replacement] of SUFFIX_RULES) {
    if (phrase.endsWith(suffix)) {
      const stem = phrase.slice(0, -suffix.length);
      // Guard: don't produce empty-stem variants (e.g. bare "고" → "은" is not useful)
      if (stem.length === 0) {
        continue;
      }
      const variant = stem + replacement;
      // Don't add duplicate if variant === original (shouldn't happen with current rules)
      if (variant === phrase) {
        continue;
      }
      return [phrase, variant];
    }
  }

  return [phrase];
}
