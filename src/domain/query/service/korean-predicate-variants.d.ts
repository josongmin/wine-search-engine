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
/**
 * Normalizes an entire query string by replacing Korean connective predicate
 * endings with their adnominal form. Unlike {@link generateKoreanPredicateVariants}
 * (which generates variant lookup keys for phrase-level matching), this function
 * transforms the query IN PLACE so downstream pattern matchers (e.g., the
 * rule-based constraint extractor) see normalized forms without enumerating
 * every connective variant in their regexes.
 *
 * Operates token-by-token: each whitespace-delimited token is checked against
 * SUFFIX_RULES and replaced if a match is found.
 *
 * @example
 * normalizeQueryPredicates("평점 좋고 바디감 있고") // → "평점 좋은 바디감 있는"
 * normalizeQueryPredicates("hello world")          // → "hello world" (unchanged)
 */
export declare function normalizeQueryPredicates(query: string): string;
export declare function generateKoreanPredicateVariants(phrase: string): readonly string[];
//# sourceMappingURL=korean-predicate-variants.d.ts.map