import { describe, it, expect } from 'vitest';
import { computeAURC } from '../aurc.js';
import { computeECE } from '../ece.js';
import { fitPlattCalibrator } from '../platt-scaling.js';

describe('computeAURC', () => {
  it('empty input → AURC 0, empty curve', () => {
    const r = computeAURC([]);
    expect(r.aurc).toBe(0);
    expect(r.curve).toHaveLength(0);
  });

  it('all correct → AURC 0', () => {
    const r = computeAURC([
      { confidence: 0.9, correct: true },
      { confidence: 0.8, correct: true },
      { confidence: 0.7, correct: true },
    ]);
    expect(r.aurc).toBe(0);
    expect(r.coverage_at_risk_5pct).toBe(1);
  });

  it('all wrong → AURC 1', () => {
    const r = computeAURC([
      { confidence: 0.9, correct: false },
      { confidence: 0.5, correct: false },
    ]);
    expect(r.aurc).toBe(1);
    expect(r.coverage_at_risk_5pct).toBe(0);
  });

  it('coverage_at_risk thresholds work', () => {
    // Top 5 are correct, then incorrect → coverage at risk 0 = 0.5
    const preds = [
      { confidence: 0.99, correct: true },
      { confidence: 0.98, correct: true },
      { confidence: 0.97, correct: true },
      { confidence: 0.96, correct: true },
      { confidence: 0.95, correct: true },
      { confidence: 0.5, correct: false },
      { confidence: 0.4, correct: false },
      { confidence: 0.3, correct: false },
      { confidence: 0.2, correct: false },
      { confidence: 0.1, correct: false },
    ];
    const r = computeAURC(preds);
    // At coverage 0.5 risk should be 0; at 1.0 it's 0.5
    expect(r.coverage_at_risk_5pct).toBeGreaterThanOrEqual(0.5);
    expect(r.aurc).toBeLessThan(0.5);
  });

  it('non-finite confidence values are dropped', () => {
    const r = computeAURC([
      { confidence: NaN, correct: true },
      { confidence: 0.9, correct: true },
    ]);
    expect(r.curve).toHaveLength(1);
  });
});

describe('computeECE', () => {
  it('empty input → ECE 0', () => {
    expect(computeECE([])).toEqual({ ece: 0, maxCalibrationError: 0, bins: [] });
  });

  it('perfect calibration → ECE near 0', () => {
    // confidence == accuracy in each bin
    const preds = [
      ...Array.from({ length: 10 }, () => ({ confidence: 0.95, correct: true })),
      ...Array.from({ length: 1 }, () => ({ confidence: 0.95, correct: false })),
    ];
    const r = computeECE(preds, 10);
    // Bin centered at 0.95: avgConf=0.95, accuracy=10/11=~0.909, error=~0.04
    expect(r.ece).toBeLessThan(0.06);
  });

  it('overconfident model → high ECE', () => {
    // Says 0.99 confidence, only 50% correct
    const preds = [
      { confidence: 0.99, correct: true },
      { confidence: 0.99, correct: false },
      { confidence: 0.99, correct: true },
      { confidence: 0.99, correct: false },
    ];
    const r = computeECE(preds, 10);
    expect(r.ece).toBeGreaterThan(0.4);
  });

  it('confidence 1 lands in last bin', () => {
    const r = computeECE([{ confidence: 1, correct: true }], 10);
    expect(r.bins[9]!.count).toBe(1);
  });
});

describe('fitPlattCalibrator', () => {
  it('returns degenerate calibrator on too-few points', () => {
    const cal = fitPlattCalibrator([{ score: 0.5, correct: true }]);
    expect(cal.calibrate(0.5)).toBe(0.5);
  });

  it('output is in [0, 1]', () => {
    const cal = fitPlattCalibrator([
      { score: -2, correct: false },
      { score: 2, correct: true },
      { score: -1, correct: false },
      { score: 1, correct: true },
    ]);
    for (const x of [-10, -1, 0, 1, 10]) {
      const p = cal.calibrate(x);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('separable data → high score → high probability', () => {
    const cal = fitPlattCalibrator([
      { score: -5, correct: false },
      { score: -4, correct: false },
      { score: -3, correct: false },
      { score: 3, correct: true },
      { score: 4, correct: true },
      { score: 5, correct: true },
    ]);
    expect(cal.calibrate(5)).toBeGreaterThan(cal.calibrate(-5));
  });

  it('non-finite input → 0.5', () => {
    const cal = fitPlattCalibrator([
      { score: -1, correct: false },
      { score: 1, correct: true },
    ]);
    expect(cal.calibrate(NaN)).toBe(0.5);
  });
});
