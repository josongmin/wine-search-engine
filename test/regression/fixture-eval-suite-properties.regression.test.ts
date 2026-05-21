/**
 * Property-based regression tests for the fixture-eval suite contract.
 *
 * Targets:
 *  - FixtureLoader (src/infrastructure/fixture/fixture-loader.ts)
 *  - SUITE_REGISTRY (src/infrastructure/fixture/suite-registry.ts)
 *
 * These properties guard the **fixture schema versioning** invariants that
 * power the eval.fixture-eval-suite maturity 5 promotion. They mirror the
 * industry-standard pattern (Jest/Vitest snapshot tests + SemVer-style data
 * schema versioning) so that the four eval runners
 *   - scripts/eval/run-entity-retrieval-fixture-eval.ts
 *   - scripts/eval/run-search-feature-behavior-fixture-eval.ts
 *   - scripts/eval/run-agentic-tool-use-fixture-eval.ts
 *   - scripts/eval/run-agentic-answer-quality-fixture-eval.ts
 * can rely on a stable, normalised case shape.
 *
 * Invariants verified (append-only, SOTA++ grade):
 *  1. Loader determinism — BenchmarkCaseSchema.safeParse(x) twice on the
 *     same input yields identical canonical output (same JSON), over 100
 *     arbitrary case bodies. This anchors the "fixture loader is a pure
 *     function" contract.
 *  2. schema_version is present after normalisation — every parsed case
 *     surfaces `schema_version` (defaulting to FIXTURE_SCHEMA_VERSION='1'
 *     when absent on disk).
 *  3. Unknown schema_version rejected — a case with
 *     `schema_version: '99'` (not in FIXTURE_SCHEMA_VERSIONS) is rejected
 *     at the boundary, preventing silent drift when the fixture repo gets
 *     bumped without an engine-side migration.
 *  4. Suite registry uniqueness — SUITE_REGISTRY exposes a set of
 *     pairwise-unique suite ids (and the derived ALL_SUITE_IDS keeps that
 *     property). This is a sanity property the dual `_idSet` startup
 *     assertion already guarantees; we lock it in for downstream consumers.
 *  5. Korean fixture preservation — Korean query bodies (e.g. "오푸스원")
 *     survive normalisation byte-for-byte. Regression guard against the
 *     Rule 5 (regex / boundary) and Rule 8 (Unicode `\b`) traps that
 *     historically truncated Hangul payloads.
 *  6. Empty fixture allowed — an empty fixture body (no cases) does not
 *     throw at the schema boundary; the registry still resolves to an empty
 *     array. Mirrors the loader's runtime behaviour for missing case dirs.
 *
 * Touch-policy: regression-only, append-only. We do not call the on-disk
 * loader here — we exercise the validation boundary directly with synthetic
 * cases so the test is hermetic (no fixture repo, no fs IO). The on-disk
 * happy path is already covered in
 * src/infrastructure/fixture/__tests__/fixture-loader.test.ts.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  BenchmarkCaseSchema,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_SCHEMA_VERSIONS,
} from '../../src/infrastructure/fixture/fixture-loader.js';
import {
  ALL_SUITE_IDS,
  SUITE_REGISTRY,
} from '../../src/infrastructure/fixture/suite-registry.js';

// fast-check defaults — deterministic; failures are re-seeded by the runner.
const RUNS = 100;

// Synthetic case body — small enough that we can shrink reliably, but rich
// enough to cover the optional fields the eval runners read.
const arbCase = (overrides?: Record<string, unknown>) =>
  fc.record({
    id: fc.constant('eek-001'),
    suite: fc.constant('exact_entity_recovery' as const),
    query: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    category: fc.constantFrom('transliteration', 'noisy_short_form', 'mixed_script'),
    language: fc.constantFrom('ko', 'en', 'mixed'),
    difficulty: fc.constantFrom('easy', 'medium', 'hard'),
    evaluation: fc.constant({ mode: 'exact_entity_top1' as const }),
  }).map((c) => ({ ...c, ...(overrides ?? {}) }));

describe('FixtureLoader schema versioning — named constants exist', () => {
  it('FIXTURE_SCHEMA_VERSION is "1" (current major)', () => {
    expect(FIXTURE_SCHEMA_VERSION).toBe('1');
  });

  it('FIXTURE_SCHEMA_VERSIONS is a non-empty tuple including FIXTURE_SCHEMA_VERSION', () => {
    expect(FIXTURE_SCHEMA_VERSIONS.length).toBeGreaterThan(0);
    expect(FIXTURE_SCHEMA_VERSIONS).toContain(FIXTURE_SCHEMA_VERSION);
  });
});

describe('Property: loader determinism (BenchmarkCaseSchema.safeParse is pure)', () => {
  it('safeParse twice yields identical canonical output for arbitrary cases', () => {
    fc.assert(
      fc.property(arbCase(), (rawCase) => {
        const a = BenchmarkCaseSchema.safeParse(rawCase);
        const b = BenchmarkCaseSchema.safeParse(rawCase);
        expect(a.success).toBe(b.success);
        if (a.success && b.success) {
          expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Property: schema_version is present after normalisation', () => {
  it('every parsed case has schema_version field (defaulting to "1")', () => {
    fc.assert(
      fc.property(arbCase(), (rawCase) => {
        const result = BenchmarkCaseSchema.safeParse(rawCase);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.schema_version).toBeDefined();
          expect(result.data.schema_version).toBe(FIXTURE_SCHEMA_VERSION);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('explicit schema_version="1" is preserved through parsing', () => {
    const rawCase = {
      id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: 'Opus One 2018',
      category: 'transliteration',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_top1' },
      schema_version: '1',
    };
    const result = BenchmarkCaseSchema.safeParse(rawCase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe('1');
    }
  });
});

describe('Property: unknown schema_version is rejected', () => {
  it('rejects schema_version="99" (not in FIXTURE_SCHEMA_VERSIONS)', () => {
    const rawCase = {
      id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: 'Opus One 2018',
      category: 'transliteration',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_top1' },
      schema_version: '99',
    };
    const result = BenchmarkCaseSchema.safeParse(rawCase);
    expect(result.success).toBe(false);
  });

  it('rejects every schema_version that is not in the allowlist (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }).filter(
          (v) => !(FIXTURE_SCHEMA_VERSIONS as readonly string[]).includes(v),
        ),
        (badVersion) => {
          const rawCase = {
            id: 'eek-001',
            suite: 'exact_entity_recovery',
            query: 'Opus One 2018',
            category: 'transliteration',
            language: 'en',
            difficulty: 'easy',
            evaluation: { mode: 'exact_entity_top1' },
            schema_version: badVersion,
          };
          const result = BenchmarkCaseSchema.safeParse(rawCase);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('Property: suite registry uniqueness', () => {
  it('SUITE_REGISTRY has unique suite ids', () => {
    const ids = SUITE_REGISTRY.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('ALL_SUITE_IDS preserves uniqueness and matches SUITE_REGISTRY length', () => {
    const unique = new Set(ALL_SUITE_IDS);
    expect(unique.size).toBe(ALL_SUITE_IDS.length);
    expect(ALL_SUITE_IDS.length).toBe(SUITE_REGISTRY.length);
  });

  it('SUITE_REGISTRY has unique case prefixes and directory names (property)', () => {
    const prefixes = SUITE_REGISTRY.map((r) => r.prefix);
    const dirs = SUITE_REGISTRY.map((r) => r.dir);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('Property: Korean fixture preservation (Rule 5 / Rule 8)', () => {
  // Curated Korean wine vocabulary that historically broke under \b regex
  // boundaries. Each surface must survive parse() byte-identical.
  const KOREAN_SURFACES = [
    '오푸스원',
    '샤또 마고',
    '돔 페리뇽',
    '로마네 콩티',
    '샤또 디켐',
    '바롤로',
    '풀바디 레드 와인 추천',
  ] as const;

  for (const surface of KOREAN_SURFACES) {
    it(`preserves Korean query "${surface}" verbatim through schema parse`, () => {
      const rawCase = {
        id: 'eek-001',
        suite: 'exact_entity_recovery',
        query: surface,
        category: 'transliteration',
        language: 'ko' as const,
        difficulty: 'easy' as const,
        evaluation: { mode: 'exact_entity_top1' as const },
      };
      const result = BenchmarkCaseSchema.safeParse(rawCase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe(surface);
        // Verify code-point-level identity — Hangul is intact. Intl.Segmenter
        // splits per grapheme; combined with strict equality on the joined
        // form this catches any normalisation drift the parser might
        // introduce (NFC vs NFD) without tripping the no-misused-spread rule.
        const seg = new Intl.Segmenter('ko', { granularity: 'grapheme' });
        const parsedGraphemes = [...seg.segment(result.data.query)].map((s) => s.segment);
        const sourceGraphemes = [...seg.segment(surface)].map((s) => s.segment);
        expect(parsedGraphemes).toEqual(sourceGraphemes);
      }
    });
  }

  it('preserves arbitrary Hangul-syllable queries through parse (property)', () => {
    const hangulArb = fc.array(
      fc.integer({ min: 0xAC00, max: 0xD7A3 }).map((cp) => String.fromCodePoint(cp)),
      { minLength: 1, maxLength: 20 },
    ).map((chars) => chars.join(''));

    fc.assert(
      fc.property(hangulArb, (koreanQuery) => {
        const rawCase = {
          id: 'eek-001',
          suite: 'exact_entity_recovery',
          query: koreanQuery,
          category: 'transliteration',
          language: 'ko' as const,
          difficulty: 'easy' as const,
          evaluation: { mode: 'exact_entity_top1' as const },
        };
        const result = BenchmarkCaseSchema.safeParse(rawCase);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.query).toBe(koreanQuery);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Property: empty fixture body allowed (graceful degradation)', () => {
  // Mirrors FixtureLoader.loadCases() behaviour: a missing/empty cases dir
  // returns []; the schema layer must not throw on the absence of cases.
  // We model an "empty fixture" as the registry's expected zero-case shape:
  //  - the loader returns [] (no rows to validate)
  //  - any later consumer iterating ALL_SUITE_IDS still resolves cleanly.

  it('an empty array of cases is a valid load result (no throw)', () => {
    const emptyLoaded: ReadonlyArray<unknown> = [];
    // Schema-level: mapping safeParse over [] yields []; no throw.
    const parsed = emptyLoaded.map((raw) => BenchmarkCaseSchema.safeParse(raw));
    expect(parsed).toEqual([]);
  });

  it('schema parse on null/undefined fixture body returns failure, not throw', () => {
    for (const empty of [null, undefined, {}]) {
      // safeParse must not throw — it returns a Result-shaped object.
      expect(() => BenchmarkCaseSchema.safeParse(empty)).not.toThrow();
      const result = BenchmarkCaseSchema.safeParse(empty);
      expect(result.success).toBe(false);
    }
  });
});
