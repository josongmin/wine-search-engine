/**
 * Regression: pairing extractor must NOT return foods that appear inside a
 * negation/exclusion scope ("without X", "but not X", Korean "X 없이", "X 빼고",
 * Korean predicative negation "X 안 좋아하는").
 *
 * Audit-identified gap (nlu.pairing-extraction maturity 2 → 3):
 *   - "wine without seafood" was matching `shellfish` as a positive pairing.
 *   - Multi-food queries with mixed polarity ("steak but not lobster") were
 *     conflated into a single positive list.
 *
 * Invariant: positive pairing list excludes any food whose surface form falls
 * inside a negation scope; the same food is exposed via the explicit
 * `excluded` channel for downstream consumers (e.g. agent tool execution).
 */
import { describe, expect, it } from 'vitest';
import {
  extractAllPairingConstraints,
  extractPairingConstraintsWithExclusions,
} from '../../src/domain/query/service/pairing-extractor.js';

describe('pairing-extraction negation / multi-food parsing', () => {
  describe('English negation', () => {
    it('drops shellfish for "wine without seafood"', () => {
      const result = extractPairingConstraintsWithExclusions('wine without seafood');
      expect(result.included).toEqual([]);
      // "seafood" surfaces as a shellfish-family token under the explicit exclusion channel.
      expect(result.excluded).toContain('shellfish');
      // Back-compat surface: the positive helper must NOT return shellfish.
      expect(extractAllPairingConstraints('wine without seafood')).not.toContain('shellfish');
    });

    it('keeps steak but drops lobster for "wine that goes with steak but not lobster"', () => {
      const result = extractPairingConstraintsWithExclusions('wine that goes with steak but not lobster');
      expect(result.included).toEqual(['beef']);
      expect(result.excluded).toEqual(['shellfish']);
    });

    it('treats "no shellfish" as exclusion', () => {
      const result = extractPairingConstraintsWithExclusions('red wine, no shellfish please');
      expect(result.included).toEqual([]);
      expect(result.excluded).toEqual(['shellfish']);
    });

    it('treats "except lamb" as exclusion', () => {
      const result = extractPairingConstraintsWithExclusions('steak except lamb');
      expect(result.included).toEqual(['beef']);
      expect(result.excluded).toEqual(['lamb']);
    });
  });

  describe('Korean negation', () => {
    it('drops shellfish for "해산물 없이 마실 와인"', () => {
      const result = extractPairingConstraintsWithExclusions('해산물 없이 마실 와인');
      expect(result.included).toEqual([]);
      expect(result.excluded).toContain('shellfish');
    });

    it('drops shellfish for "해산물 빼고 추천해줘"', () => {
      const result = extractPairingConstraintsWithExclusions('해산물 빼고 추천해줘');
      expect(result.included).toEqual([]);
      expect(result.excluded).toContain('shellfish');
    });

    it('keeps steak but drops shrimp for "스테이크랑 어울리는데 새우는 안 좋아하는"', () => {
      const result = extractPairingConstraintsWithExclusions('스테이크랑 어울리는데 새우는 안 좋아하는');
      expect(result.included).toEqual(['beef']);
      expect(result.excluded).toEqual(['shellfish']);
    });
  });

  describe('Multi-food positive (no negation)', () => {
    it('returns both beef and shellfish for "steak and lobster"', () => {
      const result = extractPairingConstraintsWithExclusions('steak and lobster');
      expect(result.included).toEqual(['beef', 'shellfish']);
      expect(result.excluded).toEqual([]);
    });

    it('returns both beef and shellfish for "스테이크랑 랍스터"', () => {
      const result = extractPairingConstraintsWithExclusions('스테이크랑 랍스터');
      expect(result.included).toEqual(['beef', 'shellfish']);
      expect(result.excluded).toEqual([]);
    });
  });

  describe('Adjacent invariants (rule 4 regression coverage)', () => {
    it('empty query returns no pairings and no exclusions', () => {
      const result = extractPairingConstraintsWithExclusions('');
      expect(result.included).toEqual([]);
      expect(result.excluded).toEqual([]);
      expect(extractAllPairingConstraints('')).toEqual([]);
    });

    it('query with no food mention returns no pairings and no exclusions', () => {
      const result = extractPairingConstraintsWithExclusions('가벼운 와인 추천해줘');
      expect(result.included).toEqual([]);
      expect(result.excluded).toEqual([]);
      expect(extractAllPairingConstraints('가벼운 와인 추천해줘')).toEqual([]);
    });

    it('negation marker without a food noun does not fabricate an exclusion', () => {
      // "without" appears but no food word follows — must not crash or coerce a tag.
      const result = extractPairingConstraintsWithExclusions('a wine without too much oak');
      expect(result.included).toEqual([]);
      expect(result.excluded).toEqual([]);
    });
  });
});
