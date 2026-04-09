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
 *   - extractVintageYear: returns the first vintage year as a number, or null
 *   - stripVintageYears: removes all vintage years from a string (label cleanup)
 *   - isVintageYearToken: token-level guard (e.g., for stopword filtering)
 */

/** Bare regex source for "19xx or 20xx" — compose into larger patterns. */
export const VINTAGE_YEAR_RAW = '(?:19|20)\\d{2}';

/** Strip-mode regex (global, no boundaries) for label cleanup. */
const VINTAGE_STRIP_RE = /(?:19|20)\d{2}/gu;

/** Extract-mode regex with Unicode word boundaries (no letter/digit adjacent). */
const VINTAGE_EXTRACT_RE = /(?<![\p{L}\p{N}])((?:19|20)\d{2})(?![\p{L}\p{N}])/u;

/** Token-equality regex (anchored) for filtering single-token year strings. */
const VINTAGE_TOKEN_RE = /^(?:19|20)\d{2}$/;

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
 * Removes all 4-digit vintage years from a string. Used for wine label
 * cleanup before alias matching ("Opus One 2018" → "Opus One ").
 */
export function stripVintageYears(text: string): string {
  return text.replace(VINTAGE_STRIP_RE, '');
}

/**
 * Tests whether a single token is a vintage year. Used by query normalizers
 * that filter year tokens out of stopword analysis.
 */
export function isVintageYearToken(token: string): boolean {
  return VINTAGE_TOKEN_RE.test(token);
}
