/**
 * Wave F1 / I1 — topology-pattern-lexicon SSoT regression lock.
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
  TOPOLOGY_XOR_NEGATION_KEYWORDS_KO,
  TOPOLOGY_XOR_NEGATION_REGEX_KO,
  TOPOLOGY_XOR_NEGATION_REGEX_EN,
  TOPOLOGY_XOR_DISJUNCTION_KEYWORDS_KO,
  TOPOLOGY_XOR_DISJUNCTION_REGEX_KO,
  TOPOLOGY_XOR_DISJUNCTION_REGEX_EN,
  TOPOLOGY_COURSE_KEYWORDS_KO,
  TOPOLOGY_COURSE_PHRASES_KO,
  TOPOLOGY_COURSE_REGEX_EN,
  TOPOLOGY_SHARES_BUDGET_KEYWORDS_KO,
  TOPOLOGY_SHARES_BUDGET_REGEX_EN,
  matchesXorLexicon,
  matchesCourseKeywords,
  matchesSharedBudgetHint,
  classifyCourseHits,
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

// ─── Wave I1 — XOR-negation patterns ─────────────────────────────────────────

describe('topology-pattern-lexicon — Wave I1 XOR-negation (Korean)', () => {
  it('exposes 말고 / 빼고 / 외에는 in the Korean negation keyword list', () => {
    expect(TOPOLOGY_XOR_NEGATION_KEYWORDS_KO).toEqual(
      expect.arrayContaining(['말고', '빼고', '외에는']),
    );
  });

  it('TOPOLOGY_XOR_NEGATION_REGEX_KO matches 말고 in standalone position', () => {
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('레드 말고 화이트')).toBe(true);
    expect(matchesXorLexicon('레드 말고 화이트')).toBe(true);
  });

  it('TOPOLOGY_XOR_NEGATION_REGEX_KO matches 빼고 and 외에는', () => {
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('프랑스 빼고 이탈리아')).toBe(true);
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('보르도 외에는 추천 없어?')).toBe(true);
    expect(matchesXorLexicon('프랑스 빼고 이탈리아')).toBe(true);
    expect(matchesXorLexicon('보르도 외에는 추천 없어?')).toBe(true);
  });

  it('Korean negation regex does NOT fire on 말고기 (horse meat) substring trap', () => {
    // Rule 23 false-positive: `말고` is a substring of `말고기` but the
    // boundary regex (lookahead expects non-letter after 말고) rejects it
    // because `기` is a Hangul letter and matches `\p{L}`.
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('말고기 페어링 와인')).toBe(false);
    expect(matchesXorLexicon('말고기 페어링 와인')).toBe(false);
  });

  it('Korean negation regex does NOT fire on 빼고치다 compound form', () => {
    // `빼고치다` is not a common wine-domain word but the boundary guard
    // must still reject it — `빼고` followed by the Hangul letter `치`.
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('빼고치다')).toBe(false);
  });
});

describe('topology-pattern-lexicon — Wave I1 XOR-negation (English)', () => {
  it('TOPOLOGY_XOR_NEGATION_REGEX_EN matches `not X but Y`', () => {
    expect(TOPOLOGY_XOR_NEGATION_REGEX_EN.test('not red but white')).toBe(true);
    expect(matchesXorLexicon('not red but white')).toBe(true);
  });

  it('TOPOLOGY_XOR_NEGATION_REGEX_EN matches `except X`', () => {
    expect(TOPOLOGY_XOR_NEGATION_REGEX_EN.test('except bordeaux')).toBe(true);
    expect(matchesXorLexicon('any red wine except bordeaux')).toBe(true);
  });

  it('TOPOLOGY_XOR_NEGATION_REGEX_EN matches `other than`', () => {
    expect(TOPOLOGY_XOR_NEGATION_REGEX_EN.test('other than cabernet')).toBe(true);
    expect(matchesXorLexicon('anything other than cabernet')).toBe(true);
  });

  it('TOPOLOGY_XOR_NEGATION_REGEX_EN does NOT match bare `except` / `but` / `not` without neighbours', () => {
    // `except` alone (no following word) — the `[\p{L}\p{N}]+` requirement
    // suppresses firing.
    expect(TOPOLOGY_XOR_NEGATION_REGEX_EN.test('with no except')).toBe(false);
    // `but` without the `not X but` triplet.
    expect(TOPOLOGY_XOR_NEGATION_REGEX_EN.test('but this one')).toBe(false);
    // Substring trap: `another` contains `other` — must NOT match `other than`.
    expect(TOPOLOGY_XOR_NEGATION_REGEX_EN.test('another wine')).toBe(false);
  });
});

// ─── Wave I1 — Disjunction markers ───────────────────────────────────────────

describe('topology-pattern-lexicon — Wave I1 disjunction markers', () => {
  it('exposes 아니면 / 혹은 in the disjunction keyword list', () => {
    expect(TOPOLOGY_XOR_DISJUNCTION_KEYWORDS_KO).toEqual(
      expect.arrayContaining(['아니면', '혹은']),
    );
  });

  it('TOPOLOGY_XOR_DISJUNCTION_REGEX_KO matches 아니면 / 혹은 standalone', () => {
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_KO.test('레드 아니면 화이트')).toBe(true);
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_KO.test('메를로 혹은 피노누아')).toBe(true);
    expect(matchesXorLexicon('레드 아니면 화이트')).toBe(true);
    expect(matchesXorLexicon('메를로 혹은 피노누아')).toBe(true);
  });

  it('Korean disjunction regex does NOT fire on 아니면서 (while-not-being) substring trap', () => {
    // `아니면` is a prefix of `아니면서` — the lookahead expects a
    // non-letter after `아니면`, but `서` is Hangul `\p{L}`.
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_KO.test('달지 아니면서 드라이한')).toBe(false);
  });

  it('TOPOLOGY_XOR_DISJUNCTION_REGEX_EN matches `and/or` and `whichever`', () => {
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_EN.test('red and/or white')).toBe(true);
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_EN.test('whichever is cheaper')).toBe(true);
    expect(matchesXorLexicon('red and/or white')).toBe(true);
    expect(matchesXorLexicon('whichever is cheaper')).toBe(true);
  });

  it('TOPOLOGY_XOR_DISJUNCTION_REGEX_EN does NOT match bare `and` or `or`', () => {
    // `and` alone is handled by TOPOLOGY_XOR_REGEX_EN (via `or` branch)
    // at most — the disjunction regex itself must not fire on bare `and`.
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_EN.test('red and white')).toBe(false);
    // `whichever` inside a longer word — no such common word in English,
    // but we still confirm boundary semantics with a prefixed form.
    expect(TOPOLOGY_XOR_DISJUNCTION_REGEX_EN.test('whicheverbundle')).toBe(false);
  });
});

// ─── Wave I1 — Extended course vocabulary ────────────────────────────────────

describe('topology-pattern-lexicon — Wave I1 extended course vocabulary', () => {
  it('Korean 전식 / 본식 / 후식 are recognized as distinct courses', () => {
    expect(TOPOLOGY_COURSE_KEYWORDS_KO).toEqual(
      expect.arrayContaining(['전식', '본식', '후식']),
    );
    // Two courses from the new vocabulary → matches.
    expect(matchesCourseKeywords('전식 본식 후식 페어링')).toBe(true);
    expect(classifyCourseHits('전식 본식 후식 페어링')).toEqual([
      { purpose: 'appetizer' },
      { purpose: 'main_course' },
      { purpose: 'dessert' },
    ]);
  });

  it('Korean 본식 + 디저트 canonicalize correctly (main_course + dessert)', () => {
    const hits = classifyCourseHits('본식에 스테이크, 디저트에 초콜릿');
    expect(hits).toEqual([{ purpose: 'main_course' }, { purpose: 'dessert' }]);
  });

  it('Korean 메인 + 본식 collapse to a single main_course bucket (alias dedup)', () => {
    // Two spellings of the same course must NOT pass the ≥2 distinct-
    // course threshold on their own.
    expect(matchesCourseKeywords('메인 본식 요리만')).toBe(false);
  });

  it('Korean 디저트 + 후식 collapse to a single dessert bucket', () => {
    expect(matchesCourseKeywords('디저트 후식만')).toBe(false);
  });

  it('exports TOPOLOGY_COURSE_PHRASES_KO with 샐러드 코스 / 치즈 코스', () => {
    expect(TOPOLOGY_COURSE_PHRASES_KO).toEqual(
      expect.arrayContaining(['샐러드 코스', '치즈 코스']),
    );
  });

  it('Korean 샐러드 코스 + 메인 → 2 courses (appetizer + main_course)', () => {
    expect(matchesCourseKeywords('샐러드 코스와 메인 요리')).toBe(true);
    expect(classifyCourseHits('샐러드 코스와 메인 요리')).toEqual([
      { purpose: 'appetizer' },
      { purpose: 'main_course' },
    ]);
  });

  it('Korean bare 샐러드 / 치즈 (without 코스 anchor) must NOT promote to a course', () => {
    // Rule 23 false-positive: "샐러드와 빵" is a side + bread, not a
    // salad-course-as-starter. Same for "치즈" as ingredient.
    expect(matchesCourseKeywords('샐러드와 빵 주세요')).toBe(false);
    expect(matchesCourseKeywords('치즈가 들어간 요리')).toBe(false);
  });

  it('English `main dish` / `entrée` / `salad course` / `cheese course` are recognized', () => {
    // entrée (with é) + salad course → main_course + appetizer.
    expect(matchesCourseKeywords('salad course then entrée')).toBe(true);
    expect(classifyCourseHits('salad course then entrée')).toEqual([
      { purpose: 'appetizer' },
      { purpose: 'main_course' },
    ]);
    // main dish + cheese course → main_course + dessert.
    expect(matchesCourseKeywords('main dish and cheese course')).toBe(true);
    expect(classifyCourseHits('main dish and cheese course')).toEqual([
      { purpose: 'main_course' },
      { purpose: 'dessert' },
    ]);
    // entree without accent also matches.
    expect(TOPOLOGY_COURSE_REGEX_EN.test('the entree was great')).toBe(true);
  });

  it('English `cheese` alone (without `course` anchor) must NOT promote to a course', () => {
    // Rule 23 false-positive: "cheese platter" is not a cheese-course
    // announcement — the regex anchors on `cheese\s+course` specifically.
    expect(matchesCourseKeywords('cheese platter and crackers')).toBe(false);
  });

  it('English `main dish and dessert` emits 2 canonical courses', () => {
    expect(matchesCourseKeywords('main dish and dessert')).toBe(true);
    expect(classifyCourseHits('main dish and dessert')).toEqual([
      { purpose: 'main_course' },
      { purpose: 'dessert' },
    ]);
  });
});

// ─── Wave I1 — Broader shared-budget phrasing ────────────────────────────────

describe('topology-pattern-lexicon — Wave I1 shared-budget expansion', () => {
  it('Korean 통틀어 / 전체 예산 / 모두 합해서 / 다 해서 are in the KO keyword list', () => {
    expect(TOPOLOGY_SHARES_BUDGET_KEYWORDS_KO).toEqual(
      expect.arrayContaining(['통틀어', '전체 예산', '모두 합해서', '다 해서']),
    );
  });

  it('Korean 통틀어 + numeric amount → shared-budget signal', () => {
    expect(
      matchesSharedBudgetHint({
        query: '통틀어 15만원 이하로',
        hasMultiSubquery: false,
      }),
    ).toBe(true);
  });

  it('Korean 전체 예산 + amount → shared-budget signal', () => {
    expect(
      matchesSharedBudgetHint({
        query: '전체 예산 20만원',
        hasMultiSubquery: false,
      }),
    ).toBe(true);
  });

  it('Korean 모두 합해서 / 다 해서 + multi-subquery hint → shared-budget', () => {
    expect(
      matchesSharedBudgetHint({
        query: '모두 합해서 편하게',
        hasMultiSubquery: true,
      }),
    ).toBe(true);
    expect(
      matchesSharedBudgetHint({
        query: '다 해서 적당히',
        hasMultiSubquery: true,
      }),
    ).toBe(true);
  });

  it('Korean 통틀어 without amount AND without multi-subquery → no signal (FP discipline)', () => {
    // Co-occurrence guard from Wave H still holds: a bare budget-style
    // keyword with neither an amount nor a decomposition hint must NOT
    // promote to a shares_budget signal.
    expect(
      matchesSharedBudgetHint({ query: '통틀어 궁금해', hasMultiSubquery: false }),
    ).toBe(false);
  });

  it('English TOPOLOGY_SHARES_BUDGET_REGEX_EN matches `in total` / `all in` / `spend up to` / `budget of`', () => {
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('in total $200')).toBe(true);
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('all in under $300')).toBe(true);
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('spend up to $500')).toBe(true);
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('budget of $400')).toBe(true);
  });

  it('English shared-budget regex false-positive discipline', () => {
    // `all in` is common outside budget contexts — the detector-level
    // co-occurrence rule (amount OR multi-subquery) still gates the
    // shares_budget emission. The regex ALONE matches, which is the
    // intended behaviour (cheap keyword filter).
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('all in one bottle')).toBe(true);
    // But `allin` (no space) must NOT match.
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('allinone')).toBe(false);
    // `budget` alone (no `of`) must NOT match the new branch.
    // (It is not part of the original `total|combined|...` list either.)
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('my wine budget')).toBe(false);
  });

  it('matchesSharedBudgetHint: English `budget of $200` + multi-subquery → true', () => {
    expect(
      matchesSharedBudgetHint({
        query: 'pair main course and dessert, budget of $200',
        hasMultiSubquery: true,
      }),
    ).toBe(true);
  });
});
