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
 * The default check targets precomposed Hangul syllables (U+AC00–U+D7A3),
 * which is sufficient for normalized user queries.
 */

/**
 * Tests whether the input contains at least one precomposed Hangul syllable.
 * Use this for the default "is Korean" check on user queries — anything
 * normalized to NFC will land in this range.
 */
const HANGUL_SYLLABLES_RE = /[\uAC00-\uD7A3]/u;
export function containsHangul(text: string): boolean {
  return HANGUL_SYLLABLES_RE.test(text);
}
