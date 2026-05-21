/**
 * Regression: Korean wine-domain pairing vocabulary expansion (S2 — coverage gap).
 *
 * Background: prior to this expansion, common Korean food terms (감자탕, 갈비,
 * 보쌈, 회덮밥, 부대찌개 …) produced ZERO pairing matches, leaving the analyzer
 * with no anchors/constraints and routing the query to the unsupported-intent
 * reject path. The S2 hell-test in
 * `test/e2e/wine-search-api-hell-adversarial.test.ts` documents this behavior.
 *
 * Invariant: every Korean food term added to `pairing-extractor.ts` must
 * resolve to ≥1 PairingTag, and the included terms must NOT trigger false
 * positives on innocuous Korean wine-context phrases.
 *
 * SSoT note (rule 25/30): the pairing vocabulary lives entirely inside
 * `pairing-extractor.ts:PAIRING_PATTERNS`. This regression locks the surface
 * area; if a duplicate vocabulary appears in another module, that is a SSoT
 * violation to be flagged separately.
 */
import { describe, expect, it } from 'vitest';
import {
  extractAllPairingConstraints,
  extractPairingConstraintsWithExclusions,
  type PairingTag,
} from '../../src/domain/query/service/pairing-extractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Expected vocabulary mappings (representative subset of S2 expansion).
// Each entry is exercised both bare and in a natural-context phrase.
// ─────────────────────────────────────────────────────────────────────────────

interface VocabExpectation {
  readonly term: string;
  readonly mustInclude: PairingTag;
  readonly natural: string;
}

const KOREAN_VOCAB_EXPECTATIONS: ReadonlyArray<VocabExpectation> = [
  // 한식 - 매운 국물 / 매운 음식
  { term: '감자탕', mustInclude: 'spicy_food', natural: '감자탕에 어울리는 와인' },
  { term: '김치찌개', mustInclude: 'spicy_food', natural: '김치찌개와 마실 와인' },
  { term: '된장찌개', mustInclude: 'spicy_food', natural: '된장찌개에 곁들일 와인' },
  { term: '청국장', mustInclude: 'spicy_food', natural: '청국장에 어울리는 와인' },
  { term: '마라탕', mustInclude: 'spicy_food', natural: '마라탕과 마시는 와인' },
  { term: '마파두부', mustInclude: 'spicy_food', natural: '마파두부에 페어링' },
  { term: '매운 음식', mustInclude: 'spicy_food', natural: '매운 음식에 어울리는 와인' },

  // 한식 - 소고기
  { term: '갈비', mustInclude: 'beef', natural: '갈비랑 마실 와인' },
  { term: '갈비탕', mustInclude: 'beef', natural: '갈비탕에 어울리는 와인' },
  { term: '비빔밥', mustInclude: 'beef', natural: '비빔밥과 마실 와인' },
  { term: '잡채', mustInclude: 'beef', natural: '잡채에 어울리는 와인' },
  { term: '등심구이', mustInclude: 'beef', natural: '등심구이용 와인' },

  // 한식 - 돼지고기
  { term: '삼겹살', mustInclude: 'pork', natural: '삼겹살에 어울리는 와인' },
  { term: '보쌈', mustInclude: 'pork', natural: '보쌈이랑 마실 와인' },
  { term: '족발', mustInclude: 'pork', natural: '족발과 잘 어울리는 와인' },
  { term: '부대찌개', mustInclude: 'pork', natural: '부대찌개와 마실 와인' },
  { term: '돈카츠', mustInclude: 'pork', natural: '돈카츠랑 잘 맞는 와인' },
  { term: '탕수육', mustInclude: 'pork', natural: '탕수육과 어울리는 와인' },

  // 한식 - 닭요리
  { term: '닭갈비', mustInclude: 'chicken', natural: '닭갈비에 어울리는 와인' },
  { term: '닭볶음탕', mustInclude: 'chicken', natural: '닭볶음탕과 마실 와인' },
  { term: '깐풍기', mustInclude: 'chicken', natural: '깐풍기와 어울리는 와인' },

  // 한식 - 해물 / 회 / 흰살생선
  { term: '회', mustInclude: 'white_fish', natural: '회랑 마실 와인' },
  { term: '회덮밥', mustInclude: 'white_fish', natural: '회덮밥과 마실 와인' },
  { term: '초밥', mustInclude: 'white_fish', natural: '초밥에 어울리는 와인' },
  { term: '사시미', mustInclude: 'white_fish', natural: '사시미와 잘 맞는 와인' },
  { term: '생선구이', mustInclude: 'white_fish', natural: '생선구이에 어울리는 와인' },
  { term: '해물파전', mustInclude: 'shellfish', natural: '해물파전과 마실 와인' },

  // 면류 / 양식
  { term: '라면', mustInclude: 'pasta', natural: '라면에 어울리는 와인' },
  { term: '칼국수', mustInclude: 'pasta', natural: '칼국수랑 마실 와인' },
  { term: '우동', mustInclude: 'pasta', natural: '우동과 어울리는 와인' },
  { term: '짜장면', mustInclude: 'pasta', natural: '짜장면에 어울리는 와인' },
  { term: '라멘', mustInclude: 'pasta', natural: '라멘과 마실 와인' },
  { term: '김밥', mustInclude: 'pasta', natural: '김밥에 어울리는 와인' },
  { term: '피자', mustInclude: 'risotto', natural: '피자에 어울리는 와인' },
  { term: '햄버거', mustInclude: 'risotto', natural: '햄버거와 마실 와인' },
  { term: '샌드위치', mustInclude: 'risotto', natural: '샌드위치와 어울리는 와인' },
  { term: '스키야키', mustInclude: 'risotto', natural: '스키야키와 마실 와인' },
  { term: '샤브샤브', mustInclude: 'risotto', natural: '샤브샤브에 어울리는 와인' },

  // 전 / 부침개
  { term: '파전', mustInclude: 'grilled_vegetables', natural: '파전에 어울리는 와인' },
  { term: '부침개', mustInclude: 'grilled_vegetables', natural: '부침개와 마실 와인' },

  // 디저트
  { term: '치즈케이크', mustInclude: 'dessert', natural: '치즈케이크에 어울리는 와인' },
  { term: '마카롱', mustInclude: 'dessert', natural: '마카롱과 마시는 와인' },
];

describe('Korean pairing vocabulary expansion (S2)', () => {
  describe('bare-term extraction returns ≥1 constraint', () => {
    for (const { term, mustInclude } of KOREAN_VOCAB_EXPECTATIONS) {
      it(`"${term}" → includes "${mustInclude}"`, () => {
        const tags = extractAllPairingConstraints(term);
        expect(tags.length).toBeGreaterThan(0);
        expect(tags).toContain(mustInclude);
      });
    }
  });

  describe('natural-context extraction returns ≥1 constraint', () => {
    for (const { natural, mustInclude } of KOREAN_VOCAB_EXPECTATIONS) {
      it(`"${natural}" → includes "${mustInclude}"`, () => {
        const tags = extractAllPairingConstraints(natural);
        expect(tags).toContain(mustInclude);
      });
    }
  });

  describe('false-positive guards (rule 23)', () => {
    // None of the following should produce ANY positive pairing match — they
    // are innocuous Korean wine queries that happen to share substrings with
    // expanded vocabulary.
    const NEGATIVE_PROBES: ReadonlyArray<string> = [
      // "감기" (a cold/illness) — must NOT be picked up by anything; tests that
      // the lone "감" does not match "감자탕".
      '감기 걸린 날 마실 와인',
      // "전에" (before) — must NOT match the 전/파전/부침개 family.
      '이전에 마신 와인 알려줘',
      // "전 와인 잘 몰라요" — bare 전 (the speaker pronoun / time adverb).
      '전 와인 잘 몰라요',
      // "회사" (company) — should NOT match white_fish 회.
      '회사 회식용 와인 추천',
    ];

    for (const probe of NEGATIVE_PROBES) {
      it(`"${probe}" produces no false-positive pairing`, () => {
        // We allow ANY pairing tag to appear (the corpus is non-targeted), but
        // we explicitly assert that the no-vocab cases below do NOT match a
        // food-only token from the expansion. The strongest assertion is that
        // these queries do NOT incorrectly route to a clearly food-tied tag
        // when the surface lacks a food noun.
        const tags = extractAllPairingConstraints(probe);
        // The corpus above contains no genuine food tokens — assert empty.
        // (회사회식 is the borderline case: 회 is still a substring, but it is
        // immediately followed by 사 (\p{L}) so the right-boundary blocks the
        // match.)
        expect(tags).toEqual([]);
      });
    }
  });

  describe('negation still works on expanded vocabulary', () => {
    it('"감자탕 빼고 와인 추천" — 감자탕 surfaces in excluded, not included', () => {
      const result = extractPairingConstraintsWithExclusions('감자탕 빼고 와인 추천');
      expect(result.included).not.toContain('spicy_food');
      expect(result.excluded).toContain('spicy_food');
    });

    it('"삼겹살은 좋은데 회는 안 좋아하는" — 삼겹살 included, 회 excluded', () => {
      const result = extractPairingConstraintsWithExclusions('삼겹살은 좋은데 회는 안 좋아하는');
      expect(result.included).toContain('pork');
      expect(result.excluded).toContain('white_fish');
    });
  });
});
