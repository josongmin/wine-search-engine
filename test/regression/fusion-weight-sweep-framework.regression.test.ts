/**
 * Regression: fusion-weight sweep framework.
 *
 * Locks the contract between
 *   - scripts/eval/fusion-weight-sweep/weight-grid.ts
 *   - scripts/eval/fusion-weight-sweep/calibration-record.ts
 *   - src/domain/retrieval/service/per-class-fusion-config.ts
 *
 * Goals:
 *   1. Every production prior WEIGHT_* value declared in
 *      per-class-fusion-config.ts must appear on the grid axis(es) that
 *      can carry it — otherwise the sweep cannot re-discover production.
 *   2. enumerateGrid produces the exact Cartesian product cardinality
 *      and emits unique points.
 *   3. The CalibrationRecord queryClass enum is 1:1 with the
 *      per-class-fusion-config QueryClass union.
 *   4. Schema version is pinned to 'v1' — bumping is a deliberate event.
 */

import { describe, it, expect } from 'vitest';
import {
  SWEEP_WEIGHT_GRID,
  enumerateGrid,
  gridPointCount,
  type WeightPoint,
} from '../../scripts/eval/fusion-weight-sweep/weight-grid.js';
import {
  CALIBRATION_RECORD_VERSION,
  CalibrationRecordSchema,
  SWEEP_QUERY_CLASSES,
} from '../../scripts/eval/fusion-weight-sweep/calibration-record.js';
import {
  PER_CLASS_FUSION,
  DEFAULT_FUSION_CONFIG,
  type QueryClass,
} from '../../src/domain/retrieval/service/per-class-fusion-config.js';

describe('fusion-weight-sweep framework', () => {
  it('SWEEP_WEIGHT_GRID covers every production prior weight on at least one axis', () => {
    const allWeightAxes: ReadonlyArray<readonly number[]> = [
      SWEEP_WEIGHT_GRID.sparseWeight,
      SWEEP_WEIGHT_GRID.denseWeight,
      SWEEP_WEIGHT_GRID.anchorWeight,
    ];
    const union = new Set<number>();
    for (const axis of allWeightAxes) {
      for (const v of axis) union.add(v);
    }

    // Collect every weight actually used in production today.
    const productionWeights = new Set<number>();
    for (const cfg of PER_CLASS_FUSION.values()) {
      productionWeights.add(cfg.sparseWeight);
      productionWeights.add(cfg.denseWeight);
      productionWeights.add(cfg.anchorWeight);
    }
    productionWeights.add(DEFAULT_FUSION_CONFIG.sparseWeight);
    productionWeights.add(DEFAULT_FUSION_CONFIG.denseWeight);
    productionWeights.add(DEFAULT_FUSION_CONFIG.anchorWeight);

    for (const w of productionWeights) {
      expect(
        union.has(w),
        `production weight ${w} is missing from SWEEP_WEIGHT_GRID — the sweep cannot reproduce the current prior`,
      ).toBe(true);
    }
  });

  it('learnedSparseWeight axis stays disabled (pin at [0]) until SPLADE serving lands', () => {
    expect(SWEEP_WEIGHT_GRID.learnedSparseWeight).toEqual([0.0]);
  });

  it('every per-class-fusion learnedSparseWeight currently matches the disabled-axis pin', () => {
    for (const cfg of PER_CLASS_FUSION.values()) {
      expect(cfg.learnedSparseWeight).toBe(0.0);
    }
    expect(DEFAULT_FUSION_CONFIG.learnedSparseWeight).toBe(0.0);
  });

  it('enumerateGrid produces exactly gridPointCount unique Cartesian points', () => {
    const expectedCount =
      SWEEP_WEIGHT_GRID.sparseWeight.length *
      SWEEP_WEIGHT_GRID.denseWeight.length *
      SWEEP_WEIGHT_GRID.anchorWeight.length *
      SWEEP_WEIGHT_GRID.learnedSparseWeight.length;

    expect(gridPointCount(SWEEP_WEIGHT_GRID)).toBe(expectedCount);

    const points: WeightPoint[] = [];
    for (const p of enumerateGrid(SWEEP_WEIGHT_GRID)) points.push(p);

    expect(points).toHaveLength(expectedCount);

    const fingerprints = new Set(
      points.map(
        (p) =>
          `${p.sparseWeight}|${p.denseWeight}|${p.anchorWeight}|${p.learnedSparseWeight}`,
      ),
    );
    expect(fingerprints.size).toBe(expectedCount);
  });

  it('enumerateGrid emits points in a deterministic outer→inner order (sparse → dense → anchor → learnedSparse)', () => {
    // Build a small custom grid so the ordering is easy to assert.
    const tinyGrid = {
      sparseWeight: [0, 1] as readonly number[],
      denseWeight: [10, 20] as readonly number[],
      anchorWeight: [100] as readonly number[],
      learnedSparseWeight: [0] as readonly number[],
    } as const;
    const points = Array.from(enumerateGrid(tinyGrid));

    expect(points).toEqual([
      { sparseWeight: 0, denseWeight: 10, anchorWeight: 100, learnedSparseWeight: 0 },
      { sparseWeight: 0, denseWeight: 20, anchorWeight: 100, learnedSparseWeight: 0 },
      { sparseWeight: 1, denseWeight: 10, anchorWeight: 100, learnedSparseWeight: 0 },
      { sparseWeight: 1, denseWeight: 20, anchorWeight: 100, learnedSparseWeight: 0 },
    ]);
  });

  it('SWEEP_QUERY_CLASSES is 1:1 with the per-class-fusion QueryClass union', () => {
    const productionClasses = new Set<QueryClass>(PER_CLASS_FUSION.keys());
    const sweepClasses = new Set<string>(SWEEP_QUERY_CLASSES);

    // Same membership in both directions.
    for (const qc of productionClasses) {
      expect(
        sweepClasses.has(qc),
        `queryClass '${qc}' present in PER_CLASS_FUSION but missing from SWEEP_QUERY_CLASSES`,
      ).toBe(true);
    }
    for (const qc of sweepClasses) {
      expect(
        productionClasses.has(qc as QueryClass),
        `queryClass '${qc}' present in SWEEP_QUERY_CLASSES but missing from PER_CLASS_FUSION`,
      ).toBe(true);
    }
  });

  it('CalibrationRecord schema version is pinned to v1', () => {
    expect(CALIBRATION_RECORD_VERSION).toBe('v1');
    const ok = CalibrationRecordSchema.safeParse({
      version: 'v1',
      queryClass: 'fallback',
      evaluatedAt: '2026-05-25T00:00:00.000Z',
      gridPoint: {
        sparseWeight: 1.0,
        denseWeight: 1.0,
        anchorWeight: 1.0,
        learnedSparseWeight: 0.0,
      },
      metrics: { ndcgAt5: 0.5, ndcgAt10: 0.5, recallAt20: 0.5, mrr: 0.5 },
      evalCorpus: 'gold-set-v2',
      evalSampleSize: 100,
    });
    expect(ok.success).toBe(true);
  });
});
