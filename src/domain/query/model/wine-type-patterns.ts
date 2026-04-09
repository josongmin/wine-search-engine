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
  [/(?:^|[^\p{L}\p{N}])(?:sparkling|스파클링|champagne|샴페인|prosecco|cava|크레망)(?=$|[^\p{L}\p{N}])/iu, 'sparkling'],
  // Use lookarounds (not \b) because \b is ASCII-aware and 'é' is not a word char,
  // which would break the trailing word boundary on "rosé".
  [/(?:^|[^\p{L}\p{N}])(?:ros[eé]|로제)(?=$|[^\p{L}\p{N}])/iu, 'rosé'],
  [/(?:^|[^\p{L}\p{N}])(?:natural wine|내추럴 와인|내추럴)(?=$|[^\p{L}\p{N}])/iu, 'natural'],
  [/(?:^|[^\p{L}\p{N}])(?:dessert wines?|디저트 와인|sauternes|icewine)(?=$|[^\p{L}\p{N}])/iu, 'dessert'],
  [/(?:^|[^\p{L}\p{N}])(?:fortified|주정강화|port|sherry|madeira|marsala)(?=$|[^\p{L}\p{N}])/iu, 'fortified'],
  [/(?:^|[^\p{L}\p{N}])(?:orange wine|오렌지 와인|amber wine)(?=$|[^\p{L}\p{N}])/iu, 'orange'],
] as const;

/**
 * Quick-check patterns for intent detection: "does the query mention ANY wine type?"
 * Derived from WINE_TYPE_RULES — these are intentionally broader (no canonical value needed).
 *
 * Usage: `WINE_TYPE_DETECTION_PATTERNS.some(re => re.test(query))`
 */
export const WINE_TYPE_DETECTION_PATTERNS: readonly RegExp[] =
  WINE_TYPE_RULES.map(([pattern]) => pattern);
