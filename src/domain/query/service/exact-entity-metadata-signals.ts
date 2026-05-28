/** Exact-entity metadata questions should stay on the entity route.
 * These phrases ask about a known wine's properties (price, drinkability,
 * release/availability) rather than requesting discovery/filtering.
 *
 * This module is the SSOT for:
 * - metadata/drinkability keyword detection on normalized queries
 * - suffix stripping when the raw user query should collapse to the bare entity
 */

/** Drinkability questions that still target a specific known wine.
 *
 * Korean inflection chain for `좋` (good / drinkable):
 *   • 좋아 / 좋은            — bare affirmative & attributive
 *   • 좋은지 / 좋은지도 / 좋은지만 — embedded-question forms (bench #15 / #117 RCA;
 *                                  the original alternation missed these and
 *                                  silently dropped the drinkability signal)
 *   • 좋은가                 — interrogative
 *   • 좋을 / 좋을까 / 좋을지  — speculative / embedded
 *   • 좋습니까               — polite interrogative
 *
 * The leading `마시기` prefix anchors the match to drinkability context, so
 * generic 좋은/좋아 in other clauses (e.g. "좋은 와인 추천해줘") cannot trigger.
 * CLAUDE.md rule 8: `\b` is avoided — Unicode boundaries via `[\p{L}\p{N}]`.
 */
const DRINKABILITY_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:drinkability|drinking\s+window|when\s+to\s+drink)(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})(?:currently\s+drinkable|drink\s+now|ready\s+to\s+drink)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:마시기\s*좋(?:아|은(?:지(?:만|도)?|가)?|을(?:까|지)?|습니까)?|마실\s*시기|음용\s*시기|피크)(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])(?:지금|현재)\s*마실\s*수\s*있(?:는|을|나|어)?(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Exact-entity metadata keywords.
 * Korean price forms intentionally cover colloquial suffixes such as "얼마야"
 * and "얼마예요" because these are common exact-entity queries. */
const ENTITY_METADATA_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:price|cost|worth|release(?:d)?|availability|available|in\s+stock)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:가격|시세|출시|출시\s*여부|나왔어|나왔나|나왔냐|나왔는지|재고|구할\s*수\s*있|살\s*수\s*있)(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])(?:얼마(?:야|예요|에요|지|인지)?)(?=$|[^\p{L}\p{N}]|[?？!！])/u,
  ...DRINKABILITY_KEYWORDS,
] as const;

/** Metadata-only tails that should be removed before exact entity lookup. */
const EXACT_ENTITY_METADATA_SUFFIX_PATTERNS: readonly RegExp[] = [
  /(?:\s*(?:가격(?:이|은|는)?\s*)?얼마(?:야|예요|에요|지|인지)?)[?？!！]*$/u,
  /(?:\s*지금\s*마시기\s*좋(?:아|은|을까|을지)?)[?？!！]*$/u,
  /(?:\s*(?:지금|현재)\s*마실\s*수\s*있(?:는|을|나|어)?)[?？!！]*$/u,
  /(?:\s*(?:마실\s*시기|음용\s*시기|피크(?:일까|인지)?))[?？!！]*$/u,
  /(?:\s*(?:vintage\s+released?\s+yet|released?\s+yet))[?？!！]*\s*(?:if\s+you\s+do\s+not\s+have\s+hard\s+evidence,\s*say\s+you\s+do\s+not\s+know|if\s+you\s+don't\s+have\s+hard\s+evidence,\s*say\s+you\s+don't\s+know)\.?[?？!！]*$/iu,
  /(?:\s*(?:if\s+you\s+do\s+not\s+have\s+hard\s+evidence,\s*say\s+you\s+do\s+not\s+know|if\s+there(?:'s| is)\s+no\s+hard\s+evidence,\s*say\s+you\s+do\s+not\s+know|if\s+you\s+don't\s+have\s+hard\s+evidence,\s*say\s+you\s+don't\s+know|if\s+unknown,\s*say\s+so))[?？!！]*$/iu,
  /(?:\s*(?:released?\s+yet|release(?:d)?(?:\s+status)?|availability|available|in\s+stock))[?？!！]*(?:\s*(?:if\s+you\s+do\s+not\s+have\s+hard\s+evidence,\s*say\s+you\s+do\s+not\s+know|if\s+there(?:'s| is)\s+no\s+hard\s+evidence,\s*say\s+you\s+do\s+not\s+know|if\s+you\s+don't\s+have\s+hard\s+evidence,\s*say\s+you\s+don't\s+know))?[?？!！]*$/iu,
  /(?:\s*(?:release(?:d)?|availability|available)\s*(?:있(?:나|어|나요)?|됐(?:나|어|나요)?))[?？!！]*(?:(?:\s*(?:확실한\s*근거\s*없으면\s*(?:추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘)|근거\s*없으면\s*(?:추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘)))?)[?？!！]*$/iu,
  /(?:\s*(?:출시(?:했|됐)?(?:어|나|냐|는지)?|출시\s*여부|나왔(?:어|나|냐|는지)?|재고\s*있(?:어|나)?|구할\s*수\s*있(?:어|나)?|살\s*수\s*있(?:어|나)?))(?:\s*(?:확실한\s*근거\s*없으면\s*(?:추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘)|근거\s*없으면\s*(?:추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘)))?[?？!！]*$/u,
  /(?:\s*(?:출시(?:했|됐)?(?:어|나|냐|는지)?|출시\s*여부|나왔(?:어|나|냐|는지)?|재고\s*있(?:어|나)?|구할\s*수\s*있(?:어|나)?|살\s*수\s*있(?:어|나)?))[?？!！]*$/u,
] as const;

/** Direct-lookup tails that should collapse back to the bare entity anchor. */
const EXACT_ENTITY_LOOKUP_SUFFIX_PATTERNS: readonly RegExp[] = [
  /(?:\s*(?:정보|설명(?:해줘|해주세요)?))[?？!！]*$/u,
  /(?:\s*(?:어떤|무슨)\s*와인이(?:야|에요|예요)?)[?？!！]*$/u,
  /(?:\s*추천(?:해줘|해주세요)?)[?？!！]*$/u,
  /(?:\s*(?:info(?:rmation)?|tell\s+me\s+about|what\s+is\s+it|recommend(?:\s+me)?|suggest(?:ion)?))[?？!！]*$/iu,
] as const;

export function hasDrinkabilityKeyword(normalizedQuery: string): boolean {
  return DRINKABILITY_KEYWORDS.some((re) => re.test(normalizedQuery));
}

export function hasEntityMetadataKeyword(normalizedQuery: string): boolean {
  return ENTITY_METADATA_KEYWORDS.some((re) => re.test(normalizedQuery));
}

export function hasExactEntityLookupKeyword(normalizedQuery: string): boolean {
  return ENTITY_METADATA_KEYWORDS.some((re) => re.test(normalizedQuery))
    || EXACT_ENTITY_LOOKUP_SUFFIX_PATTERNS.some((re) => re.test(normalizedQuery.trim()));
}

export function stripExactEntityMetadataSuffix(rawQuery: string): string {
  let stripped = rawQuery.trim();
  for (const pattern of EXACT_ENTITY_METADATA_SUFFIX_PATTERNS) {
    stripped = stripped.replace(pattern, '').trim();
  }
  return stripped.length > 0 ? stripped : rawQuery.trim();
}

export function stripExactEntityLookupSuffix(rawQuery: string): string {
  let stripped = stripExactEntityMetadataSuffix(rawQuery);
  for (const pattern of EXACT_ENTITY_LOOKUP_SUFFIX_PATTERNS) {
    stripped = stripped.replace(pattern, '').trim();
  }
  return stripped.length > 0 ? stripped : rawQuery.trim();
}
