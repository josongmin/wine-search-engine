/**
 * Tests for korean-predicate-variants.ts
 *
 * Verifies connective→adnominal morphological transformation for Korean
 * predicate endings used in wine search queries.
 */

import { describe, it, expect } from 'vitest';
import {
  generateKoreanPredicateVariants,
  normalizeQueryPredicates,
} from '../korean-predicate-variants.js';

describe('generateKoreanPredicateVariants', () => {
  // ── Regular adjective -고 → -은 ──────────────────────────────────
  it('"높고" → ["높고", "높은"]', () => {
    expect(generateKoreanPredicateVariants('높고')).toEqual(['높고', '높은']);
  });

  it('"좋고" → ["좋고", "좋은"]', () => {
    expect(generateKoreanPredicateVariants('좋고')).toEqual(['좋고', '좋은']);
  });

  it('"낮고" → ["낮고", "낮은"]', () => {
    expect(generateKoreanPredicateVariants('낮고')).toEqual(['낮고', '낮은']);
  });

  // ── 하다 verb -하고 → -한 ────────────────────────────────────────
  it('"풍부하고" → ["풍부하고", "풍부한"]', () => {
    expect(generateKoreanPredicateVariants('풍부하고')).toEqual(['풍부하고', '풍부한']);
  });

  it('"묵직하고" → ["묵직하고", "묵직한"]', () => {
    expect(generateKoreanPredicateVariants('묵직하고')).toEqual(['묵직하고', '묵직한']);
  });

  it('"강렬하고" → ["강렬하고", "강렬한"]', () => {
    expect(generateKoreanPredicateVariants('강렬하고')).toEqual(['강렬하고', '강렬한']);
  });

  // ── 없다 connective -없고 → -없는 ──────────────────────────────
  it('"타닌 없고" → ["타닌 없고", "타닌 없는"]', () => {
    expect(generateKoreanPredicateVariants('타닌 없고')).toEqual(['타닌 없고', '타닌 없는']);
  });

  // ── 있다 connective -있고 → -있는 ──────────────────────────────
  it('"바디감 있고" → ["바디감 있고", "바디감 있는"]', () => {
    expect(generateKoreanPredicateVariants('바디감 있고')).toEqual(['바디감 있고', '바디감 있는']);
  });

  // ── -하며 → -한 ─────────────────────────────────────────────────
  it('"풍부하며" → ["풍부하며", "풍부한"]', () => {
    expect(generateKoreanPredicateVariants('풍부하며')).toEqual(['풍부하며', '풍부한']);
  });

  // ── -없으며 → -없는 ────────────────────────────────────────────
  it('"타닌 없으며" → ["타닌 없으며", "타닌 없는"]', () => {
    expect(generateKoreanPredicateVariants('타닌 없으며')).toEqual(['타닌 없으며', '타닌 없는']);
  });

  // ── -하면서 → -한 ──────────────────────────────────────────────
  it('"풍부하면서" → ["풍부하면서", "풍부한"]', () => {
    expect(generateKoreanPredicateVariants('풍부하면서')).toEqual(['풍부하면서', '풍부한']);
  });

  // ── -하지만 → -한 ──────────────────────────────────────────────
  it('"묵직하지만" → ["묵직하지만", "묵직한"]', () => {
    expect(generateKoreanPredicateVariants('묵직하지만')).toEqual(['묵직하지만', '묵직한']);
  });

  // ── -지만 (regular adjective) → -은 ────────────────────────────
  it('"높지만" → ["높지만", "높은"]', () => {
    expect(generateKoreanPredicateVariants('높지만')).toEqual(['높지만', '높은']);
  });

  // ── -며 (regular adjective) → -은 ─────────────────────────────
  it('"높며" → ["높며", "높은"]', () => {
    expect(generateKoreanPredicateVariants('높며')).toEqual(['높며', '높은']);
  });

  // ── 있으며 → 있는 ──────────────────────────────────────────────
  it('"바디감 있으며" → ["바디감 있으며", "바디감 있는"]', () => {
    expect(generateKoreanPredicateVariants('바디감 있으며')).toEqual(['바디감 있으며', '바디감 있는']);
  });

  // ── Multi-word phrases with context ────────────────────────────
  it('"산도 높고" → ["산도 높고", "산도 높은"]', () => {
    expect(generateKoreanPredicateVariants('산도 높고')).toEqual(['산도 높고', '산도 높은']);
  });

  it('"평점 좋고" → ["평점 좋고", "평점 좋은"]', () => {
    expect(generateKoreanPredicateVariants('평점 좋고')).toEqual(['평점 좋고', '평점 좋은']);
  });

  it('"도수 낮고" → ["도수 낮고", "도수 낮은"]', () => {
    expect(generateKoreanPredicateVariants('도수 낮고')).toEqual(['도수 낮고', '도수 낮은']);
  });

  // ── No transformation needed (already adnominal) ──────────────
  it('"좋은" → ["좋은"] (already adnominal)', () => {
    expect(generateKoreanPredicateVariants('좋은')).toEqual(['좋은']);
  });

  it('"높은" → ["높은"] (already adnominal)', () => {
    expect(generateKoreanPredicateVariants('높은')).toEqual(['높은']);
  });

  it('"풍부한" → ["풍부한"] (already adnominal)', () => {
    expect(generateKoreanPredicateVariants('풍부한')).toEqual(['풍부한']);
  });

  // ── Edge cases ────────────────────────────────────────────────
  it('empty string → [""]', () => {
    expect(generateKoreanPredicateVariants('')).toEqual(['']);
  });

  it('English "high" → ["high"] (no Korean transformation)', () => {
    expect(generateKoreanPredicateVariants('high')).toEqual(['high']);
  });

  it('accented Latin "élevé" → ["élevé"] (no Korean transformation)', () => {
    expect(generateKoreanPredicateVariants('élevé')).toEqual(['élevé']);
  });

  it('bare suffix "고" → ["고"] (no stem — skip transformation)', () => {
    // A bare suffix with no stem should not produce a variant
    expect(generateKoreanPredicateVariants('고')).toEqual(['고']);
  });

  it('emoji input "🍷고" → ["🍷고", "🍷은"] (emoji is valid stem)', () => {
    expect(generateKoreanPredicateVariants('🍷고')).toEqual(['🍷고', '🍷은']);
  });
});

describe('normalizeQueryPredicates', () => {
  it('"평점 좋고 바디감 있고" → "평점 좋은 바디감 있는"', () => {
    expect(normalizeQueryPredicates('평점 좋고 바디감 있고')).toBe('평점 좋은 바디감 있는');
  });

  it('"타닌 없고 과일향 풍부한" → "타닌 없는 과일향 풍부한"', () => {
    expect(normalizeQueryPredicates('타닌 없고 과일향 풍부한')).toBe('타닌 없는 과일향 풍부한');
  });
});
