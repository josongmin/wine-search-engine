import { describe, it, expect } from 'vitest';

import {
  deriveKoreanSurfaceVariants,
  type KoreanSurfaceVariant,
} from '../korean-surface-form-expander.js';

function surfacesByRule(
  variants: readonly KoreanSurfaceVariant[],
  rule: KoreanSurfaceVariant['rule'],
): readonly string[] {
  return variants.filter((v) => v.rule === rule).map((v) => v.surface);
}

describe('deriveKoreanSurfaceVariants', () => {
  it('produces V1 spacing-removed, V2 iconic-token, V3 first-syllable for "샤또 마고"', () => {
    const variants = deriveKoreanSurfaceVariants('샤또 마고');

    expect(surfacesByRule(variants, 'spacing_removed')).toEqual(['샤또마고']);
    // V2 spaced "마고" and V2 compact "마고" collapse to one entry.
    expect(surfacesByRule(variants, 'iconic_token')).toEqual(['마고']);
    expect(surfacesByRule(variants, 'first_syllable_initialism')).toEqual(['샤마']);
  });

  it('drops 도멘 prefix and skips V3 because of single-syllable tokens', () => {
    const variants = deriveKoreanSurfaceVariants('도멘 드 라 로마네 콩티');

    expect(surfacesByRule(variants, 'spacing_removed')).toEqual([
      '도멘드라로마네콩티',
    ]);
    // Remainder spaced and compact differ → two iconic-token variants.
    expect(surfacesByRule(variants, 'iconic_token').sort()).toEqual(
      ['드 라 로마네 콩티', '드라로마네콩티'].sort(),
    );
    // 드 and 라 are single-syllable tokens → V3 must not fire.
    expect(surfacesByRule(variants, 'first_syllable_initialism')).toEqual([]);
  });

  it('emits only V1 for "오퍼스 원" (no producer stop-word prefix; "원" single-syllable blocks V3)', () => {
    const variants = deriveKoreanSurfaceVariants('오퍼스 원');

    expect(surfacesByRule(variants, 'spacing_removed')).toEqual(['오퍼스원']);
    expect(surfacesByRule(variants, 'iconic_token')).toEqual([]);
    expect(surfacesByRule(variants, 'first_syllable_initialism')).toEqual([]);
  });

  it('returns no variants for a single-syllable Korean input ("와인")', () => {
    expect(deriveKoreanSurfaceVariants('와인')).toEqual([]);
  });

  it('returns no variants for empty / whitespace input', () => {
    expect(deriveKoreanSurfaceVariants('')).toEqual([]);
    expect(deriveKoreanSurfaceVariants('   ')).toEqual([]);
    expect(deriveKoreanSurfaceVariants('\t\n')).toEqual([]);
  });

  it('returns no variants for non-Hangul input', () => {
    expect(deriveKoreanSurfaceVariants('Opus One')).toEqual([]);
    expect(deriveKoreanSurfaceVariants('Château Margaux')).toEqual([]);
    expect(deriveKoreanSurfaceVariants('123 abc')).toEqual([]);
  });

  it('returns no variants when canonical has no whitespace and no rule applies', () => {
    // V1 needs whitespace to fire; V2 needs ≥2 tokens; V3 needs ≥2 tokens.
    // "샤또마고" already collapsed → expander has nothing to add.
    expect(deriveKoreanSurfaceVariants('샤또마고')).toEqual([]);
  });

  it('emits stable sorted output (rule order: spacing_removed → iconic_token → first_syllable_initialism)', () => {
    const variants = deriveKoreanSurfaceVariants('샤또 마고');
    const ruleOrder = variants.map((v) => v.rule);
    // No two adjacent rules may regress through the ordering.
    const ruleRank: Record<KoreanSurfaceVariant['rule'], number> = {
      spacing_removed: 0,
      iconic_token: 1,
      first_syllable_initialism: 2,
    };
    for (let i = 1; i < ruleOrder.length; i += 1) {
      const prevRank = ruleRank[ruleOrder[i - 1]!];
      const nextRank = ruleRank[ruleOrder[i]!];
      expect(nextRank).toBeGreaterThanOrEqual(prevRank);
    }
  });

  it('is idempotent under NFC normalization (decomposed input yields same variants)', () => {
    const composed = '샤또 마고';
    const decomposed = composed.normalize('NFD');
    const fromComposed = deriveKoreanSurfaceVariants(composed);
    const fromDecomposed = deriveKoreanSurfaceVariants(decomposed);
    expect(fromDecomposed.map((v) => `${v.rule}:${v.surface}`)).toEqual(
      fromComposed.map((v) => `${v.rule}:${v.surface}`),
    );
  });

  it('handles iconic-token where remainder collapses to a single token (V2 spaced == V2 compact)', () => {
    // "샤또 마고" — remainder "마고" has no internal whitespace so V2 spaced == V2 compact.
    // The variant set should still contain at most one iconic_token entry.
    const variants = deriveKoreanSurfaceVariants('샤또 마고');
    const iconic = variants.filter((v) => v.rule === 'iconic_token');
    expect(iconic).toHaveLength(1);
    expect(iconic[0]?.surface).toBe('마고');
  });

  it('emits V3 only when no token is single-syllable AND compact length ≥ 3', () => {
    // "샤또 마고 라" — 3 tokens, but "라" is single-syllable → V3 blocked.
    const triple = deriveKoreanSurfaceVariants('샤또 마고 라');
    expect(surfacesByRule(triple, 'first_syllable_initialism')).toEqual([]);

    // "오퍼스 마고" — 2 multi-syllable tokens, compact length 4 → V3 fires.
    const okay = deriveKoreanSurfaceVariants('오퍼스 마고');
    expect(surfacesByRule(okay, 'first_syllable_initialism')).toEqual(['오마']);
  });

  it('never emits the canonical input as a variant', () => {
    const variants = deriveKoreanSurfaceVariants('샤또 마고');
    for (const variant of variants) {
      expect(variant.surface).not.toBe('샤또 마고');
    }
  });

  it('confidencePrior ordering matches the rule hierarchy V1 > V2 > V3', () => {
    const variants = deriveKoreanSurfaceVariants('도멘 드 라 로마네 콩티');
    const priorByRule = new Map<KoreanSurfaceVariant['rule'], number>();
    for (const v of variants) {
      priorByRule.set(v.rule, v.confidencePrior);
    }
    expect(priorByRule.get('spacing_removed')!).toBeGreaterThan(
      priorByRule.get('iconic_token')!,
    );
  });

  it('produces no duplicate (rule, surface) pairs', () => {
    const variants = deriveKoreanSurfaceVariants('도멘 드 라 로마네 콩티');
    const seen = new Set<string>();
    for (const v of variants) {
      const key = `${v.rule}::${v.surface}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
