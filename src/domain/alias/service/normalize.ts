/**
 * Lightweight alias normalisation primitives — shared between ETL alias
 * artifact builders and runtime fuzzy lookup.
 *
 * Kept separate from the heavier {@link buildAliasLookupPlan} pipeline so
 * the ETL doesn't need to pull the runtime alias-matcher graph just to
 * canonicalise a string.
 */

/** Unicode combining diacritical marks block: U+0300 through U+036F. */
const COMBINING_DIACRITICS = /[̀-ͯ]/gu;

/**
 * Normalises a surface form for matching: lowercases, strips combining
 * diacritical marks (accents), and collapses contiguous whitespace to a
 * single space.
 *
 * Pipeline: NFD decompose → drop combining marks → NFC recompose →
 * lowercase → collapse whitespace → trim.
 *
 * @param input - The raw input string.
 * @returns The canonical form used for alias index keys.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
