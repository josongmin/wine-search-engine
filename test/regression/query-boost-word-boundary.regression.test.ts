/**
 * Regression lock for the query-boost vocabulary word-boundary contract.
 *
 * `src/infrastructure/vespa/vespa-search-index.ts` derives three rank-time
 * boost signals (`structured_region_boost`, `structured_country_boost`,
 * `structured_grape_boost`) by checking whether the raw user query mentions
 * any keyword from the SSoT vocabularies in
 * `src/infrastructure/vespa/query-boost-vocabulary.ts`.
 *
 * Previously this was a naked `query.includes('bordeaux') || ...` substring
 * scan, which produced false positives for compound tokens such as
 * `new_bordeaux_style` or `pinotage` (the latter triggers a spurious `pinot`
 * grape boost). The fix routes every lookup through {@link queryMentionsAny},
 * which enforces a Unicode-safe whole-word boundary.
 *
 * This regression test locks the boundary contract:
 *
 *  R1. `'bordeaux'` (bare keyword)        → region boost applied
 *  R2. `'new_bordeaux_style'` (snake-case
 *       compound, FALSE POSITIVE under
 *       legacy substring matching)        → NO region boost
 *  R3. `'BORDEAUX'` (uppercase)           → region boost (case-insensitive)
 *  R4. `'bordeaux,burgundy'`              → region boost (comma boundary)
 *  R5. `'pinotage'`                       → NO grape boost (substring of `pinot`)
 *  R6. Korean-only query (`'보르도 와인'`) → NO boost (English vocab only)
 *  R7. Korean+English mix
 *       (`'와인 bordeaux 추천'`)            → region boost
 *
 * This file is append-only (CLAUDE.md test discipline). Do NOT delete cases.
 */

import { describe, expect, it } from 'vitest';
import {
  MAJOR_REGION_KEYWORDS,
  MAJOR_COUNTRY_KEYWORDS,
  MAJOR_GRAPE_KEYWORDS,
  queryMentionsAny,
} from '../../src/infrastructure/vespa/query-boost-vocabulary.js';

describe('query-boost word-boundary regression', () => {
  describe('R1-R4: region boost cases', () => {
    it('R1: bare "bordeaux" triggers region boost', () => {
      expect(queryMentionsAny('bordeaux', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('R2: "new_bordeaux_style" does NOT trigger region boost (false-positive guard)', () => {
      expect(queryMentionsAny('new_bordeaux_style', MAJOR_REGION_KEYWORDS)).toBe(false);
    });

    it('R3: "BORDEAUX" triggers region boost (case-insensitive)', () => {
      expect(queryMentionsAny('BORDEAUX', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('R4: "bordeaux,burgundy" triggers region boost (comma boundary)', () => {
      expect(queryMentionsAny('bordeaux,burgundy', MAJOR_REGION_KEYWORDS)).toBe(true);
    });
  });

  describe('R5: grape boost false-positive guards', () => {
    it('R5: "pinotage" does NOT trigger grape boost (substring of "pinot")', () => {
      expect(queryMentionsAny('pinotage', MAJOR_GRAPE_KEYWORDS)).toBe(false);
    });

    it('"cabernet sauvignon" still triggers grape boost', () => {
      expect(queryMentionsAny('cabernet sauvignon', MAJOR_GRAPE_KEYWORDS)).toBe(true);
    });

    it('"merlot-based blend" still triggers grape boost (hyphen boundary)', () => {
      expect(queryMentionsAny('merlot-based blend', MAJOR_GRAPE_KEYWORDS)).toBe(true);
    });
  });

  describe('R6-R7: Korean / mixed query safety', () => {
    it('R6: pure Korean query does NOT match English vocab', () => {
      expect(queryMentionsAny('보르도 와인', MAJOR_REGION_KEYWORDS)).toBe(false);
    });

    it('R7: Korean-then-English query matches embedded English keyword', () => {
      expect(queryMentionsAny('와인 bordeaux 추천', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('Korean text does not trigger country boost spuriously', () => {
      expect(queryMentionsAny('이탈리아 와인', MAJOR_COUNTRY_KEYWORDS)).toBe(false);
    });
  });

  describe('country vocab false-positive guards', () => {
    it('"usable" does NOT trigger country boost (would match "usa" under substring)', () => {
      expect(queryMentionsAny('usable wine', MAJOR_COUNTRY_KEYWORDS)).toBe(false);
    });

    it('"USA" still triggers country boost', () => {
      expect(queryMentionsAny('USA wine', MAJOR_COUNTRY_KEYWORDS)).toBe(true);
    });

    it('"france" still triggers country boost', () => {
      expect(queryMentionsAny('wines from france', MAJOR_COUNTRY_KEYWORDS)).toBe(true);
    });
  });

  describe('SSoT invariant: vocabularies are non-empty and lowercase', () => {
    it('every vocabulary entry is non-empty and lowercase', () => {
      const allVocabs = [
        ...MAJOR_REGION_KEYWORDS,
        ...MAJOR_COUNTRY_KEYWORDS,
        ...MAJOR_GRAPE_KEYWORDS,
      ];
      for (const term of allVocabs) {
        expect(term.length).toBeGreaterThan(0);
        expect(term).toBe(term.toLowerCase());
        expect(term.trim()).toBe(term);
      }
    });
  });
});
