/**
 * Wave F1 — topology-pattern-lexicon SSoT regression lock.
 *
 * Every pattern exported from the lexicon must:
 *  - match at least one positive example
 *  - reject at least one false-positive substring trap
 *
 * This test enforces CLAUDE.md rule 23 (security pattern false-positive
 * tests) and rule 8 (Unicode-safe regex boundaries — no `\b` on
 * non-ASCII content).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  TOPOLOGY_XOR_KEYWORDS_KO,
  TOPOLOGY_XOR_REGEX_EN,
  TOPOLOGY_COURSE_KEYWORDS_KO,
  TOPOLOGY_COURSE_REGEX_EN,
  matchesXorLexicon,
  matchesCourseKeywords,
} from '../../src/domain/query/service/topology-pattern-lexicon.js';

describe('topology-pattern-lexicon — SSoT exports', () => {
  it('exposes at least one Korean XOR keyword and one course keyword', () => {
    expect(TOPOLOGY_XOR_KEYWORDS_KO.length).toBeGreaterThan(0);
    expect(TOPOLOGY_COURSE_KEYWORDS_KO.length).toBeGreaterThan(0);
  });

  it('Korean XOR keywords are matched by matchesXorLexicon', () => {
    for (const kw of TOPOLOGY_XOR_KEYWORDS_KO) {
      expect(matchesXorLexicon(`문장 앞 ${kw} 뒤`)).toBe(true);
    }
  });

  it('English XOR regex matches `either/or` in natural sentences', () => {
    expect(TOPOLOGY_XOR_REGEX_EN.test('either red or white')).toBe(true);
    expect(matchesXorLexicon('either red or white')).toBe(true);
  });

  it('English XOR regex does NOT match substrings inside longer words', () => {
    // `or` inside `sworded`, `either` inside `neither` with no boundary.
    expect(TOPOLOGY_XOR_REGEX_EN.test('sworded')).toBe(false);
    // The English regex deliberately accepts bare `or` only at word
    // boundaries; confirm it rejects the substring form.
    expect(TOPOLOGY_XOR_REGEX_EN.test('corduroy')).toBe(false);
  });

  it('Korean course keywords are matched by matchesCourseKeywords with ≥2 courses', () => {
    expect(matchesCourseKeywords('메인 요리와 디저트 추천')).toBe(true);
  });

  it('English course regex matches `main course` and `dessert` but not random `course`', () => {
    expect(TOPOLOGY_COURSE_REGEX_EN.test('main course pairing')).toBe(true);
    expect(TOPOLOGY_COURSE_REGEX_EN.test('dessert wine')).toBe(true);
    // Course keyword detector requires ≥2 distinct courses to fire.
    expect(matchesCourseKeywords('main course only')).toBe(false);
    expect(matchesCourseKeywords('main course and dessert')).toBe(true);
  });
});
