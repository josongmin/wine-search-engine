/**
 * Query-time boost vocabulary (Single Source of Truth).
 *
 * `vespa-search-index.ts` derives three query-time boost signals
 * (`structured_region_boost`, `structured_country_boost`,
 * `structured_grape_boost`) by inspecting the raw query text for
 * mentions of well-known regions, countries, and grape varieties.
 *
 * Previously this lived inline as `query.includes('bordeaux') || ...`
 * substring matches. Substring matching is unsafe — it produces false
 * positives for compound tokens like `"new_bordeaux_style"` or
 * `"pinotage"` (which would wrongly trigger the `pinot` boost).
 *
 * SSoT discipline:
 *   - These vocabularies are the *only* place these keyword lists live.
 *   - The shared {@link queryMentionsAny} helper is the only allowed
 *     entry point for testing whether a query mentions any keyword from
 *     a vocabulary — it enforces word-aware (Unicode-safe), case-
 *     insensitive matching consistent with CLAUDE.md rule 8/24.
 *
 * TODO(infra/etl): The long-term fix is to push this signal down to the
 * Vespa schema as an `is_major_region` / `is_major_grape` / `is_major_country`
 * boolean attribute populated by the ETL pipeline, so the search-time
 * code can simply consult an indexed flag instead of pattern-matching
 * raw user text. Tracked separately from this module.
 */

/**
 * Well-known wine regions used as a query-time region boost signal.
 *
 * This list is intentionally narrow — it is NOT an exhaustive region
 * gazetteer. It captures the canonical "world-class" regions whose
 * mention in a free-text query is a strong indicator that the user
 * wants region-relevant ranking weight applied. The exhaustive region
 * catalog lives in the appellation gazetteer / Vespa attribute layer.
 */
export const MAJOR_REGION_KEYWORDS = [
  'bordeaux',
  'burgundy',
  'napa',
  'champagne',
  'rioja',
] as const;

/**
 * Well-known wine-producing countries used as a query-time country
 * boost signal. Same narrow-list rationale as {@link MAJOR_REGION_KEYWORDS}.
 */
export const MAJOR_COUNTRY_KEYWORDS = [
  'france',
  'italy',
  'spain',
  'usa',
] as const;

/**
 * Well-known grape varieties used as a query-time grape boost signal.
 * Same narrow-list rationale as {@link MAJOR_REGION_KEYWORDS}.
 */
export const MAJOR_GRAPE_KEYWORDS = [
  'cabernet',
  'merlot',
  'pinot',
  'chardonnay',
  'riesling',
] as const;

/**
 * Word-boundary prefix/suffix that is Unicode-safe (CLAUDE.md rule 8/24).
 *
 * `\b` is ASCII-only and silently fails on non-ASCII content. We use a
 * negated character class that treats any non-letter, non-digit, non-
 * underscore code point as a word boundary. The character class form
 * `[\p{L}\p{N}_]` is intentional — `_` is excluded by `\p{L}` and
 * `\p{N}`, but query tokens like `new_bordeaux_style` (snake-case
 * compound coined token) should NOT trigger the `bordeaux` boost: the
 * user did not mention Bordeaux, they used a different token that
 * embeds the substring. Treating `_` as part of a "word" is the safe
 * default for free-text query analysis.
 *
 * Note `[\p{L}\p{N}_]` is the *character class* form (letter OR digit
 * OR underscore); the sequence form `\p{L}\p{N}_` would require three
 * consecutive chars and silently mis-match — see rule 24.
 */
const WORD_BOUNDARY_PREFIX = '(?:^|[^\\p{L}\\p{N}_])';
const WORD_BOUNDARY_SUFFIX = '(?=$|[^\\p{L}\\p{N}_])';

/** Escapes regex metacharacters so a vocabulary entry is matched literally. */
function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Returns true iff `query` mentions any keyword from `vocabulary` as a
 * whole word (Unicode-safe word boundary), case-insensitive.
 *
 * Examples (with `MAJOR_REGION_KEYWORDS`):
 *   - `'bordeaux wine'`         → true
 *   - `'BORDEAUX'`              → true  (case-insensitive)
 *   - `'bordeaux,burgundy'`     → true  (comma is a non-word boundary)
 *   - `'new_bordeaux_style'`    → false (underscore is part of the "word",
 *                                        so this is treated as a single
 *                                        compound token, not `bordeaux`)
 *   - `'newbordeaux'`           → false (no boundary between `new` and `bordeaux`)
 *   - `'와인 bordeaux 추천'`     → true  (Korean word with embedded EN keyword)
 *
 * Word-boundary character set: a "word" character here is any Unicode
 * letter, digit, or underscore (`[\p{L}\p{N}_]`). Treating `_` as
 * letter-like matches JavaScript's historical `\b` semantics and
 * correctly suppresses false positives on snake-case compound tokens.
 *
 * Performance: This compiles a single combined regex per call. The
 * vocabulary lists are small (< 10 entries) so the compilation cost is
 * negligible and we avoid module-level caching to keep the API pure.
 */
export function queryMentionsAny(
  query: string,
  vocabulary: readonly string[],
): boolean {
  if (query.length === 0 || vocabulary.length === 0) return false;
  const alternation = vocabulary.map((term) => escapeRegex(term)).join('|');
  const pattern = new RegExp(
    `${WORD_BOUNDARY_PREFIX}(?:${alternation})${WORD_BOUNDARY_SUFFIX}`,
    'iu',
  );
  return pattern.test(query);
}
