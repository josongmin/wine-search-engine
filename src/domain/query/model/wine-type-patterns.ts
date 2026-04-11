/**
 * Canonical wine type detection patterns — single source of truth.
 *
 * Used by:
 *   - rule-based-constraint-extractor.ts (hard constraint extraction)
 *   - planner-intent-detection.ts (intent signal: "does query mention a wine type?")
 *
 * Each entry maps a RegExp (Unicode-safe, no \b) to a canonical wine_type value.
 * Patterns use (?:^|[^\p{L}\p{N}])...(?=$|[^\p{L}\p{N}]) boundaries because
 * \b is ASCII-only and silently fails on Korean/accented characters (CLAUDE.md rule 8).
 *
 * Wine type taxonomy: red, white, rosé, sparkling, natural, dessert, fortified, orange.
 * Source: Vivino / Wine-Searcher product classification (2024).
 */

/** A canonical wine type value as stored in the search index. */
export type WineTypeValue = 'red' | 'white' | 'rosé' | 'sparkling' | 'natural' | 'dessert' | 'fortified' | 'orange';

/**
 * Ordered list of [pattern, canonicalValue] for wine type detection.
 * Order matters: first match wins (e.g. "sparkling rosé" → sparkling).
 */
export const WINE_TYPE_RULES: readonly (readonly [RegExp, WineTypeValue])[] = [
  [/(?:^|[^\p{L}\p{N}])(?:red|rouge|레드|적포도주)(?=$|[^\p{L}\p{N}])/iu, 'red'],
  [/(?:^|[^\p{L}\p{N}])(?:white|blanc|화이트|백포도주)(?=$|[^\p{L}\p{N}])/iu, 'white'],
  // Sparkling before rosé: "sparkling rosé" should resolve to sparkling (primary characteristic).
  [/(?:^|[^\p{L}\p{N}])(?:sparkling|스파클링|champagne|샴페인|prosecco|프로세코|cava|카바|크레망)(?=$|[^\p{L}\p{N}])/iu, 'sparkling'],
  // Use lookarounds (not \b) because \b is ASCII-aware and 'é' is not a word char,
  // which would break the trailing word boundary on "rosé".
  [/(?:^|[^\p{L}\p{N}])(?:ros[eé]|로제)(?=$|[^\p{L}\p{N}])/iu, 'rosé'],
  [/(?:^|[^\p{L}\p{N}])(?:natural wine|내추럴 와인|내추럴)(?=$|[^\p{L}\p{N}])/iu, 'natural'],
  [/(?:^|[^\p{L}\p{N}])(?:dessert wines?|디저트 와인|sauternes|icewine)(?=$|[^\p{L}\p{N}])/iu, 'dessert'],
  [/(?:^|[^\p{L}\p{N}])(?:fortified|주정강화|port|sherry|madeira|marsala)(?=$|[^\p{L}\p{N}])/iu, 'fortified'],
  [/(?:^|[^\p{L}\p{N}])(?:orange wine|오렌지 와인|amber wine)(?=$|[^\p{L}\p{N}])/iu, 'orange'],
] as const;

/**
 * Set of all canonical wine type values (lowercase) derived from {@link WINE_TYPE_RULES}.
 *
 * Used for membership checks — e.g. "is this token a wine type rather than a
 * style/flavor descriptor?" — without duplicating the wine type vocabulary.
 */
export const WINE_TYPE_VALUES: ReadonlySet<string> = new Set<string>(
  WINE_TYPE_RULES.map(([, value]) => value),
);

/**
 * Quick-check patterns for intent detection: "does the query mention ANY wine type?"
 * Derived from WINE_TYPE_RULES — these are intentionally broader (no canonical value needed).
 *
 * Usage: `WINE_TYPE_DETECTION_PATTERNS.some(re => re.test(query))`
 */
export const WINE_TYPE_DETECTION_PATTERNS: readonly RegExp[] =
  WINE_TYPE_RULES.map(([pattern]) => pattern);

/**
 * Non-canonical aliases accepted for enum matching (e.g. user input "rose" → canonical "rosé").
 * Only add entries where the canonical value itself is NOT sufficient for string comparison.
 */
const WINE_TYPE_ALIASES: Partial<Record<WineTypeValue, readonly string[]>> = {
  'rosé': ['rose'],
};

/**
 * Korean-language wine type tokens — canonical Korean names used in negation/exclusion
 * detection by search-constraint-extractor (e.g. "스파클링 빼고" → exclude sparkling).
 *
 * These must be kept in sync with the Korean alternatives in WINE_TYPE_RULES patterns.
 * Values are lowercase for Set membership check consistency with `token.toLowerCase()`.
 *
 * Source: WINE_TYPE_RULES regex alternatives (lines matching /스파클링|샴페인|.../).
 */
const WINE_TYPE_KOREAN_TOKENS: readonly string[] = [
  // sparkling
  '스파클링', '샴페인', '프로세코', '카바', '크레망',
  // red
  '레드', '적포도주',
  // white
  '화이트', '백포도주',
  // rosé
  '로제',
  // natural / natural wine — '자연' (nature) intentionally excluded: it is too broad
  // ('자연산' = wild-caught seafood, '자연인' = naturalist) and has no regex in WINE_TYPE_RULES.
  '내추럴',
  // dessert
  // NOTE: '달콤한' (sweet/sweetness) is intentionally NOT listed here. It is a
  // style/taste descriptor, not a wine type. Including it caused excludeStyleSet to
  // emit `style_not:달콤한` — a Korean token that never matches Vespa's English-valued
  // style field ("sweet", "dry", etc.). Handle Korean sweetness negation in
  // search-constraint-extractor.ts via the STYLE_CANONICAL_MAP instead.
  '디저트',
  // fortified
  '주정강화',
  // orange
  '오렌지',
];

/**
 * All recognized wine type tokens — canonical values + aliases + Korean tokens.
 * Used by search-constraint-extractor for membership checks (e.g. "is '스파클링' a wine type?").
 * Includes accent-less aliases so "not rose" and Korean tokens like "스파클링 빼고"
 * are correctly identified as wine type exclusions.
 */
export const WINE_TYPE_ALL_TOKENS: ReadonlySet<string> = new Set<string>([
  ...WINE_TYPE_VALUES,
  ...Object.values(WINE_TYPE_ALIASES).flat(),
  ...WINE_TYPE_KOREAN_TOKENS,
]);

/**
 * Mutual exclusivity groups for wine types, derived from WINE_TYPE_RULES.
 *
 * Each group is an array of accepted string values for one canonical wine type.
 * Two constraints whose values fall in different groups are contradictory.
 *
 * Used by ConstraintSAT — kept here to stay in sync with the canonical type list.
 */
export const WINE_TYPE_EXCLUSIVITY_GROUPS: readonly (readonly string[])[] =
  WINE_TYPE_RULES.map(([, canonical]) => {
    const aliases = WINE_TYPE_ALIASES[canonical];
    return aliases ? [canonical, ...aliases] : [canonical];
  });
