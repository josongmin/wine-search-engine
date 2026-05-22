/**
 * Metric contract regression — SOTA++ reliability foundation.
 *
 * Walks every hand-crafted fixture in
 * `test/benchmark/agent/__tests__/metric-contract-fixtures.ndjson`, runs the
 * scorer + aggregation, and asserts every per-dimension and aggregate value
 * matches the expected value declared in the fixture.
 *
 * The fixtures include a deliberate "broken-contract" case
 * (`hard_constraint_count_threaded`) where a known `extractedHardConstraintCount`
 * MUST survive scoreScenario → ScenarioScores → run-level meanHardConstraints.
 * If any future PR silently drops the aggregator (the failure mode that hid
 * `meanHardConstraints = 0 // TODO` for sessions), this test fails with a
 * clear message naming the dropped field.
 *
 * Append-only regression suite — never delete cases.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  scoreScenario,
  aggregateGeoMean,
  aggregateTrimmedGeoMean,
  type ScenarioExecution,
  type ConstraintExtractionMetricsInput,
} from '../benchmark/agent/scorer.js';
import type { AgentBenchmarkScenario } from '../benchmark/agent/scenario.js';
import {
  TERMINATION_FALLBACK_PARTIAL_CREDIT,
  TRIMMED_GEOMEAN_PROPORTION,
  PENALTY_EXTRA_TOOL_CAP,
} from '../benchmark/agent/constants.js';

interface FixtureExpected {
  readonly criticalFailure?: boolean;
  readonly overall?: number;
  readonly overallAtLeast?: number;
  readonly overallAtMost?: number;
  readonly terminationCorrectness?: number;
  readonly answerQuality?: number;
  readonly answerQualityAtLeast?: number;
  readonly toolAccuracyAtLeast?: number;
  readonly toolAccuracyAtMost?: number;
  readonly judgeIsNull?: boolean;
  readonly judgeEquals?: number;
  readonly extractedHardConstraintCount?: number;
}

interface FixtureRow {
  readonly id: number;
  readonly name: string;
  readonly scenario: AgentBenchmarkScenario;
  readonly execution: ScenarioExecution;
  readonly judgeScore?: number;
  readonly faithfulnessScore?: number;
  readonly constraintMetrics?: ConstraintExtractionMetricsInput;
  readonly expected: FixtureExpected;
}

function loadFixtures(): readonly FixtureRow[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolvePath(here, '../benchmark/agent/__tests__/metric-contract-fixtures.ndjson');
  const raw = readFileSync(fixturePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      // JSON.parse → unknown → narrow (CLAUDE.md rule 12).
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`fixture row ${i + 1} is not an object`);
      }
      return parsed as FixtureRow;
    } catch (err) {
      throw new Error(`failed to parse fixture row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

const FIXTURES = loadFixtures();

describe('benchmark metric contract — per-scenario dimensions', () => {
  it('loads all 10 fixtures', () => {
    expect(FIXTURES.length).toBe(10);
  });

  for (const f of FIXTURES) {
    it(`fixture ${f.id} (${f.name}) matches expected per-dim values`, () => {
      const result = scoreScenario(
        f.scenario,
        f.execution,
        f.judgeScore,
        f.faithfulnessScore,
        undefined,
        undefined,
        undefined,
        undefined,
        f.constraintMetrics,
      );
      const s = result.scores;
      const e = f.expected;

      if (e.criticalFailure !== undefined) {
        expect(s.criticalFailure, `fixture ${f.name}: criticalFailure mismatch`).toBe(e.criticalFailure);
      }
      if (e.overall !== undefined) {
        expect(s.overall, `fixture ${f.name}: overall mismatch`).toBeCloseTo(e.overall, 3);
      }
      if (e.overallAtLeast !== undefined) {
        expect(s.overall, `fixture ${f.name}: overall ≥ ${e.overallAtLeast}`).toBeGreaterThanOrEqual(e.overallAtLeast);
      }
      if (e.overallAtMost !== undefined) {
        expect(s.overall, `fixture ${f.name}: overall ≤ ${e.overallAtMost}`).toBeLessThanOrEqual(e.overallAtMost);
      }
      if (e.terminationCorrectness !== undefined) {
        expect(s.terminationCorrectness, `fixture ${f.name}: terminationCorrectness`).toBeCloseTo(e.terminationCorrectness, 4);
      }
      if (e.answerQuality !== undefined) {
        expect(s.answerQuality, `fixture ${f.name}: answerQuality`).toBeCloseTo(e.answerQuality, 4);
      }
      if (e.answerQualityAtLeast !== undefined) {
        expect(s.answerQuality, `fixture ${f.name}: answerQuality ≥`).toBeGreaterThanOrEqual(e.answerQualityAtLeast);
      }
      if (e.toolAccuracyAtLeast !== undefined) {
        expect(s.toolAccuracy, `fixture ${f.name}: toolAccuracy ≥`).toBeGreaterThanOrEqual(e.toolAccuracyAtLeast);
      }
      if (e.toolAccuracyAtMost !== undefined) {
        expect(s.toolAccuracy, `fixture ${f.name}: toolAccuracy ≤`).toBeLessThanOrEqual(e.toolAccuracyAtMost);
      }
      if (e.judgeIsNull === true) {
        expect(s.judge, `fixture ${f.name}: judge should be null when judgeScore undefined`).toBeNull();
      }
      if (e.judgeEquals !== undefined) {
        expect(s.judge, `fixture ${f.name}: judge`).toBeCloseTo(e.judgeEquals, 4);
      }

      // CRITICAL contract: when constraintMetrics carry a non-null
      // extractedHardConstraintCount, it MUST survive into ScenarioScores
      // byte-for-byte. This is the regression check for the
      // meanHardConstraints = 0 // TODO bug — drop the wiring and this fails.
      if (e.extractedHardConstraintCount !== undefined) {
        expect(
          s.extractedHardConstraintCount,
          `fixture ${f.name}: extractedHardConstraintCount must thread through to scores`,
        ).toBe(e.extractedHardConstraintCount);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Aggregate helpers — boundary cases for trimmed geo-mean
// ─────────────────────────────────────────────────────────────────────

describe('aggregateGeoMean — boundary inputs', () => {
  it('empty array → 0', () => {
    expect(aggregateGeoMean([])).toBe(0);
  });

  it('all 1.0 → 1.0', () => {
    expect(aggregateGeoMean([1, 1, 1, 1, 1])).toBeCloseTo(1, 6);
  });

  it('all 0 → ≈ 1e-6 (EPS floor) → clamped near 0', () => {
    const v = aggregateGeoMean([0, 0, 0, 0]);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(0.001);
  });

  it('mixed [0.5, 0.5, 0.5] → 0.5', () => {
    expect(aggregateGeoMean([0.5, 0.5, 0.5])).toBeCloseTo(0.5, 6);
  });

  it('single outlier 0 collapses the geo-mean', () => {
    const v = aggregateGeoMean([1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    // Geo-mean of nine 1.0s and one ~ε = exp(0.9 · log(ε)) very low.
    expect(v).toBeLessThan(0.5);
  });

  it('NaN input → clamp01 zeroes it before log', () => {
    // clamp01 maps NaN → 0 inside the loop; result mirrors all-zero case.
    const v = aggregateGeoMean([Number.NaN, Number.NaN]);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(0.001);
  });
});

describe('aggregateTrimmedGeoMean — boundary inputs', () => {
  it('5%-trim with single outlier 0 in 20-sample array → trims out the zero', () => {
    const values = [0, ...Array.from({ length: 19 }, () => 1.0)];
    const raw = aggregateGeoMean(values);
    const trimmed = aggregateTrimmedGeoMean(values, TRIMMED_GEOMEAN_PROPORTION);
    // Trim window = floor(20 * 0.05) = 1 from each tail → keeps 18 values (all 1.0).
    expect(trimmed).toBeCloseTo(1, 4);
    // Raw is dragged toward EPS by the outlier — concretely
    // exp(log(EPS)/20) ≈ 0.5 for EPS=1e-6. The trimmed value erases this drag.
    // The gap must be substantial (≥0.4) to confirm trimming is structural.
    expect(trimmed - raw).toBeGreaterThan(0.4);
  });

  it('all 1.0 → trimmed = 1.0', () => {
    const values = Array.from({ length: 20 }, () => 1.0);
    expect(aggregateTrimmedGeoMean(values, TRIMMED_GEOMEAN_PROPORTION)).toBeCloseTo(1, 6);
  });

  it('all 0 → trimmed approximately 0 (no NaN)', () => {
    const values = Array.from({ length: 20 }, () => 0);
    const v = aggregateTrimmedGeoMean(values, TRIMMED_GEOMEAN_PROPORTION);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeLessThan(0.001);
  });

  it('N < 20 → falls back to raw geo-mean (trim window = 0)', () => {
    const values = [1, 1, 1, 1, 1, 0.5];
    const raw = aggregateGeoMean(values);
    const trimmed = aggregateTrimmedGeoMean(values, TRIMMED_GEOMEAN_PROPORTION);
    expect(trimmed).toBeCloseTo(raw, 6);
  });

  it('empty array → 0', () => {
    expect(aggregateTrimmedGeoMean([], TRIMMED_GEOMEAN_PROPORTION)).toBe(0);
  });

  it('single value → falls back to raw', () => {
    const v = aggregateTrimmedGeoMean([0.42], TRIMMED_GEOMEAN_PROPORTION);
    expect(v).toBeCloseTo(0.42, 4);
  });

  it('insight-rule trigger: trimmed exceeds raw by >3pp on heavy-left-tail', () => {
    const values = [
      0, 0, // 2 critical failures
      ...Array.from({ length: 18 }, () => 0.95),
    ];
    const raw = aggregateGeoMean(values);
    const trimmed = aggregateTrimmedGeoMean(values, TRIMMED_GEOMEAN_PROPORTION);
    // Gap must clear the 3pp insight threshold (TRIMMED_VS_RAW_INSIGHT_DELTA).
    expect(trimmed - raw).toBeGreaterThan(0.03);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Constants pinning — drift detection
// ─────────────────────────────────────────────────────────────────────

describe('constants — drift detection (CLAUDE.md rule 30)', () => {
  it('TERMINATION_FALLBACK_PARTIAL_CREDIT pinned at 0.25', () => {
    // If you genuinely need to change this value, update metric-spec.md §A1
    // (terminationCorrectness) AND this assertion AND the fixture for #3.
    expect(TERMINATION_FALLBACK_PARTIAL_CREDIT).toBe(0.25);
  });

  it('TRIMMED_GEOMEAN_PROPORTION pinned at 0.05', () => {
    expect(TRIMMED_GEOMEAN_PROPORTION).toBe(0.05);
  });

  it('PENALTY_EXTRA_TOOL_CAP pinned at 0.5', () => {
    expect(PENALTY_EXTRA_TOOL_CAP).toBe(0.5);
  });
});
