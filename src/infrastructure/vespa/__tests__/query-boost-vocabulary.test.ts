import { describe, expect, it } from 'vitest';
import {
  MAJOR_REGION_KEYWORDS,
  MAJOR_COUNTRY_KEYWORDS,
  MAJOR_GRAPE_KEYWORDS,
  queryMentionsAny,
} from '../query-boost-vocabulary.js';

describe('query-boost-vocabulary SSoT', () => {
  describe('MAJOR_REGION_KEYWORDS', () => {
    it('contains the five canonical regions', () => {
      expect(MAJOR_REGION_KEYWORDS).toEqual([
        'bordeaux',
        'burgundy',
        'napa',
        'champagne',
        'rioja',
      ]);
    });
  });

  describe('MAJOR_COUNTRY_KEYWORDS', () => {
    it('contains the four canonical countries', () => {
      expect(MAJOR_COUNTRY_KEYWORDS).toEqual(['france', 'italy', 'spain', 'usa']);
    });
  });

  describe('MAJOR_GRAPE_KEYWORDS', () => {
    it('contains the five canonical grape keywords', () => {
      expect(MAJOR_GRAPE_KEYWORDS).toEqual([
        'cabernet',
        'merlot',
        'pinot',
        'chardonnay',
        'riesling',
      ]);
    });
  });

  describe('queryMentionsAny — happy path', () => {
    it('matches a bare keyword', () => {
      expect(queryMentionsAny('bordeaux', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('matches a keyword followed by space and more text', () => {
      expect(queryMentionsAny('bordeaux wine', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('matches a keyword preceded by text', () => {
      expect(queryMentionsAny('great bordeaux', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('matches case-insensitively (UPPERCASE)', () => {
      expect(queryMentionsAny('BORDEAUX', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('matches case-insensitively (MixedCase)', () => {
      expect(queryMentionsAny('Bordeaux', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('treats comma as a word boundary', () => {
      expect(queryMentionsAny('bordeaux,burgundy', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('matches any keyword in the list (last entry)', () => {
      expect(queryMentionsAny('a glass of rioja please', MAJOR_REGION_KEYWORDS)).toBe(true);
    });
  });

  describe('queryMentionsAny — false-positive suppression', () => {
    it('rejects a compound snake-case token that embeds a keyword', () => {
      expect(queryMentionsAny('new_bordeaux_style', MAJOR_REGION_KEYWORDS)).toBe(false);
    });

    it('rejects a contiguous concatenation (no word boundary)', () => {
      expect(queryMentionsAny('newbordeaux', MAJOR_REGION_KEYWORDS)).toBe(false);
    });

    it('rejects "pinotage" (grape that contains "pinot" substring)', () => {
      expect(queryMentionsAny('pinotage', MAJOR_GRAPE_KEYWORDS)).toBe(false);
    });

    it('rejects "italianate" (English adjective containing "italy"-prefix only)', () => {
      // sanity: this should not match because "italianate" doesn't contain "italy" as a word.
      expect(queryMentionsAny('italianate decor', MAJOR_COUNTRY_KEYWORDS)).toBe(false);
    });
  });

  describe('queryMentionsAny — edge / safety', () => {
    it('returns false for empty query', () => {
      expect(queryMentionsAny('', MAJOR_REGION_KEYWORDS)).toBe(false);
    });

    it('returns false for empty vocabulary', () => {
      expect(queryMentionsAny('bordeaux', [])).toBe(false);
    });

    it('handles Korean-only query without matching English keywords', () => {
      expect(queryMentionsAny('보르도 와인 추천', MAJOR_REGION_KEYWORDS)).toBe(false);
    });

    it('matches an English keyword embedded in Korean context', () => {
      expect(queryMentionsAny('와인 bordeaux 추천', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('matches keyword surrounded by emoji (non-letter/digit boundary)', () => {
      expect(queryMentionsAny('🍷bordeaux🍷', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('does not break on accented Latin text', () => {
      // "réserve bordeaux" — accented chars adjacent (but separated by space)
      expect(queryMentionsAny('réserve bordeaux', MAJOR_REGION_KEYWORDS)).toBe(true);
    });

    it('does not match across an accented-letter boundary', () => {
      // "ébordeauxé" — accented letters glued to the keyword: not a whole-word match
      expect(queryMentionsAny('ébordeauxé', MAJOR_REGION_KEYWORDS)).toBe(false);
    });
  });
});
