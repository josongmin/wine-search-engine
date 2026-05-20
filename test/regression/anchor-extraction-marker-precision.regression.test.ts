/**
 * Regression: anchor-extraction marker precision.
 *
 * The maturity-3 audit flagged that Korean mixed-query markers ("같은",
 * "처럼", "보다") are detected via bare substring regex, which produces
 * false positives in idiomatic / temporal phrases such as:
 *   - "가솔린처럼 가볍다" (idiom — "처럼" not a wine-anchor comparison)
 *   - "어제와 같은 와인"    (temporal "같은" — no entity anchor)
 *   - "wines like Mom's old recipe" (English idiom)
 *
 * These regressions lock in:
 *   1. True comparison / similarity queries still flag positive.
 *   2. Idiomatic / temporal usages do NOT flag positive (false-positive guard).
 *   3. Deterministic behavior (same input → same output, 5 runs).
 *   4. Korean + English mixed surfaces still work.
 *   5. Special-char entity names (e.g. "Château d'Yquem") survive Unicode
 *      boundary handling.
 *
 * Bumps nlu.anchor-extraction maturity 3 → 4.
 */

import { describe, expect, it } from 'vitest';
import {
  hasComparisonMarkers,
  hasKoreanMixedQueryMarkers,
} from '../../src/domain/query/service/anchor-extractor.js';

describe('anchor-extraction marker precision (regression)', () => {
  // ── True positives ────────────────────────────────────────────────────────

  it('flags Korean comparison particle 비교 in "Opus One과 Sassicaia 비교"', () => {
    const query = 'Opus One과 Sassicaia 비교';
    expect(hasComparisonMarkers(query)).toBe(true);
  });

  it('flags Korean similarity marker 같은 in "Opus One 같은 와인"', () => {
    const query = 'Opus One 같은 와인';
    expect(hasKoreanMixedQueryMarkers(query)).toBe(true);
  });

  it('flags Korean + English mixed surface "Opus One 같은 wine"', () => {
    const query = 'Opus One 같은 wine';
    expect(hasKoreanMixedQueryMarkers(query)).toBe(true);
  });

  it('flags English "vs" between entities', () => {
    expect(hasComparisonMarkers('Opus One vs Sassicaia')).toBe(true);
  });

  it('flags 비슷한 (similar to) with adjacent entity', () => {
    expect(hasKoreanMixedQueryMarkers('마고 비슷한 와인')).toBe(true);
  });

  it('flags 말고 (instead of) with adjacent entity', () => {
    expect(hasKoreanMixedQueryMarkers('카베르네 말고 피노누아')).toBe(true);
  });

  // ── False-positive guards ─────────────────────────────────────────────────

  it('rejects 처럼 in idiomatic phrase "가솔린처럼 가볍다" (no comparison)', () => {
    // "가솔린처럼" is an idiomatic simile, not a wine-anchor comparison.
    // The query has no entity anchor adjacent to a comparison particle.
    expect(hasComparisonMarkers('가솔린처럼 가볍다')).toBe(false);
  });

  it('rejects 같은 in temporal phrase "어제와 같은 와인" (idiomatic, no entity anchor)', () => {
    // "어제와 같은" = "same as yesterday" — 같은 here is temporal, not
    // similarity to a wine entity. Without an entity-like span adjacent to
    // 같은, this must NOT trigger mixed-query handling.
    expect(hasKoreanMixedQueryMarkers('어제와 같은 와인')).toBe(false);
  });

  it('rejects English idiomatic "like" in "wines like Mom\'s old recipe"', () => {
    // No comparison marker (vs, versus, compared to). "like" alone is not a
    // comparison-anchor trigger — confirms the comparison surface is
    // conservative.
    expect(hasComparisonMarkers("wines like Mom's old recipe")).toBe(false);
  });

  it('rejects empty / attribute-only query "좋은 와인 추천"', () => {
    expect(hasKoreanMixedQueryMarkers('좋은 와인 추천')).toBe(false);
    expect(hasComparisonMarkers('좋은 와인 추천')).toBe(false);
  });

  it('rejects plain recommendation "Bordeaux 추천" (single non-comparison anchor)', () => {
    expect(hasKoreanMixedQueryMarkers('Bordeaux 추천')).toBe(false);
    expect(hasComparisonMarkers('Bordeaux 추천')).toBe(false);
  });

  // ── Multi-anchor / deterministic surfaces ─────────────────────────────────

  it('flags both comparison surfaces in "Opus One과 Bordeaux 비교"', () => {
    const query = 'Opus One과 Bordeaux 비교';
    expect(hasComparisonMarkers(query)).toBe(true);
  });

  it('detects 보다 (more than) with adjacent entity "Barolo보다 묵직한"', () => {
    expect(hasKoreanMixedQueryMarkers('Barolo보다 묵직한')).toBe(true);
  });

  // ── Determinism: same input → same output across 5 runs ───────────────────

  it('produces deterministic marker detection (5x identical runs)', () => {
    const query = 'Opus One 같은 wine';
    const results = Array.from({ length: 5 }, () => ({
      mixed: hasKoreanMixedQueryMarkers(query),
      compare: hasComparisonMarkers(query),
    }));
    for (const result of results) {
      expect(result.mixed).toBe(true);
      expect(result.compare).toBe(false);
    }
  });

  // ── Unicode hygiene (rule 5, rule 8) ──────────────────────────────────────

  it('handles special-char entity name "Château d\'Yquem 같은" without crash', () => {
    // Accented Latin + apostrophe + Korean marker. Must not crash and must
    // detect the similarity marker.
    const query = "Château d'Yquem 같은 와인";
    expect(() => hasKoreanMixedQueryMarkers(query)).not.toThrow();
    expect(hasKoreanMixedQueryMarkers(query)).toBe(true);
  });

  it('handles decomposed Hangul jamo input without crash', () => {
    // NFD-decomposed "같은" = U+1100 U+1161 ... — rare in production but
    // must not throw. Result may be false (decomposed form is not the
    // composed marker), which is acceptable as long as it does not crash.
    const decomposed = '갓은';
    expect(() => hasKoreanMixedQueryMarkers(decomposed)).not.toThrow();
    expect(() => hasComparisonMarkers(decomposed)).not.toThrow();
  });

  it('flags emoji-adjacent comparison "Opus One 🍷 vs Sassicaia"', () => {
    // Emoji must not disrupt the comparison-marker boundary.
    expect(hasComparisonMarkers('Opus One 🍷 vs Sassicaia')).toBe(true);
  });
});
