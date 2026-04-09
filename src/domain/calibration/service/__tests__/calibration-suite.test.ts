import { describe, it, expect } from 'vitest';
import { buildCalibrationReport } from '../calibration-suite.js';

describe('buildCalibrationReport', () => {
  it('empty input → all sub-reports are empty/zero', () => {
    const r = buildCalibrationReport([]);
    expect(r.sampleSize).toBe(0);
    expect(r.aurc.aurc).toBe(0);
    expect(r.aurc.curve).toHaveLength(0);
    expect(r.ece.ece).toBe(0);
    expect(r.ece.bins).toHaveLength(0);
    expect(r.conformal_90.calibrationSize).toBe(0);
    expect(r.conformal_95.calibrationSize).toBe(0);
    expect(r.optimal_threshold_5pct_risk.sampleSize).toBe(0);
    expect(r.optimal_threshold_10pct_risk.sampleSize).toBe(0);
  });

  it('mixed predictions → all sub-reports populated', () => {
    const preds = [
      { score: 0.95, correct: true },
      { score: 0.9, correct: true },
      { score: 0.85, correct: true },
      { score: 0.8, correct: false },
      { score: 0.7, correct: true },
      { score: 0.6, correct: false },
      { score: 0.5, correct: true },
      { score: 0.4, correct: false },
      { score: 0.3, correct: false },
      { score: 0.2, correct: false },
    ];
    const r = buildCalibrationReport(preds);
    expect(r.sampleSize).toBe(10);
    expect(r.aurc.curve.length).toBe(10);
    expect(r.ece.bins.length).toBeGreaterThan(0);
    // Platt calibrator should produce a value in (0, 1) for mid scores.
    const p = r.platt.calibrate(0.5);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(r.conformal_90.calibrationSize).toBe(10);
    expect(r.conformal_95.calibrationSize).toBe(10);
    expect(r.conformal_90.coverageLevel).toBe(0.9);
    expect(r.conformal_95.coverageLevel).toBe(0.95);
    expect(r.optimal_threshold_5pct_risk.sampleSize).toBe(10);
    expect(r.optimal_threshold_10pct_risk.sampleSize).toBe(10);
  });

  it('sampleSize matches input length', () => {
    const preds = Array.from({ length: 37 }, (_, i) => ({
      score: i / 37,
      correct: i % 2 === 0,
    }));
    const r = buildCalibrationReport(preds);
    expect(r.sampleSize).toBe(37);
    expect(r.conformal_90.calibrationSize).toBe(37);
    expect(r.optimal_threshold_10pct_risk.sampleSize).toBe(37);
  });

  it('mixed finite + NaN predictions → only finite contribute to sub-reports', () => {
    const preds = [
      { score: 0.95, correct: true },
      { score: Number.NaN, correct: false },
      { score: 0.7, correct: true },
      { score: Number.POSITIVE_INFINITY, correct: false },
      { score: 0.4, correct: false },
    ];
    const r = buildCalibrationReport(preds);
    // sampleSize is the raw input length (suite reports the input it received).
    expect(r.sampleSize).toBe(5);
    // Sub-reports filter non-finite, so calibrationSize == 3.
    expect(r.conformal_90.calibrationSize).toBe(3);
    expect(r.optimal_threshold_5pct_risk.sampleSize).toBe(3);
    // Platt and ECE should also handle the NaN gracefully (no NaN propagation).
    expect(Number.isFinite(r.ece.ece)).toBe(true);
    expect(Number.isFinite(r.platt.calibrate(0.5))).toBe(true);
  });
});
