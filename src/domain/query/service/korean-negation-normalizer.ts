/**
 * Korean Negation Normalizer
 *
 * Structural preprocessing layer that canonicalizes ALL Korean predicative
 * negation forms to the postpositional form "말고" before constraint extraction.
 *
 * This eliminates the need to enumerate every Korean negation ending
 * (아닌, 아니고, 않고, 않은, 않는, 않았던, ...) in the extraction regex.
 * The existing NEGATION_SUBJECT_AFTER pattern already handles "말고" — this
 * normalizer ensures all other negation forms route through the same path.
 *
 * Korean predicative negation forms:
 *   아니다 conjugations: 아닌, 아니고, 아닌데, 아니라, 아니면
 *   않다 conjugations:   않고, 않은, 않는, 않았던, 않으면
 *
 * Emphasis particles (도/조차/까지) between subject and negation are stripped:
 *   "샴페인도 아니고" → "샴페인 말고"
 *   "이탈리아산도 아닌" → "이탈리아산 말고"
 *
 * This is a well-defined morphological transformation — Korean negation
 * endings are regular and finite (copula 이다/아니다 + auxiliary 않다).
 */

/**
 * Korean predicative negation suffixes (endings of 아니다/않다 conjugations).
 * Ordered longest-first to prevent partial matches.
 * Anchored to Unicode non-letter/non-digit boundary via the consuming regex.
 */
const PREDICATIVE_NEGATION_ENDINGS: readonly string[] = [
  // 아니다 conjugations (longer first)
  '아닌데',
  '아니라',
  '아니면',
  '아니고',
  '아닌',
  // 않다 conjugations (longer first)
  '않았던',
  '않으면',
  '않는',
  '않은',
  '않고',
];

/**
 * Korean emphasis/additive particles that can appear between the subject noun
 * and the negation ending: "샴페인**도** 아니고", "이탈리아산**도** 아닌".
 * Stripped during normalization so the subject is clean for entity resolution.
 */
const EMPHASIS_PARTICLES: readonly string[] = ['도', '조차', '까지'];

/**
 * Build a single regex that matches: SUBJECT + optional emphasis particle + negation ending.
 *
 * The regex captures the subject (group 1) and replaces the whole match
 * with "SUBJECT 말고" — the canonical postpositional negation form.
 */
const NEGATION_NORMALIZE_RE = new RegExp(
  // Subject: 1+ Korean/Latin/digit characters (non-greedy to avoid over-capture)
  `([\\p{L}\\p{N}]+?)` +
  // Optional emphasis particle
  `(?:${EMPHASIS_PARTICLES.join('|')})?` +
  // Optional whitespace
  `\\s*` +
  // Predicative negation ending (alternation, longest first)
  `(?:${PREDICATIVE_NEGATION_ENDINGS.join('|')})` +
  // Boundary: end of string or non-letter/non-digit
  `(?=$|[^\\p{L}\\p{N}])`,
  'gu',
);

/**
 * Normalizes Korean predicative negation forms to canonical "말고" form.
 *
 * "프랑스 아닌 유럽" → "프랑스 말고 유럽"
 * "샴페인도 아니고"  → "샴페인 말고"
 * "이탈리아산도 아닌" → "이탈리아산 말고"
 * "카베르네 않고"    → "카베르네 말고"
 *
 * English text passes through unchanged (no Korean negation endings to match).
 */
export function normalizeKoreanNegation(query: string): string {
  return query.replace(NEGATION_NORMALIZE_RE, '$1 말고');
}
