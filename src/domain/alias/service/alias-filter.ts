/**
 * Alias validation utilities — filter out aliases that are too short or
 * otherwise invalid before insertion into the alias store.
 *
 * Rule 15: Named constant for minimum alias length (magic numbers unauditable).
 * Rule 25: Single source of truth for alias quality filters.
 */

/**
 * Minimum character length for a valid alias (after trimming).
 *
 * Domain justification: single-character aliases produce massive false positives
 * in alias matching (e.g. "A" would match any query containing the letter A).
 * Even Korean single-syllable aliases like "의" are ambiguous (particle, not a wine term).
 * 2 characters is the minimum meaningful Korean syllable combination and covers
 * abbreviated Latin codes like "RG" (region abbreviation).
 */
export const MIN_ALIAS_LENGTH = 2;

/**
 * Filters aliases to only include valid entries.
 *
 * An alias is valid when:
 * 1. Its trimmed length is ≥ MIN_ALIAS_LENGTH (filters single-char and whitespace-only).
 *
 * @param aliases - Raw alias strings to validate.
 * @returns Array of valid aliases (order preserved).
 */
export function filterValidAliases(aliases: readonly string[]): string[] {
  return aliases.filter((a) => a.trim().length >= MIN_ALIAS_LENGTH);
}
