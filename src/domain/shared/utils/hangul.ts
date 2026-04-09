/**
 * Hangul (한글) detection utilities (SSoT).
 *
 * The previous codebase had `[\uAC00-\uD7A3]` redefined in 8+ files, with
 * subtle inconsistencies — some used the syllables block only, others
 * extended to Jamo / Compatibility Jamo. This module centralizes the
 * canonical ranges and exposes guard functions so query classifiers,
 * LTR feature extractors, and agent prompts all agree on what "contains
 * Korean" means.
 *
 * Three ranges are kept:
 *   - HANGUL_SYLLABLES (U+AC00–U+D7A3): the precomposed syllable block.
 *     Sufficient for all real-world Korean queries (modern + legacy text
 *     normalized to NFC). This is the default `containsHangul` check.
 *   - HANGUL_JAMO (U+1100–U+11FF): conjoining Jamo, used internally by
 *     IME composition. Real input is rare.
 *   - HANGUL_COMPAT_JAMO (U+3130–U+318F): compatibility Jamo, common in
 *     legacy KS X 1001 text.
 *
 * `containsHangulExtended` covers all three so detection is robust against
 * pre-composed and decomposed forms.
 */

/** Precomposed Hangul syllables (U+AC00–U+D7A3). */
export const HANGUL_SYLLABLES_RANGE = 'AC00-D7A3' as const;

/** Conjoining Jamo (U+1100–U+11FF). */
export const HANGUL_JAMO_RANGE = '1100-11FF' as const;

/** Compatibility Jamo (U+3130–U+318F). */
export const HANGUL_COMPAT_JAMO_RANGE = '3130-318F' as const;

/**
 * Tests whether the input contains at least one precomposed Hangul syllable.
 * Use this for the default "is Korean" check on user queries — anything
 * normalized to NFC will land in this range.
 */
const HANGUL_SYLLABLES_RE = /[\uAC00-\uD7A3]/u;
export function containsHangul(text: string): boolean {
  return HANGUL_SYLLABLES_RE.test(text);
}

/**
 * Tests whether the input contains any Hangul codepoint, including Jamo
 * (conjoining + compatibility). Use this when input may not be normalized
 * (raw IME output, partially-decomposed legacy data).
 */
const HANGUL_EXTENDED_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/u;
export function containsHangulExtended(text: string): boolean {
  return HANGUL_EXTENDED_RE.test(text);
}

/**
 * First codepoint of the precomposed Hangul Syllables block (U+AC00 = '가').
 * Hoisted to module scope so the comparator in {@link countHangulSyllables}
 * is named instead of magic.
 */
const HANGUL_SYLLABLES_FIRST_CODEPOINT = 0xac00;
/**
 * Last codepoint of the precomposed Hangul Syllables block (U+D7A3 = '힣').
 */
const HANGUL_SYLLABLES_LAST_CODEPOINT = 0xd7a3;

/**
 * Counts the number of Hangul syllable codepoints in the input. Use for
 * mixed-language detection (e.g., 50%+ Hangul → Korean-dominant query).
 */
export function countHangulSyllables(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (
      cp !== undefined
      && cp >= HANGUL_SYLLABLES_FIRST_CODEPOINT
      && cp <= HANGUL_SYLLABLES_LAST_CODEPOINT
    ) {
      n++;
    }
  }
  return n;
}
