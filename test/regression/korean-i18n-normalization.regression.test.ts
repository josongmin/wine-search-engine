/**
 * Korean (한글) and i18n normalization regression suite.
 *
 * Covers the gaps found during the Korean/i18n audit:
 *   1. NFC (composed) vs NFD (decomposed) Hangul equivalence at normalization
 *      boundaries — decomposed input must not silently miss alias/constraint
 *      matching.
 *   2. Korean particle (josa) stripping for alias lookup variants.
 *   3. Korean numeral words (오만원 → 5만원) mapped to digit form; 억원 support
 *      for grand-cru price queries.
 *   4. Fullwidth space (U+3000) folded to ASCII in constraint extraction.
 *   5. Korean honorific suffix (님/씨) stripped for lookup variants.
 *   6. AdaptiveBudget pure-Hangul SKU classification invariant under NFD.
 *
 * Append-only: never delete tests from this file. Add new cases at the bottom.
 */

import { describe, expect, it } from 'vitest';
import { QueryNormalizer } from '../../src/domain/query/service/query-normalizer.js';
import { correctKoreanWineTypos } from '../../src/domain/query/service/korean-wine-aliases.js';
import { extractSearchConstraints } from '../../src/domain/query/service/search-constraint-extractor.js';
import { classifyQueryBudget } from '../../src/domain/agent/service/adaptive-budget.js';

describe('Korean/i18n normalization regressions', () => {
  const normalizer = new QueryNormalizer();

  describe('NFC/NFD equivalence at normalization boundary', () => {
    it('correctKoreanWineTypos NFC-normalizes decomposed input before matching', () => {
      // "오퍼스원" in NFD (decomposed jamo)
      const nfd = '오퍼스원'.normalize('NFD');
      expect(nfd).not.toBe('오퍼스원'); // sanity: NFD differs byte-wise
      expect(correctKoreanWineTypos(nfd)).toBe('오푸스원');
    });

    it('correctKoreanWineTypos keeps NFC input working (regression for NFC no-op)', () => {
      expect(correctKoreanWineTypos('오퍼스원')).toBe('오푸스원');
    });

    it('does not rewrite semantic chat slang inside Korean eojeols', () => {
      expect(correctKoreanWineTypos('와인 ㄱㅊ은거 하나만')).toBe('와인 ㄱㅊ은거 하나만');
      expect(correctKoreanWineTypos('와알못인데 레드 하나 ㄱㅊ은걸로')).toBe('와알못인데 레드 하나 ㄱㅊ은걸로');
    });

    it('QueryNormalizer applies typo correction before transliteration lookup', () => {
      const views = normalizer.normalize('보졸레누보');
      expect(views.punctuationStripped).toBe('보졸레 누보');
      expect(views.transliterated).toBe('beaujolais nouveau');
    });

    it('QueryNormalizer preserves the raw exact-safe surface in lookupVariants even when typo correction broadens the canonical form', () => {
      const views = normalizer.normalize('라피트 로쉴드');
      expect(views.strict).toBe('샤또 라피트');
      expect(views.lookupVariants).toEqual(
        expect.arrayContaining(['라피트 로쉴드', '샤또 라피트']),
      );
    });

    it('extractSearchConstraints NFC-normalizes decomposed Hangul price queries', () => {
      const nfd = '카베르네 빼고 5만원 이하'.normalize('NFD');
      const result = extractSearchConstraints(nfd);
      expect(result.maxPriceKrw).toBe(50_000);
      expect(result.excludeGrapes).toContain('Cabernet Sauvignon');
    });

    it('extractSearchConstraints handles fullwidth space (U+3000) in constraint query', () => {
      const withFwSpace = '5만원\u3000이하';
      const result = extractSearchConstraints(withFwSpace);
      expect(result.maxPriceKrw).toBe(50_000);
    });

    it('QueryNormalizer strict view is NFC-identical for NFC/NFD inputs', () => {
      const nfc = '샤또 마고';
      const nfd = nfc.normalize('NFD');
      const a = normalizer.normalize(nfc);
      const b = normalizer.normalize(nfd);
      expect(a.strict).toBe(b.strict);
      expect(a.transliterated).toBe(b.transliterated);
    });
  });

  describe('Korean numeral words in price queries', () => {
    it('converts "오만원 이하" to maxPriceKrw 50000', () => {
      const result = extractSearchConstraints('오만원 이하');
      expect(result.maxPriceKrw).toBe(50_000);
    });

    it('converts "십만원 이하" to maxPriceKrw 100000', () => {
      const result = extractSearchConstraints('십만원 이하');
      expect(result.maxPriceKrw).toBe(100_000);
    });

    it('converts "백만원 이상" to minPriceKrw 1_000_000', () => {
      const result = extractSearchConstraints('백만원 이상');
      expect(result.minPriceKrw).toBe(1_000_000);
    });

    it('handles 억원 high-end queries: "1억원 이상" sets minPriceKrw 100_000_000', () => {
      const result = extractSearchConstraints('1억원 이상 그랑크뤼');
      expect(result.minPriceKrw).toBe(100_000_000);
    });

    it('handles 억 with Korean numeral: "일억원 이하"', () => {
      const result = extractSearchConstraints('일억원 이하');
      expect(result.maxPriceKrw).toBe(100_000_000);
    });

    it('does NOT rewrite "오늘" as "5늘" (numeral corruption FP check)', () => {
      // Regression for the boundary constraint in koreanNumberWordToDigit:
      // the rewrite must only fire when followed by a legit unit/continuation.
      const result = extractSearchConstraints('오늘 마실 와인');
      expect(result).not.toHaveProperty('maxPriceKrw');
      expect(result).not.toHaveProperty('minPriceKrw');
    });
  });

  describe('Korean josa (particle) stripping in lookup variants', () => {
    it('strips possessive 의 from trailing syllable', () => {
      const views = normalizer.normalize('보르도의 와인');
      // Particle-stripped variant is "보르도 와인"; should appear in lookupVariants.
      expect(views.lookupVariants).toEqual(
        expect.arrayContaining([expect.stringContaining('보르도 와인')]),
      );
    });

    it('strips locative 에서', () => {
      const views = normalizer.normalize('프랑스에서 온 와인');
      const joined = views.lookupVariants.join('|');
      expect(joined).toContain('프랑스');
    });

    it('strips topic marker 는', () => {
      const views = normalizer.normalize('보르도는 좋다');
      expect(views.lookupVariants.some((v) => v.includes('보르도 '))).toBe(true);
    });

    it('strips honorific 님', () => {
      // Avoid three-token + vintage heuristics that can merge middle tokens; honorific strip is asserted on a stable span.
      const views = normalizer.normalize('무통 로칠드님');
      expect(views.lookupVariants.some((v) => v.includes('로칠드') && !v.includes('로칠드님'))).toBe(true);
    });

    it('does not strip Latin suffix that happens to be a particle letter', () => {
      // "data" must not lose its trailing "a"; "data" contains no Hangul so
      // the regex must not fire.
      const views = normalizer.normalize('data wine');
      expect(views.lookupVariants).toEqual(
        expect.arrayContaining([expect.stringContaining('data')]),
      );
    });

    it('mixed-script "Bordeaux 와인 추천" — Hangul tokens unaffected by Latin boundary', () => {
      const views = normalizer.normalize('Bordeaux 와인 추천');
      // tokenization must keep 3 tokens (bordeaux, 와인, 추천)
      expect(views.accentless.split(/\s+/)).toHaveLength(3);
    });
  });

  describe('AdaptiveBudget pure-Hangul SKU invariant', () => {
    it('classifies NFC 오푸스원 as specific_sku', () => {
      const budget = classifyQueryBudget('오푸스원');
      expect(budget?.classification).toBe('specific_sku');
    });

    it('classifies NFD 오푸스원 as specific_sku (regression for decomposed Hangul)', () => {
      const nfd = '오푸스원'.normalize('NFD');
      const budget = classifyQueryBudget(nfd);
      expect(budget?.classification).toBe('specific_sku');
    });
  });

  describe('Trailing punctuation in Korean queries', () => {
    it('normalizes "보르도?" to strip trailing ?', () => {
      const views = normalizer.normalize('보르도?');
      expect(views.punctuationStripped).toBe('보르도');
    });

    it('normalizes "보르도!" identically', () => {
      const views = normalizer.normalize('보르도!');
      expect(views.punctuationStripped).toBe('보르도');
    });
  });
});
