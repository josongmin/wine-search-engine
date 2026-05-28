/**
 * Korean Negation Normalizer
 *
 * Structural preprocessing layer that canonicalizes Korean copular negation
 * (`아니다` family) to the postpositional form "말고" before constraint extraction.
 *
 * This eliminates the need to enumerate every Korean copular negation ending
 * (아닌, 아니고, 아닌데, 아니라, ...) in the extraction regex.
 * The existing NEGATION_SUBJECT_AFTER pattern already handles "말고" — this
 * normalizer ensures all other negation forms route through the same path.
 *
 * IMPORTANT: `않다` conjugations are intentionally EXCLUDED here. They are
 * not a safe structural synonym for postpositional exclusion:
 *
 *   "존재하지않는 와인"  -> non-existence / failure signal
 *   "달지 않은 와인"     -> local attribute negation
 *
 * Rewriting those to `X 말고` corrupts the query into an exclusion clause and
 * can fabricate region/grape NOT-filters downstream. Dedicated phrase-level
 * parsers must handle `않다` forms instead of this global subject rewriter.
 *
 * Emphasis particles (도/조차/까지) between subject and negation are stripped:
 *   "샴페인도 아니고" → "샴페인 말고"
 *   "이탈리아산도 아닌" → "이탈리아산 말고"
 *
 * This is a well-defined copular transformation — Korean `아니다`
 * endings are regular and finite.
 */

/**
 * Korean copular negation suffixes (`아니다` conjugations).
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
 * English text passes through unchanged (no Korean negation endings to match).
 */
export function normalizeKoreanNegation(query: string): string {
  return query.replace(NEGATION_NORMALIZE_RE, '$1 말고');
}
