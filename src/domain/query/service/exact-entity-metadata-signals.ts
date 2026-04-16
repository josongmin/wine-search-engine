/** Exact-entity metadata questions should stay on the entity route.
 * These phrases ask about a known wine's properties (price, drinkability,
 * release/availability) rather than requesting discovery/filtering.
 *
 * This module is the SSOT for:
 * - metadata/drinkability keyword detection on normalized queries
 * - suffix stripping when the raw user query should collapse to the bare entity
 */

/** Drinkability questions that still target a specific known wine. */
const DRINKABILITY_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:drinkability|drinking\s+window|when\s+to\s+drink)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:마시기\s*좋(?:아|은|을|을까|을지)?|마실\s*시기|음용\s*시기|피크)(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Exact-entity metadata keywords.
 * Korean price forms intentionally cover colloquial suffixes such as "얼마야"
 * and "얼마예요" because these are common exact-entity queries. */
const ENTITY_METADATA_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:price|cost|worth|release(?:d)?|availability|available|in\s+stock)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:가격|시세|출시|나왔어|나왔나|재고|구할\s*수\s*있|살\s*수\s*있)(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])(?:얼마(?:야|예요|에요|지|인지)?)(?=$|[^\p{L}\p{N}]|[?？!！])/u,
  ...DRINKABILITY_KEYWORDS,
] as const;

/** Metadata-only tails that should be removed before exact entity lookup. */
const EXACT_ENTITY_METADATA_SUFFIX_PATTERNS: readonly RegExp[] = [
  /(?:\s*(?:가격(?:이|은|는)?\s*)?얼마(?:야|예요|에요|지|인지)?)[?？!！]*$/u,
  /(?:\s*지금\s*마시기\s*좋(?:아|은|을까|을지)?)[?？!！]*$/u,
  /(?:\s*(?:마실\s*시기|음용\s*시기|피크(?:일까|인지)?))[?？!！]*$/u,
  /(?:\s*(?:출시(?:했|됐)?(?:어|나)?|나왔(?:어|나)?|재고\s*있(?:어|나)?|구할\s*수\s*있(?:어|나)?|살\s*수\s*있(?:어|나)?))[?？!！]*$/u,
] as const;

export function hasDrinkabilityKeyword(normalizedQuery: string): boolean {
  return DRINKABILITY_KEYWORDS.some((re) => re.test(normalizedQuery));
}

export function hasEntityMetadataKeyword(normalizedQuery: string): boolean {
  return ENTITY_METADATA_KEYWORDS.some((re) => re.test(normalizedQuery));
}

export function stripExactEntityMetadataSuffix(rawQuery: string): string {
  let stripped = rawQuery.trim();
  for (const pattern of EXACT_ENTITY_METADATA_SUFFIX_PATTERNS) {
    stripped = stripped.replace(pattern, '').trim();
  }
  return stripped.length > 0 ? stripped : rawQuery.trim();
}
