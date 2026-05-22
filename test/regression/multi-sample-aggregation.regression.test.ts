/**
 * SOTA++ B1 regression: multi-sample run aggregation.
 *
 * Locks the per-scenario mean/stdev/min/max contract over N runs:
 *   - Synthetic 3-sample inputs produce the expected mean and Bessel-corrected sd.
 *   - Single-sample degenerates to stdev=0 deterministically (never NaN).
 *   - All-identical samples produce stdev=0 and mean equal to the value.
 *   - NaN inputs are filtered (consistent with the benchmark's null-drop policy).
 *   - Nullable series with no non-null entries returns null (judge disabled).
 *
 * Append-only: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateNullableSeries,
  aggregateSeries,
  buildScenarioAggregates,
  sampleStdev,
} from '../benchmark/agent/runner.js';
import type { ScenarioRun } from '../benchmark/agent/scorer.js';

describe('multi-sample aggregation (SOTA++ B1)', () => {
  describe('sampleStdev — Bessel-corrected sample sd', () => {
    it('returns 0 for empty input', () => {
      expect(sampleStdev([])).toBe(0);
    });

    it('returns 0 for n=1 (no Bessel-corrected sd defined)', () => {
      expect(sampleStdev([0.7])).toBe(0);
    });

    it('returns 0 for all-identical samples', () => {
      expect(sampleStdev([0.5, 0.5, 0.5, 0.5])).toBe(0);
    });

    it('computes the textbook sd for n=3 (mean=0.6, sd≈0.1)', () => {
      // values: 0.5, 0.6, 0.7 → mean=0.6, var = ((−.1)² + 0² + .1²) / 2 = 0.01
      // → sd = 0.1
      const sd = sampleStdev([0.5, 0.6, 0.7]);
      expect(sd).toBeCloseTo(0.1, 6);
    });

    it('drops NaN / Infinity inputs before computing sd', () => {
      // Without filter the result would be NaN; with the filter we recover
      // sd(0.5, 0.6, 0.7) ≈ 0.1.
      const sd = sampleStdev([0.5, Number.NaN, 0.6, Number.POSITIVE_INFINITY, 0.7]);
      expect(sd).toBeCloseTo(0.1, 6);
    });
  });

  describe('aggregateSeries — full mean/stdev/min/max envelope', () => {
    it('returns the zero envelope for empty input', () => {
      const a = aggregateSeries([]);
      expect(a).toEqual({ mean: 0, stdev: 0, n: 0, min: 0, max: 0 });
    });

    it('packs single-sample input deterministically (stdev=0, n=1)', () => {
      const a = aggregateSeries([0.72]);
      expect(a.mean).toBeCloseTo(0.72, 6);
      expect(a.stdev).toBe(0);
      expect(a.min).toBeCloseTo(0.72, 6);
      expect(a.max).toBeCloseTo(0.72, 6);
      expect(a.n).toBe(1);
    });

    it('packs synthetic 3-sample input (mean=0.6, sd=0.1, min=0.5, max=0.7)', () => {
      const a = aggregateSeries([0.7, 0.5, 0.6]);
      expect(a.mean).toBeCloseTo(0.6, 6);
      expect(a.stdev).toBeCloseTo(0.1, 6);
      expect(a.min).toBeCloseTo(0.5, 6);
      expect(a.max).toBeCloseTo(0.7, 6);
      expect(a.n).toBe(3);
    });

    it('packs all-identical samples (stdev=0, mean=value)', () => {
      const a = aggregateSeries([0.42, 0.42, 0.42]);
      expect(a.mean).toBeCloseTo(0.42, 6);
      expect(a.stdev).toBe(0);
      expect(a.min).toBeCloseTo(0.42, 6);
      expect(a.max).toBeCloseTo(0.42, 6);
      expect(a.n).toBe(3);
    });

    it('drops NaN and Infinity entries from the count and the mean', () => {
      const a = aggregateSeries([0.5, Number.NaN, 0.7, Number.POSITIVE_INFINITY]);
      expect(a.n).toBe(2);
      expect(a.mean).toBeCloseTo(0.6, 6);
    });
  });

  describe('aggregateNullableSeries — judge / faithfulness paths', () => {
    it('returns null when all entries are null', () => {
      expect(aggregateNullableSeries([null, null, null])).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(aggregateNullableSeries([])).toBeNull();
    });

    it('drops nulls and aggregates the rest', () => {
      const a = aggregateNullableSeries([0.8, null, 0.6]);
      expect(a).not.toBeNull();
      expect(a!.n).toBe(2);
      expect(a!.mean).toBeCloseTo(0.7, 6);
    });
  });

  describe('buildScenarioAggregates — per-dimension envelope', () => {
    const runs: ScenarioRun[] = [
      makeRun({ runIndex: 0, overall: 0.50, executionEfficiency: 0.6, answerQuality: 0.55, judge: 0.8 }),
      makeRun({ runIndex: 1, overall: 0.60, executionEfficiency: 0.7, answerQuality: 0.55, judge: null }),
      makeRun({ runIndex: 2, overall: 0.70, executionEfficiency: 0.8, answerQuality: 0.55, judge: 0.9 }),
    ];

    it('overall mean and sd match the textbook values across the 3 runs', () => {
      const agg = buildScenarioAggregates(runs);
      // overall: mean=0.6, sd=0.1, n=3
      expect(agg.overall.mean).toBeCloseTo(0.6, 6);
      expect(agg.overall.stdev).toBeCloseTo(0.1, 6);
      expect(agg.overall.n).toBe(3);
    });

    it('per-dimension aggregates are independent across dims', () => {
      const agg = buildScenarioAggregates(runs);
      // executionEfficiency: 0.6, 0.7, 0.8 → mean 0.7, sd 0.1
      expect(agg.executionEfficiency.mean).toBeCloseTo(0.7, 6);
      expect(agg.executionEfficiency.stdev).toBeCloseTo(0.1, 6);
      // answerQuality: all 0.55 → stdev=0
      expect(agg.answerQuality.mean).toBeCloseTo(0.55, 6);
      expect(agg.answerQuality.stdev).toBe(0);
    });

    it('judge collapses null entries — n=2 when one run had no judge', () => {
      const agg = buildScenarioAggregates(runs);
      expect(agg.judge).not.toBeNull();
      expect(agg.judge!.n).toBe(2);
      expect(agg.judge!.mean).toBeCloseTo(0.85, 6);
    });

    it('faithfulness is null when no run produced a non-null score', () => {
      const runsAllNullFaith: ScenarioRun[] = runs.map((r) => ({ ...r, faithfulness: null }));
      const agg = buildScenarioAggregates(runsAllNullFaith);
      expect(agg.faithfulness).toBeNull();
    });
  });
});

function makeRun(partial: Partial<ScenarioRun> & { runIndex: number; overall: number }): ScenarioRun {
  return {
    runIndex: partial.runIndex,
    overall: partial.overall,
    executionEfficiency: partial.executionEfficiency ?? partial.overall,
    toolAccuracy: partial.toolAccuracy ?? partial.overall,
    stepEfficiency: partial.stepEfficiency ?? partial.overall,
    answerQuality: partial.answerQuality ?? partial.overall,
    terminationCorrectness: partial.terminationCorrectness ?? 1,
    costEfficiency: partial.costEfficiency ?? 1,
    judge: partial.judge ?? null,
    faithfulness: partial.faithfulness ?? null,
    totalDurationMs: partial.totalDurationMs ?? 1000,
    totalTokensInput: partial.totalTokensInput ?? 500,
    totalTokensOutput: partial.totalTokensOutput ?? 200,
    terminationReason: partial.terminationReason ?? 'answer',
    criticalFailure: partial.criticalFailure ?? false,
  };
}
