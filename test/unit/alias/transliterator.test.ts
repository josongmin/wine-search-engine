import { describe, it, expect } from 'vitest';
import { Transliterator } from '../../../src/domain/alias/service/transliterator.js';

const t = new Transliterator();

describe('Transliterator', () => {
  describe('French to Korean', () => {
    it('"Château" → "샤또" via built-in rule', () => {
      const result = t.transliterate('Château', 'fr');
      expect(result).toBe('샤또');
    });

    it('"Margaux" → "마고" via built-in word rule', () => {
      const result = t.transliterate('Margaux', 'fr');
      expect(result).toBe('마고');
    });
  });

  describe('Italian to Korean', () => {
    it('"Barolo" → "바롤로" via built-in Italian rule', () => {
      const result = t.transliterate('Barolo', 'it');
      expect(result).toBe('바롤로');
    });
  });

  describe('Exception dictionary', () => {
    it('"Opus One" → "오푸스원" via exception lookup', () => {
      const result = t.transliterate('Opus One', 'en');
      expect(result).toBe('오푸스원');
    });

    it('"Dom Pérignon" → "돔 페리뇽" via exception lookup', () => {
      const result = t.transliterate('Dom Pérignon', 'fr');
      expect(result).toBe('돔 페리뇽');
    });

    it('"Château Margaux" → "샤또 마고" via exception lookup', () => {
      const result = t.transliterate('Château Margaux', 'fr');
      expect(result).toBe('샤또 마고');
    });

    it('exception lookup is case-insensitive (lowercase input)', () => {
      const result = t.transliterate('opus one', 'en');
      expect(result).toBe('오푸스원');
    });
  });

  describe('generateAliases', () => {
    it('returns transliteration results with confidence', () => {
      const results = t.generateAliases('Barolo', 'it');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.value).toBeDefined();
      expect(results[0]!.confidence).toBeGreaterThan(0);
      expect(results[0]!.type).toBe('translation');
    });

    it('exception wines have higher confidence (0.95)', () => {
      const results = t.generateAliases('Opus One', 'en');
      expect(results[0]!.confidence).toBe(0.95);
    });

    it('non-exception wines have lower confidence (0.75)', () => {
      const results = t.generateAliases('Brunello', 'it');
      const primaryResult = results[0]!;
      expect(primaryResult.confidence).toBe(0.75);
    });

    it('non-exception may include compact phonetic variant', () => {
      // For multi-word labels, compact variant (no spaces) may be generated
      const results = t.generateAliases('Pinot Noir', 'fr');
      // At least primary result
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('phonetic fallback for unknown words', () => {
    it('unknown word uses character-level rules and produces some Korean output', () => {
      // "Test" → apply FR rules character by character
      const result = t.transliterate('test', 'fr');
      // Should produce some Korean via fallback rules, not empty string
      expect(result.length).toBeGreaterThan(0);
      // Should not be the original Latin string unchanged (some rules apply)
      // 't' → 트, 'e' → 에, 's' → 스, 't' → 트
      expect(result).toBe('트에스트');
    });

    it('Champagne → 샴페인 via French full-word rule', () => {
      const result = t.transliterate('Champagne', 'fr');
      expect(result).toBe('샴페인');
    });
  });

  describe('Sauternes via French rule', () => {
    it('"Sauternes" → "소테른"', () => {
      const result = t.transliterate('Sauternes', 'fr');
      expect(result).toBe('소테른');
    });
  });
});
