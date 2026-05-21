/**
 * Property-based regression lock for the topology-pattern-lexicon SSoT.
 *
 * The lexicon (`src/domain/query/service/topology-pattern-lexicon.ts`) is a
 * deterministic rule-based pattern bank: Korean keyword arrays + Unicode-safe
 * regexes that drive the deterministic topology detector. Because it feeds the
 * constraint-topology-planner, the following invariants MUST hold for ALL
 * inputs (fast-check, numRuns: 100):
 *
 *  P1. Pattern-id uniqueness — the catalog of named lexicon entries (keyword
 *      arrays + regexes) has no duplicate ids and no duplicate keyword tokens
 *      within a list.
 *  P2. Regex validity — every exported RegExp compiles (re-construct from
 *      source+flags) and carries the Unicode `/u` flag.
 *  P3. Korean-safe boundaries (CLAUDE.md rule 8) — no exported regex source
 *      uses ASCII `\b`. `\b` is ASCII-only and silently fails on 한글.
 *  P4. No `\p{L}\p{N}` sequence bug (rule 24) — every Unicode property escape
 *      pair appears inside a `[...]` character class, never as a bare 2-char
 *      sequence.
 *  P5. Match determinism — same query → same matcher verdict across 5 calls
 *      (no leaked regex `/g` lastIndex state).
 *  P6. Known query shapes — wine-type+price English/Korean shapes behave; XOR /
 *      course / shared-budget canonical examples match.
 *  P7. Empty / arbitrary query → no throw; empty query → no match.
 *
 * Append-only regression file. Does NOT loosen the lexicon to make a property
 * pass — a Korean-boundary violation here is a REAL bug to fix in source.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
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
  TOPOLOGY_BUDGET_AMOUNT_REGEX,
  matchesXorLexicon,
  matchesCourseKeywords,
  matchesSharedBudgetHint,
  classifyCourseHits,
} from '../../src/domain/query/service/topology-pattern-lexicon.js';

const NUM_RUNS = 100;

/** Every named regex entry in the lexicon (id → source RegExp). */
const REGEX_ENTRIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['TOPOLOGY_XOR_REGEX_EN', TOPOLOGY_XOR_REGEX_EN],
  ['TOPOLOGY_XOR_NEGATION_REGEX_KO', TOPOLOGY_XOR_NEGATION_REGEX_KO],
  ['TOPOLOGY_XOR_NEGATION_REGEX_EN', TOPOLOGY_XOR_NEGATION_REGEX_EN],
  ['TOPOLOGY_XOR_DISJUNCTION_REGEX_KO', TOPOLOGY_XOR_DISJUNCTION_REGEX_KO],
  ['TOPOLOGY_XOR_DISJUNCTION_REGEX_EN', TOPOLOGY_XOR_DISJUNCTION_REGEX_EN],
  ['TOPOLOGY_COURSE_REGEX_EN', TOPOLOGY_COURSE_REGEX_EN],
  ['TOPOLOGY_SHARES_BUDGET_REGEX_EN', TOPOLOGY_SHARES_BUDGET_REGEX_EN],
  ['TOPOLOGY_BUDGET_AMOUNT_REGEX', TOPOLOGY_BUDGET_AMOUNT_REGEX],
];

/** Every named keyword array in the lexicon (id → tokens). */
const KEYWORD_ENTRIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['TOPOLOGY_XOR_KEYWORDS_KO', TOPOLOGY_XOR_KEYWORDS_KO],
  ['TOPOLOGY_XOR_NEGATION_KEYWORDS_KO', TOPOLOGY_XOR_NEGATION_KEYWORDS_KO],
  ['TOPOLOGY_XOR_DISJUNCTION_KEYWORDS_KO', TOPOLOGY_XOR_DISJUNCTION_KEYWORDS_KO],
  ['TOPOLOGY_COURSE_KEYWORDS_KO', TOPOLOGY_COURSE_KEYWORDS_KO],
  ['TOPOLOGY_COURSE_PHRASES_KO', TOPOLOGY_COURSE_PHRASES_KO],
  ['TOPOLOGY_SHARES_BUDGET_KEYWORDS_KO', TOPOLOGY_SHARES_BUDGET_KEYWORDS_KO],
];

/** All matcher functions exercised for determinism / no-throw. */
const MATCHERS: ReadonlyArray<readonly [string, (q: string) => boolean]> = [
  ['matchesXorLexicon', matchesXorLexicon],
  ['matchesCourseKeywords', matchesCourseKeywords],
  ['matchesSharedBudgetHint', (q) => matchesSharedBudgetHint({ query: q, hasMultiSubquery: false })],
  ['matchesSharedBudgetHintMulti', (q) => matchesSharedBudgetHint({ query: q, hasMultiSubquery: true })],
];

describe('topology-pattern-lexicon — property invariants', () => {
  // ── P1. id + token uniqueness ──────────────────────────────────────────────
  it('P1: lexicon entry ids are unique (regex + keyword catalogs)', () => {
    const ids = [...REGEX_ENTRIES, ...KEYWORD_ENTRIES].map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('P1: no duplicate keyword token within any list', () => {
    for (const [id, tokens] of KEYWORD_ENTRIES) {
      expect(new Set(tokens).size, `duplicate token in ${id}`).toBe(tokens.length);
    }
  });

  // ── P2. regex validity + /u flag ───────────────────────────────────────────
  it('P2: every regex recompiles from source and carries the /u flag', () => {
    for (const [id, re] of REGEX_ENTRIES) {
      expect(() => new RegExp(re.source, re.flags), `${id} malformed`).not.toThrow();
      expect(re.flags.includes('u'), `${id} missing /u`).toBe(true);
    }
  });

  // ── P3. Korean-safe boundaries — no ASCII \b (rule 8) ──────────────────────
  it('P3: no exported regex source uses ASCII \\b word boundary', () => {
    for (const [id, re] of REGEX_ENTRIES) {
      // \b in a /u regex source is the literal escape sequence "\b".
      expect(/\\b/.test(re.source), `${id} uses ASCII \\b on Unicode content`).toBe(false);
    }
  });

  // ── P4. \p{L}\p{N} must be inside a character class (rule 24) ──────────────
  it('P4: every \\p{L}/\\p{N} escape appears inside a [...] char class', () => {
    for (const [id, re] of REGEX_ENTRIES) {
      // Strip all bracketed character classes, then assert no bare \p{...}
      // property escape survives outside a class.
      const withoutClasses = re.source.replace(/\[[^\]]*\]/g, '');
      expect(
        /\\p\{[LN]\}/.test(withoutClasses),
        `${id} has a \\p{L}/\\p{N} escape OUTSIDE a [...] class (rule 24 sequence bug)`,
      ).toBe(false);
    }
  });

  // ── P5. match determinism (no leaked /g lastIndex) ─────────────────────────
  it('P5: matchers are deterministic across 5 repeated calls', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (q) => {
        for (const [, fn] of MATCHERS) {
          const first = fn(q);
          for (let i = 0; i < 4; i++) expect(fn(q)).toBe(first);
        }
        // classifyCourseHits stability too (uses cloned /g regexes internally).
        const c1 = JSON.stringify(classifyCourseHits(q));
        for (let i = 0; i < 4; i++) expect(JSON.stringify(classifyCourseHits(q))).toBe(c1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P5: exported regexes are non-global (stateless .test())', () => {
    for (const [id, re] of REGEX_ENTRIES) {
      expect(re.flags.includes('g'), `${id} is /g — .test() would be stateful`).toBe(false);
    }
  });

  // ── P6. known query shapes ─────────────────────────────────────────────────
  it('P6: wine-type+price shapes carry a budget amount (EN + KO)', () => {
    // "red wine under 50K" style — the budget-amount regex must catch the money.
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('red wine under 50000 KRW')).toBe(true);
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('레드 와인 5만원 이하')).toBe(true);
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('$300 cabernet')).toBe(true);
    // A bare wine type with no money is not a budget amount.
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('red wine please')).toBe(false);
  });

  it('P6: canonical XOR shapes match (EN + KO)', () => {
    expect(matchesXorLexicon('either red or white')).toBe(true);
    expect(matchesXorLexicon('레드 또는 화이트')).toBe(true);
    expect(matchesXorLexicon('스테이크 말고 다른 거')).toBe(true);
  });

  it('P6: 말고 fires but the 말고기 (horse-meat) substring trap does NOT', () => {
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('이거 말고 저거')).toBe(true);
    expect(TOPOLOGY_XOR_NEGATION_REGEX_KO.test('말고기 페어링 추천')).toBe(false);
  });

  it('P6: multi-course shapes need ≥2 distinct courses (EN + KO)', () => {
    expect(matchesCourseKeywords('appetizer and dessert')).toBe(true);
    expect(matchesCourseKeywords('메인 요리와 디저트')).toBe(true);
    // single course → not multi-course
    expect(matchesCourseKeywords('just a dessert')).toBe(false);
    expect(matchesCourseKeywords('디저트만')).toBe(false);
  });

  it('P6: shared-budget needs keyword AND (amount OR multi-subquery)', () => {
    expect(matchesSharedBudgetHint({ query: '총 15만원으로', hasMultiSubquery: false })).toBe(true);
    expect(matchesSharedBudgetHint({ query: '총 예산으로', hasMultiSubquery: true })).toBe(true);
    // keyword present but no amount and single subquery → false
    expect(matchesSharedBudgetHint({ query: '총 추천해줘', hasMultiSubquery: false })).toBe(false);
  });

  // ── P7. empty / arbitrary input safety ─────────────────────────────────────
  it('P7: empty query → no match, no throw', () => {
    for (const [, fn] of MATCHERS) expect(fn('')).toBe(false);
    expect(classifyCourseHits('')).toEqual([]);
  });

  it('P7: arbitrary input (incl. 한글 / accents / emoji) never throws', () => {
    // fc.string in this build is ASCII-only, so build an explicit
    // Unicode generator spanning 한글 (Hangul), accented Latin, emoji,
    // and regex-metacharacter code points to genuinely exercise rule 8/24
    // surfaces (CLAUDE.md test discipline: ASCII + 한글 + accent + emoji).
    const unicodeChar = fc.oneof(
      fc.integer({ min: 0xac00, max: 0xd7a3 }), // 한글 syllables
      fc.integer({ min: 0x00c0, max: 0x024f }), // accented Latin (é, ñ, …)
      fc.integer({ min: 0x1f300, max: 0x1f6ff }), // emoji
      fc.integer({ min: 0x20, max: 0x7e }), // printable ASCII
    ).map((cp) => String.fromCodePoint(cp));
    const adversarial = fc.oneof(
      fc.string({ maxLength: 120 }),
      fc.array(unicodeChar, { maxLength: 60 }).map((cs) => cs.join('')),
      fc.constantFrom('한글 또는 영어', 'café résumé', '🍷🍇 와인', '\\b\\p{L}', '말고기', ''),
    );
    fc.assert(
      fc.property(adversarial, (q) => {
        for (const [, fn] of MATCHERS) expect(typeof fn(q)).toBe('boolean');
        expect(Array.isArray(classifyCourseHits(q))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
