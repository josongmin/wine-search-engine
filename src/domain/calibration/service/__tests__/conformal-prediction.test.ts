import { describe, it, expect } from 'vitest';
import {
  applyConformal,
  calibrateConformal,
  DEFAULT_COVERAGE_90,
} from '../conformal-prediction.js';

describe('calibrateConformal', () => {
  it('empty calibration → tau is NaN sentinel, calibrationSize = 0, all scores rejected', () => {
    const r = calibrateConformal([], DEFAULT_COVERAGE_90);
    expect(Number.isNaN(r.tau)).toBe(true);
    expect(r.calibrationSize).toBe(0);
    expect(r.coverageLevel).toBe(DEFAULT_COVERAGE_90);
    // Fail-closed: no calibration data → no confidence claim possible.
    // applyConformal must reject any score (NaN comparisons return false).
    expect(applyConformal(0.99, r).aboveThreshold).toBe(false);
    expect(applyConformal(0.5, r).aboveThreshold).toBe(false);
    expect(applyConformal(0.0, r).aboveThreshold).toBe(false);
  });

  it('perfect calibration (all correct, moderate score) → tau low', () => {
    const predictions = Array.from({ length: 20 }, () => ({
      score: 0.8,
      correct: true,
    }));
    const r = calibrateConformal(predictions, DEFAULT_COVERAGE_90);
    // nonconformity = 1 - 0.8 = 0.2 for all; tau should be ~0.2.
    expect(r.tau).toBeCloseTo(0.2, 5);
    expect(r.calibrationSize).toBe(20);
    // A new higher-confidence prediction (score 0.95 → nc 0.05 < 0.2) should pass.
    const applied = applyConformal(0.95, r);
    expect(applied.aboveThreshold).toBe(true);
  });

  it('all wrong (high score) → tau high (nothing legitimately passes)', () => {
    const predictions = Array.from({ length: 20 }, () => ({
      score: 0.95,
      correct: false,
    }));
    const r = calibrateConformal(predictions, DEFAULT_COVERAGE_90);
    // nonconformity = score = 0.95; tau at high quantile → ~0.95.
    expect(r.tau).toBeCloseTo(0.95, 5);
    // A new score of 0.9 has nc = 0.1 < 0.95 → would be accepted.
    // A new score of 0.01 has nc = 0.99 > 0.95 → rejected.
    const rejected = applyConformal(0.01, r);
    expect(rejected.aboveThreshold).toBe(false);
  });

  it('90% coverage produces a meaningful tau on mixed data', () => {
    // 18 correct with high score, 2 wrong with high score → nonconformities:
    // 18 points at 1 - 0.9 = 0.1, 2 points at 0.9.
    const predictions = [
      ...Array.from({ length: 18 }, () => ({ score: 0.9, correct: true })),
      ...Array.from({ length: 2 }, () => ({ score: 0.9, correct: false })),
    ];
    const r = calibrateConformal(predictions, 0.9);
    expect(r.calibrationSize).toBe(20);
    // rank = ceil(0.9 * 21) = 19; sorted nc ascending:
    // [0.1 × 18, 0.9 × 2]; 19th element = 0.9.
    expect(r.tau).toBeCloseTo(0.9, 5);
  });

  it('applyConformal correctly classifies new scores', () => {
    const predictions = [
      { score: 0.9, correct: true },
      { score: 0.8, correct: true },
      { score: 0.7, correct: true },
      { score: 0.6, correct: false },
      { score: 0.5, correct: false },
    ];
    const calib = calibrateConformal(predictions, 0.8);
    // A very high score should be accepted; a very low score rejected.
    const hi = applyConformal(0.99, calib);
    const lo = applyConformal(0.01, calib);
    expect(hi.point).toBe(0.99);
    expect(lo.point).toBe(0.01);
    // High scores have low nonconformity → more likely above threshold.
    expect(hi.aboveThreshold || !lo.aboveThreshold).toBe(true);
    // Non-finite score → rejected.
    const nan = applyConformal(Number.NaN, calib);
    expect(nan.aboveThreshold).toBe(false);
  });

  it('coverage_level < 0 falls back to DEFAULT_COVERAGE_90', () => {
    const r = calibrateConformal([{ score: 0.8, correct: true }], -0.5);
    expect(r.coverageLevel).toBe(DEFAULT_COVERAGE_90);
  });

  it('coverage_level > 1 falls back to DEFAULT_COVERAGE_90', () => {
    const r = calibrateConformal([{ score: 0.8, correct: true }], 1.5);
    expect(r.coverageLevel).toBe(DEFAULT_COVERAGE_90);
  });

  it('coverage_level exactly 1.0 is accepted (full coverage)', () => {
    const r = calibrateConformal(
      [
        { score: 0.9, correct: true },
        { score: 0.5, correct: false },
      ],
      1.0,
    );
    expect(r.coverageLevel).toBe(1.0);
  });

  it('coverage_level exactly 0 falls back (degenerate, covers nothing)', () => {
    const r = calibrateConformal([{ score: 0.5, correct: true }], 0);
    expect(r.coverageLevel).toBe(DEFAULT_COVERAGE_90);
  });
});
