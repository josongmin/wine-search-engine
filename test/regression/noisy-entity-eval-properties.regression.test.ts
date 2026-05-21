/**
 * Property-based regression tests for the Noisy Entity Benchmark scorer
 * (`scripts/eval/run-noisy-entity-eval.ts`).
 *
 * The noisy-entity eval measures how robustly the entity resolver recovers a
 * known wine entity from noisy / perturbed surface forms (typo, accent strip,
 * abbreviation, transliteration, phonetic, mixed-language, Korean short-form,
 * adversarial near-miss). The scorer turns ranked entity IDs into Recall@1,
 * Recall@3 and MRR plus per-category / per-language slices and
 * resolution/provenance match rates. Because the WHOLE point of this benchmark
 * is to be a trustworthy quality gate, the scorer itself must be:
 *
 *   - deterministic given the same inputs,
 *   - bounded in [0,1] for every rate metric and slice,
 *   - finite (no NaN/Infinity leaking from division),
 *   - safe on empty / fully-missing input,
 *   - canonical under Unicode normalization for Korean entity IDs (NFC vs NFD
 *     must NOT change recall — this is the bug class the source guards),
 *   - free of `Math.max/min(...spread)` (rule 9) — verified structurally.
 *
 * Touch-policy: regression-only, append-only. Verifies invariants of the
 * scorer; does not relax the scorer to make a property pass.
 *
 * fast-check numRuns = 100 per property (PROPERTY_RUNS).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  scoreNoisyEntityBenchmark,
  buildPerfectNoisyEntityPredictions,
  getNoisyEntityQualityViolations,
  DEFAULT_RECALL_TOP_K,
  MAX_REPORTED_MISSES,
  type NoisyEntityBenchmarkCase,
  type NoisyEntityBenchmarkReport,
  type NoisyEntitySliceMetrics,
} from '../../scripts/eval/run-noisy-entity-eval.ts';

const PROPERTY_RUNS = 100;

/** Floating-point slack for rate comparisons (sums of 1/k divisions). */
const FP_EPS = 1e-9;

// ---------------------------------------------------------------------------
// Korean entity surface vocabulary — used to build Korean expected IDs so the
// NFC-stability property exercises real Hangul code points, not just ASCII.
// ---------------------------------------------------------------------------
const KOREAN_ENTITY_SLUGS = [
  '오퍼스원-2018',
  '샤또-마고-2015',
  '사시카이아-2018',
  '바롤로-지아코모',
  '로마네콩티-2015',
  '펜폴즈-그랜지-2017',
  '모엣-브뤼',
  '소테른-2015',
  '마시-아마로네',
] as const;

const CATEGORIES = [
  'typo',
  'accent_stripped',
  'abbreviation',
  'transliteration',
  'phonetic',
  'mixed_language',
  'noisy_short_form',
  'adversarial_near_miss',
] as const;

const LANGUAGES = ['en', 'ko', 'mixed'] as const;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

interface GeneratedCase {
  readonly benchmarkCase: NoisyEntityBenchmarkCase;
  readonly expectedRank: number; // -1 = expected absent from ranking
  readonly distractors: readonly string[];
}

/** Arbitrary that produces a valid benchmark case + a ranking plan for it. */
const caseArb = (idIndex: number): fc.Arbitrary<GeneratedCase> =>
  fc.record({
    expectedId: fc.constantFrom(...KOREAN_ENTITY_SLUGS, `entity-${idIndex}-en`),
    category: fc.constantFrom(...CATEGORIES),
    language: fc.constantFrom(...LANGUAGES),
    difficulty: fc.constantFrom(...DIFFICULTIES),
    // -1 means the expected ID is absent from the ranking (a miss).
    expectedRank: fc.integer({ min: -1, max: 6 }),
    nDistractors: fc.integer({ min: 0, max: 5 }),
  }).map(({ expectedId, category, language, difficulty, expectedRank, nDistractors }) => {
    const distractors = Array.from({ length: nDistractors }, (_v, i) => `distractor-${idIndex}-${i}`);
    return {
      benchmarkCase: {
        benchmark_id: `gen-${idIndex}`,
        query: `noisy query ${idIndex}`,
        expected_entity_id: expectedId,
        category,
        language,
        difficulty,
      },
      expectedRank,
      distractors,
    } satisfies GeneratedCase;
  });

const casesArb: fc.Arbitrary<readonly GeneratedCase[]> = fc
  .integer({ min: 0, max: 12 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_v, i) => caseArb(i))));

/**
 * Build the ranked-prediction map from a generated plan. The expected ID is
 * inserted at `expectedRank` (when >= 0) among the distractors; distractors
 * fill the remaining slots. This lets us assert recall/MRR analytically.
 */
function buildRankingMap(
  generated: readonly GeneratedCase[],
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const g of generated) {
    const ids = [...g.distractors];
    if (g.expectedRank >= 0) {
      const insertAt = Math.min(g.expectedRank, ids.length);
      ids.splice(insertAt, 0, g.benchmarkCase.expected_entity_id);
    }
    map.set(g.benchmarkCase.benchmark_id, ids);
  }
  return map;
}

function allSlices(report: NoisyEntityBenchmarkReport): NoisyEntitySliceMetrics[] {
  return [...Object.values(report.by_category), ...Object.values(report.by_language)];
}

function assertRateInUnitInterval(value: number, label: string): void {
  expect(Number.isFinite(value), `${label} must be finite`).toBe(true);
  expect(value, `${label} >= 0`).toBeGreaterThanOrEqual(0 - FP_EPS);
  expect(value, `${label} <= 1`).toBeLessThanOrEqual(1 + FP_EPS);
}

describe('noisy-entity eval scorer — property invariants', () => {
  it('metrics are bounded in [0,1] and finite for arbitrary rankings', () => {
    fc.assert(
      fc.property(casesArb, (generated) => {
        const cases = generated.map((g) => g.benchmarkCase);
        const report = scoreNoisyEntityBenchmark(cases, buildRankingMap(generated));

        assertRateInUnitInterval(report.recall_at_1, 'overall.recall_at_1');
        assertRateInUnitInterval(report.recall_at_3, 'overall.recall_at_3');
        assertRateInUnitInterval(report.mrr, 'overall.mrr');
        for (const slice of allSlices(report)) {
          assertRateInUnitInterval(slice.recall_at_1, 'slice.recall_at_1');
          assertRateInUnitInterval(slice.recall_at_3, 'slice.recall_at_3');
          assertRateInUnitInterval(slice.mrr, 'slice.mrr');
        }
        // recall_at_1 <= recall_at_3 always (R@1 is a subset window of R@K).
        expect(report.recall_at_1).toBeLessThanOrEqual(report.recall_at_3 + FP_EPS);
        // MRR <= recall_at_3 when expected is within top-K window; globally
        // MRR is bounded by recall_at_1 from below is NOT guaranteed, but
        // MRR <= 1 already covered. Assert MRR <= recall_at_3 only when no
        // hit lies beyond the default window for the slice — skip that finer
        // claim and rely on the [0,1] bound which is the safety invariant.
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('is deterministic — identical inputs yield identical metric numbers', () => {
    fc.assert(
      fc.property(casesArb, (generated) => {
        const cases = generated.map((g) => g.benchmarkCase);
        const map = buildRankingMap(generated);
        const a = scoreNoisyEntityBenchmark(cases, map);
        const b = scoreNoisyEntityBenchmark(cases, map);
        expect(b.recall_at_1).toBe(a.recall_at_1);
        expect(b.recall_at_3).toBe(a.recall_at_3);
        expect(b.mrr).toBe(a.mrr);
        expect(b.query_count).toBe(a.query_count);
        expect(JSON.stringify(b.by_category)).toBe(JSON.stringify(a.by_category));
        expect(JSON.stringify(b.by_language)).toBe(JSON.stringify(a.by_language));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('recall@1 equals fraction of cases whose expected ID is at rank 0', () => {
    fc.assert(
      fc.property(casesArb, (generated) => {
        const cases = generated.map((g) => g.benchmarkCase);
        const report = scoreNoisyEntityBenchmark(cases, buildRankingMap(generated));
        if (generated.length === 0) {
          expect(report.recall_at_1).toBe(0);
          return;
        }
        const hitsAt1 = generated.filter((g) => {
          // expected lands at rank 0 only when expectedRank===0 OR
          // (expectedRank>=distractors.length means appended last → not 0
          //  unless there are no distractors).
          if (g.expectedRank < 0) return false;
          const insertAt = Math.min(g.expectedRank, g.distractors.length);
          return insertAt === 0;
        }).length;
        const expected = hitsAt1 / generated.length;
        expect(report.recall_at_1).toBeCloseTo(expected, 9);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('NFC stability — Korean expected IDs match regardless of normalization form', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KOREAN_ENTITY_SLUGS),
        fc.integer({ min: 0, max: 4 }),
        (slug, rank) => {
          const nfc = slug.normalize('NFC');
          const nfd = slug.normalize('NFD');
          // Sanity: these slugs actually differ across normalization forms.
          fc.pre(nfc !== nfd);

          const distractors = ['noise-a', 'noise-b', 'noise-c', 'noise-d'];
          const ids = [...distractors];
          ids.splice(Math.min(rank, ids.length), 0, nfd); // ranking carries NFD

          const benchmarkCase: NoisyEntityBenchmarkCase = {
            benchmark_id: 'nfc-1',
            query: '한글 노이즈 질의',
            expected_entity_id: nfc, // expected authored in NFC
            category: 'transliteration',
            language: 'ko',
            difficulty: 'hard',
          };

          const report = scoreNoisyEntityBenchmark([benchmarkCase], new Map([['nfc-1', ids]]));
          const insertAt = Math.min(rank, distractors.length);
          // Despite NFC vs NFD mismatch, the canonical comparison must hit.
          expect(report.recall_at_3).toBe(insertAt < DEFAULT_RECALL_TOP_K ? 1 : 0);
          expect(report.mrr).toBeCloseTo(1 / (insertAt + 1), 9);
          expect(report.recall_at_1).toBe(insertAt === 0 ? 1 : 0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('perfect predictions yield recall@1 = recall@3 = mrr = 1 (or 0 for empty)', () => {
    fc.assert(
      fc.property(casesArb, (generated) => {
        const cases = generated.map((g) => g.benchmarkCase);
        const perfect = buildPerfectNoisyEntityPredictions(cases);
        const report = scoreNoisyEntityBenchmark(cases, perfect);
        if (cases.length === 0) {
          expect(report.recall_at_1).toBe(0);
          expect(report.mrr).toBe(0);
          return;
        }
        expect(report.recall_at_1).toBe(1);
        expect(report.recall_at_3).toBe(1);
        expect(report.mrr).toBeCloseTo(1, 9);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('empty / fully-missing input is safe (zero metrics, no NaN, null rates)', () => {
    // Empty case set.
    const empty = scoreNoisyEntityBenchmark([], new Map());
    expect(empty.query_count).toBe(0);
    expect(empty.recall_at_1).toBe(0);
    expect(empty.recall_at_3).toBe(0);
    expect(empty.mrr).toBe(0);
    expect(empty.provenance_match_rate).toBeNull();
    expect(empty.resolution_match_rate).toBeNull();
    expect(empty.false_exact_rate).toBeNull();

    // Cases present but NO predictions at all → every metric 0, never NaN.
    fc.assert(
      fc.property(casesArb, (generated) => {
        const cases = generated.map((g) => g.benchmarkCase);
        const report = scoreNoisyEntityBenchmark(cases, new Map());
        expect(report.recall_at_1).toBe(0);
        expect(report.recall_at_3).toBe(0);
        expect(Number.isFinite(report.mrr)).toBe(true);
        expect(report.mrr).toBe(0);
        for (const slice of allSlices(report)) {
          expect(slice.recall_at_1).toBe(0);
          expect(Number.isFinite(slice.mrr)).toBe(true);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('detailed miss buckets never exceed MAX_REPORTED_MISSES while metrics stay exact', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (n) => {
        // All-miss benchmark: every case expected absent from its ranking.
        const cases: NoisyEntityBenchmarkCase[] = Array.from({ length: n }, (_v, i) => ({
          benchmark_id: `miss-${i}`,
          query: `q-${i}`,
          expected_entity_id: `target-${i}`,
          category: 'typo',
          language: 'en',
          difficulty: 'easy',
        }));
        const map = new Map<string, readonly string[]>(
          cases.map((c) => [c.benchmark_id, ['only-wrong-id'] as const]),
        );
        const report = scoreNoisyEntityBenchmark(cases, map);
        expect(report.misses.length).toBeLessThanOrEqual(MAX_REPORTED_MISSES);
        // Aggregate metric is unaffected by the diagnostic cap.
        if (n > 0) {
          expect(report.recall_at_1).toBe(0);
          expect(report.recall_at_3).toBe(0);
          expect(report.query_count).toBe(n);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('quality-gate violations are never produced when metrics clear the floor (perfect run)', () => {
    fc.assert(
      fc.property(
        casesArb,
        fc.float({ min: 0, max: 1, noNaN: true }),
        (generated, floor) => {
          const cases = generated.map((g) => g.benchmarkCase);
          fc.pre(cases.length > 0);
          const report = scoreNoisyEntityBenchmark(cases, buildPerfectNoisyEntityPredictions(cases));
          const violations = getNoisyEntityQualityViolations(report, {
            minRecallAt3: floor,
            enforceMinRecallAt3ByCategory: true,
            enforceMinRecallAt3ByLanguage: true,
          });
          // Perfect run: recall_at_3 == 1 overall and per slice, so no floor in
          // [0,1] can be violated.
          expect(violations).toHaveLength(0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('noisy-entity eval scorer — structural safety', () => {
  it('source contains no Math.max/min spread (rule 9)', () => {
    const sourcePath = fileURLToPath(
      new URL('../../scripts/eval/run-noisy-entity-eval.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');
    expect(/Math\.(?:max|min)\s*\(\s*\.\.\./.test(source)).toBe(false);
  });
});
