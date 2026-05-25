/**
 * Korean Correct Language Rate (CLR) monitoring.
 *
 * Detects code-switching: a Korean-dominant query that received an
 * English-heavy answer. Emits a `CLR_CODE_SWITCH` warn-level diagnostic
 * that does NOT affect scoring (no criticalFailure, no score multiplier) —
 * UX-only signal surfaced to the operator.
 *
 * Split from {@link ./scorer.ts} during the 2026-05-25 decomposition.
 */

import type { Diagnostic } from './scorer.js';

/** Hangul syllable blocks (U+AC00–U+D7A3). */
const HANGUL_SYLLABLE_BLOCK_START = 0xAC00;
const HANGUL_SYLLABLE_BLOCK_END = 0xD7A3;
/** Hangul Jamo (U+1100–U+11FF). */
const HANGUL_JAMO_START = 0x1100;
const HANGUL_JAMO_END = 0x11FF;
/** Hangul Compatibility Jamo (U+3130–U+318F). */
const HANGUL_COMPAT_JAMO_START = 0x3130;
const HANGUL_COMPAT_JAMO_END = 0x318F;

/**
 * Fraction of characters in `text` that are Hangul (Korean syllable blocks
 * U+AC00–U+D7A3 plus Hangul Jamo U+1100–U+11FF and Compatibility Jamo
 * U+3130–U+318F). Used to decide whether a query / answer is "Korean-dominant".
 */
function hangulCharFraction(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= HANGUL_SYLLABLE_BLOCK_START && cp <= HANGUL_SYLLABLE_BLOCK_END)
      || (cp >= HANGUL_JAMO_START && cp <= HANGUL_JAMO_END)
      || (cp >= HANGUL_COMPAT_JAMO_START && cp <= HANGUL_COMPAT_JAMO_END)
    ) {
      count++;
    }
  }
  return count / text.length;
}

/**
 * Minimum Hangul fraction in a query to classify it as "Korean" for CLR purposes.
 * 0.20 = at least 1 in 5 chars is Hangul — a short mixed Korean/English query like
 * "보르도 Cabernet 추천" (26 chars, 8 Hangul ≈ 30%) passes the threshold.
 */
const KOREAN_QUERY_HANGUL_THRESHOLD = 0.20;

/**
 * Minimum Hangul fraction expected in a Korean-query answer. Below this threshold
 * the agent is considered to have code-switched to English.
 * 0.10 = 1 in 10 chars is Hangul — very permissive (wine names are English proper nouns).
 * Catches severe code-switching (pure-English answer to a Korean question).
 */
const KOREAN_ANSWER_HANGUL_THRESHOLD = 0.10;

/**
 * Emits a CLR_CODE_SWITCH diagnostic when a Korean query receives an English-heavy answer.
 * Severity is always 'warn' — code-switching is a UX issue, not a correctness failure.
 * This diagnostic does NOT affect scoring (no criticalFailure, no score multiplier).
 */
export function emitKoreanClrDiagnostic(
  query: string,
  answer: string,
  diagnostics: Diagnostic[],
): void {
  const queryHangulFraction = hangulCharFraction(query);
  if (queryHangulFraction < KOREAN_QUERY_HANGUL_THRESHOLD) return; // not a Korean query

  const answerHangulFraction = hangulCharFraction(answer);
  if (answerHangulFraction < KOREAN_ANSWER_HANGUL_THRESHOLD) {
    const PERCENT_MULTIPLIER = 100;
    diagnostics.push({
      dim: 'answerQuality',
      severity: 'warn',
      code: 'CLR_CODE_SWITCH',
      message: `Korean query received English-heavy answer (query Hangul=${(queryHangulFraction * PERCENT_MULTIPLIER).toFixed(0)}%, answer Hangul=${(answerHangulFraction * PERCENT_MULTIPLIER).toFixed(0)}%)`,
      observed: answerHangulFraction,
      expected: KOREAN_ANSWER_HANGUL_THRESHOLD,
    });
  }
}
