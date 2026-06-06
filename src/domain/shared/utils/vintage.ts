/**
 * Wine vintage year utilities (SSoT).
 *
 * Realistic wine vintage years are 19xx and 20xx. Earlier (18xx) bottles exist
 * but are vanishingly rare in production catalogs and are intentionally NOT
 * matched here — including 18xx would create false positives on 4-digit numbers
 * like address fragments or postal codes.
 *
 * Each function below has different semantics:
 *   - VINTAGE_YEAR_RAW: bare regex source for composing into larger patterns
 *   - extractVintageYear: returns the first 4-digit vintage year as a number, or null
 *   - extractQueryVintageYear: query-oriented extractor that also accepts a
 *     single standalone 2-digit shorthand when at least one non-numeric token
 *     is present ("오퍼스 원 18" -> 2018)
 *   - stripVintageYears: removes all 4-digit vintage years from a string (label cleanup)
 *   - isVintageYearToken: 4-digit token-level guard (e.g., for stopword filtering)
 *   - isTwoDigitVintageToken: 2-digit shorthand guard (e.g., "18", "21")
 *   - isPotentialVintageToken: union of 4-digit and 2-digit guards
 *   - canonicalizeVintageToken: 2-digit shorthand → 4-digit canonical year ("21" → "2021")
 *
 * Two-digit canonicalization is centralized here so that query normalization,
 * label parsing, and ETL pipelines all agree on the same pivot rule. The pivot
 * is "current year mod 100": tokens at or below the pivot belong to the
 * current century, anything above belongs to the previous century. This makes
 * "24" → 2024 in 2026 and "98" → 1998, while "27" remains 1927 (no future
 * vintages assumed).
 */

/** Bare regex source for "19xx or 20xx" — compose into larger patterns. */
export const VINTAGE_YEAR_RAW = '(?:19|20)\\d{2}';

/** Strip-mode regex (global, no boundaries) for label cleanup. */
const VINTAGE_STRIP_RE = /(?:19|20)\d{2}/gu;

/**
 * Strip-mode regex with Unicode word boundaries (preserves embedded digits).
 * Korean year suffixes (년, 년산, 년대) are consumed if adjacent.
 */
const VINTAGE_STRIP_BOUNDED_RE =
  /(?<![\p{L}\p{N}])(?:19|20)\d{2}(?:년산?|년대)?(?![\p{L}\p{N}])/gu;

/**
 * Extract-mode regex with Unicode word boundaries (no letter/digit adjacent).
 *
 * Korean exception: allows `년`, `년산`, `년대` directly after the year
 * because these suffixes are part of the vintage expression ("2020년",
 * "2020년산", "2020년대"). The lookahead permits an optional Korean year
 * suffix before requiring a non-word boundary.
 */
const VINTAGE_EXTRACT_RE =
  /(?<![\p{L}\p{N}])((?:19|20)\d{2})(?:년산?|년대)?(?![\p{L}\p{N}])/u;

/** Detect-mode regex (single, with Unicode word boundaries + Korean year suffix). */
const VINTAGE_DETECT_RE =
  /(?<![\p{L}\p{N}])(?:19|20)\d{2}(?:년산?|년대)?(?![\p{L}\p{N}])/u;

/**
 * Range-mode regex with digit-only lookbehind. Matches "2018-2022", "2018~2022",
 * or "2018–2022" (en-dash). The lookbehind blocks longer numerals like
 * "12015-2020" from anchoring to the embedded year.
 */
const VINTAGE_RANGE_RE =
  /(?<!\d)((?:19|20)\d{2})[~\-–]((?:19|20)\d{2})(?!\d)/u;

/**
 * Korean "after / 이후" suffix: "2018년 이후", "2018 이후". The optional `년`
 * binds tightly to the year, then any whitespace, then the literal `이후`.
 */
const VINTAGE_KO_AFTER_RE = /((?:19|20)\d{2})년?\s*이후/u;

/**
 * Korean "before / 이전" suffix: "2020년 이전", "2020 이전".
 */
const VINTAGE_KO_BEFORE_RE = /((?:19|20)\d{2})년?\s*이전/u;

/** Token-equality regex (anchored) for filtering 4-digit single-token year strings. */
const VINTAGE_TOKEN_RE = /^(?:19|20)\d{2}$/;

/** Token-equality regex (anchored) for filtering 2-digit shorthand year strings. */
const TWO_DIGIT_VINTAGE_TOKEN_RE = /^\d{2}$/;

/**
 * Extract-mode regex for standalone 2-digit shorthand years in free-form query
 * text. Boundaries prevent matches inside longer numerals or alphanumeric IDs.
 */
const TWO_DIGIT_VINTAGE_EXTRACT_RE =
  /(?<![\p{L}\p{N}])(\d{2})(?:년산?|년대)?(?![\p{L}\p{N}])/gu;

/**
 * Returns the first vintage year found in the text, or null.
 * Uses Unicode word boundaries to avoid matching numbers embedded in words
 * (e.g., "12015" should NOT yield 2015).
 */
export function extractVintageYear(text: string): number | null {
  const match = VINTAGE_EXTRACT_RE.exec(text);
  if (match?.[1] === undefined) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Query-oriented vintage extractor.
 *
 * 1. Prefer a real 4-digit vintage token when present.
 * 2. Otherwise accept exactly one standalone 2-digit shorthand token only when
 *    the query still contains at least one letter token. This blocks bare
 *    numeric queries like "18" from being treated as semantic vintage scopes.
 *
 * Intended for lookup/query parsing, not label ETL.
 */
export function extractQueryVintageYear(text: string, referenceYear?: number): number | null {
  const fourDigitYear = extractVintageYear(text);
  if (fourDigitYear !== null) {
    return fourDigitYear;
  }
  if (!/\p{L}/u.test(text)) {
    return null;
  }
  const shorthandMatches = [...text.matchAll(TWO_DIGIT_VINTAGE_EXTRACT_RE)]
    .map((match) => match[1])
    .filter((token): token is string => token !== undefined);
  if (shorthandMatches.length !== 1) {
    return null;
  }
  const canonicalYear = canonicalizeVintageToken(shorthandMatches[0], referenceYear);
  const numericYear = Number.parseInt(canonicalYear, 10);
  return Number.isFinite(numericYear) ? numericYear : null;
}

/**
 * Removes all 4-digit vintage years from a string. Used for wine label
 * cleanup before alias matching ("Opus One 2018" → "Opus One ").
 *
 * NOTE: this strips matches even when they are adjacent to letters, which
 * is correct for label/alias normalization where the input has already been
 * delimited. Use {@link stripVintageYearsBounded} when the input is free-form
 * prose and embedded numerals (e.g., "12015") must be preserved.
 */
export function stripVintageYears(text: string): string {
  return text.replace(VINTAGE_STRIP_RE, '');
}

/**
 * Like {@link stripVintageYears} but only strips years that are bounded by
 * Unicode non-word characters (or string edges). Use this when stripping
 * vintages out of natural query text rather than label fragments.
 */
export function stripVintageYearsBounded(text: string): string {
  return text.replace(VINTAGE_STRIP_BOUNDED_RE, '');
}

/**
 * Tests whether a string contains at least one bounded vintage year token.
 * Equivalent to `extractVintageYear(text) !== null` but allocation-free,
 * useful for query classifiers that only care about presence.
 */
export function hasVintageYear(text: string): boolean {
  return VINTAGE_DETECT_RE.test(text);
}

/**
 * Extracts an inclusive vintage range from text like "2018-2022" / "2018~2022"
 * / "2018–2022". Returns `null` if no valid range is found. The returned
 * `min`/`max` is normalized so that `min <= max` even if the user wrote
 * the years in reverse order ("2022-2018"). Both years use the bounded
 * vintage pattern, so longer numerals (e.g. "12015-2020") will not match.
 */
export function extractVintageRange(
  text: string,
): { readonly min: number; readonly max: number } | null {
  const match = VINTAGE_RANGE_RE.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const lo = Number.parseInt(match[1], 10);
  const hi = Number.parseInt(match[2], 10);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
}

/**
 * Extracts a "이후" (after) constraint from Korean text. Returns the year
 * or `null`. Example: "2018년 이후" → 2018.
 */
export function extractKoreanVintageAfter(text: string): number | null {
  const match = VINTAGE_KO_AFTER_RE.exec(text);
  if (match === null || match[1] === undefined) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Extracts a "이전" (before) constraint from Korean text. Returns the year
 * or `null`. Example: "2020년 이전" → 2020.
 */
export function extractKoreanVintageBefore(text: string): number | null {
  const match = VINTAGE_KO_BEFORE_RE.exec(text);
  if (match === null || match[1] === undefined) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Tests whether a single token is a 4-digit vintage year. Used by query
 * normalizers that filter year tokens out of stopword analysis.
 */
export function isVintageYearToken(token: string): boolean {
  return VINTAGE_TOKEN_RE.test(token);
}

/**
 * Tests whether a single token is a 2-digit vintage shorthand (e.g., "21").
 * Note: this is intentionally permissive — every 2-digit number qualifies.
 * Use only on tokens that have already been segmented out of natural prose.
 */
export function isTwoDigitVintageToken(token: string): boolean {
  return TWO_DIGIT_VINTAGE_TOKEN_RE.test(token);
}

/**
 * Tests whether a token could plausibly be a vintage in either notation.
 * Equivalent to {@link isVintageYearToken} || {@link isTwoDigitVintageToken}.
 */
export function isPotentialVintageToken(token: string): boolean {
  return isVintageYearToken(token) || isTwoDigitVintageToken(token);
}

/**
 * Canonicalizes a 2-digit shorthand year token to a 4-digit year using a
 * sliding pivot anchored at the current calendar year. Returns the input
 * unchanged for any token that is not a 2-digit string. 4-digit tokens are
 * also returned unchanged so this is safe to use in token-mapping passes.
 *
 * Pivot rule (current year = `Y`, century = `Y - Y%100`):
 *   - token ≤ Y%100  → century + token   (recent vintage in current century)
 *   - token > Y%100  → century - 100 + token  (vintage in previous century)
 *
 * Example (Y=2026): "24" → "2024", "98" → "1998", "27" → "1927".
 *
 * The pivot is recomputed on every call from `Date.now()` because the list
 * of "valid recent vintages" shifts each new year. ETL or eval code that
 * needs deterministic canonicalization across runs should pass `referenceYear`.
 */
export function canonicalizeVintageToken(token: string, referenceYear?: number): string {
  if (isVintageYearToken(token)) return token;
  if (!isTwoDigitVintageToken(token)) return token;
  const yearTwoDigit = Number(token);
  if (!Number.isFinite(yearTwoDigit)) return token;
  const refYear = referenceYear ?? new Date().getFullYear();
  const currentCentury = Math.floor(refYear / 100) * 100;
  const pivot = refYear % 100;
  const canonicalYear =
    yearTwoDigit <= pivot ? currentCentury + yearTwoDigit : currentCentury - 100 + yearTwoDigit;
  return String(canonicalYear);
}
