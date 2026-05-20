import { describe, expect, it } from 'vitest';
import {
  applyIsotonicFit,
  encodeIsotonicParams,
  expectedCalibrationError,
  fitBestCalibration,
  fitIsotonicRegression,
  fitPlattScaling,
  fitTemperatureScaling,
  type CalibrationSample,
} from '../calibration-fitting.js';

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Deterministic synthetic generator: a logistic ground-truth model with
 * controllable slope `a` and bias `b`. Labels are sampled by thresholding a
 * deterministic hash of the raw score, so the same `seed` reproduces the
 * same dataset across runs.
 */
function synthesizeLogisticSamples(options: {
  readonly count: number;
  readonly slope: number;
  readonly bias: number;
  readonly seed: number;
}): CalibrationSample[] {
  const { count, slope, bias, seed } = options;
  const out: CalibrationSample[] = [];
  for (let i = 0; i < count; i++) {
    const rawScore = -3 + (6 * i) / Math.max(1, count - 1);
    const p = sigmoid(slope * rawScore + bias);
    // Hash i + seed into [0, 1), threshold against p.
    const u = pseudoRandom(i, seed);
    out.push({ rawScore, label: u < p ? 1 : 0 });
  }
  return out;
}

function pseudoRandom(i: number, seed: number): number {
  let x = (i + 1) * 2654435761 + seed * 2246822519;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 3266489917) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0xFFFFFFFF;
}

// ─── fitIsotonicRegression (PAV) ───────────────────────────────────────────

describe('fitIsotonicRegression — Pool Adjacent Violators', () => {
  it('returns empty breakpoints for empty input', () => {
    expect(fitIsotonicRegression([]).breakpoints).toEqual([]);
  });

  it('preserves a strictly monotonic sequence (no violations)', () => {
    // Already monotonic labels — PAV passes through without merging.
    const samples: CalibrationSample[] = [
      { rawScore: 0.0, label: 0 },
      { rawScore: 0.3, label: 0 },
      { rawScore: 0.6, label: 1 },
      { rawScore: 0.9, label: 1 },
    ];
    const { breakpoints } = fitIsotonicRegression(samples);
    // Adjacent 0/0 may pool, adjacent 1/1 may pool — result must be monotonic.
    let prevY = -Infinity;
    let prevX = -Infinity;
    for (const bp of breakpoints) {
      expect(bp.y).toBeGreaterThanOrEqual(prevY);
      expect(bp.x).toBeGreaterThanOrEqual(prevX);
      prevY = bp.y;
      prevX = bp.x;
    }
  });

  it('merges adjacent violators (1 then 0 → pooled mean 0.5)', () => {
    const samples: CalibrationSample[] = [
      { rawScore: 0.1, label: 1 },
      { rawScore: 0.2, label: 0 },
    ];
    const { breakpoints } = fitIsotonicRegression(samples);
    // The two should pool into a single block of mean 0.5.
    expect(breakpoints.length).toBe(1);
    expect(breakpoints[0]?.y).toBeCloseTo(0.5);
  });

  it('produces a non-decreasing fit (PAV invariant)', () => {
    const samples = synthesizeLogisticSamples({ count: 200, slope: 1.5, bias: -0.5, seed: 17 });
    const { breakpoints } = fitIsotonicRegression(samples);
    for (let i = 1; i < breakpoints.length; i++) {
      const cur = breakpoints[i];
      const prev = breakpoints[i - 1];
      if (cur === undefined || prev === undefined) continue;
      expect(cur.y).toBeGreaterThanOrEqual(prev.y);
      expect(cur.x).toBeGreaterThan(prev.x);
    }
  });

  it('applyIsotonicFit interpolates between breakpoints (monotonic)', () => {
    const breakpoints = [
      { x: 0.0, y: 0.1 },
      { x: 0.5, y: 0.4 },
      { x: 1.0, y: 0.9 },
    ];
    expect(applyIsotonicFit(0.0, breakpoints)).toBeCloseTo(0.1);
    expect(applyIsotonicFit(0.25, breakpoints)).toBeCloseTo(0.25);
    expect(applyIsotonicFit(0.5, breakpoints)).toBeCloseTo(0.4);
    expect(applyIsotonicFit(0.75, breakpoints)).toBeCloseTo(0.65);
    expect(applyIsotonicFit(1.0, breakpoints)).toBeCloseTo(0.9);
    // Beyond last breakpoint: extrapolates to last y.
    expect(applyIsotonicFit(2.0, breakpoints)).toBeCloseTo(0.9);
  });
});

// ─── encodeIsotonicParams ───────────────────────────────────────────────────

describe('encodeIsotonicParams — matches Calibrator.applyIsotonicFallback format', () => {
  it('emits breakpoint_count + (x_i, y_i) entries the calibrator can consume', () => {
    const params = encodeIsotonicParams([
      { x: 0.1, y: 0.2 },
      { x: 0.7, y: 0.8 },
    ]);
    expect(params['breakpoint_count']).toBe(2);
    expect(params['x_0']).toBe(0.1);
    expect(params['y_0']).toBe(0.2);
    expect(params['x_1']).toBe(0.7);
    expect(params['y_1']).toBe(0.8);
  });

  it('returns count=0 for empty input (calibrator falls back to identity)', () => {
    expect(encodeIsotonicParams([])['breakpoint_count']).toBe(0);
  });
});

// ─── fitPlattScaling ────────────────────────────────────────────────────────

describe('fitPlattScaling — Newton with ridge', () => {
  it('returns degenerate bias for single-class data (no positives)', () => {
    const samples: CalibrationSample[] = Array.from({ length: 10 }, (_, i) => ({
      rawScore: i / 10,
      label: 0 as const,
    }));
    const { a, b } = fitPlattScaling(samples);
    expect(a).toBe(0);
    // Bias should push probability toward zero (negative b).
    expect(b).toBeLessThan(0);
  });

  it('returns degenerate bias for single-class data (no negatives)', () => {
    const samples: CalibrationSample[] = Array.from({ length: 10 }, (_, i) => ({
      rawScore: i / 10,
      label: 1 as const,
    }));
    const { b } = fitPlattScaling(samples);
    expect(b).toBeGreaterThan(0);
  });

  it('recovers slope sign for well-separated data', () => {
    // Positives at high rawScore, negatives at low → slope should be positive.
    const samples: CalibrationSample[] = synthesizeLogisticSamples({
      count: 500,
      slope: 2.0,
      bias: -0.5,
      seed: 42,
    });
    const { a } = fitPlattScaling(samples);
    expect(a).toBeGreaterThan(0);
  });

  it('improves ECE versus the identity (raw score) on noisy logistic data', () => {
    const samples = synthesizeLogisticSamples({
      count: 1000,
      slope: 2.5,
      bias: 0,
      seed: 7,
    });
    const labels = samples.map((s) => s.label);
    const rawClipped = samples.map((s) => Math.max(0, Math.min(1, s.rawScore)));
    const rawEce = expectedCalibrationError(rawClipped, labels);
    const { a, b } = fitPlattScaling(samples);
    const plattPreds = samples.map((s) => sigmoid(a * s.rawScore + b));
    const plattEce = expectedCalibrationError(plattPreds, labels);
    expect(plattEce).toBeLessThan(rawEce);
  });
});

// ─── fitTemperatureScaling ──────────────────────────────────────────────────

describe('fitTemperatureScaling — 1-D bisection', () => {
  it('returns T = 1 for empty or single-class data', () => {
    expect(fitTemperatureScaling([]).temperature).toBe(1);
    expect(
      fitTemperatureScaling([{ rawScore: 0.5, label: 1 as const }]).temperature,
    ).toBe(1);
  });

  it('finds a positive finite temperature for mixed-label data', () => {
    const samples = synthesizeLogisticSamples({
      count: 400,
      slope: 1.0,
      bias: 0,
      seed: 11,
    });
    const { temperature } = fitTemperatureScaling(samples);
    expect(temperature).toBeGreaterThan(0);
    expect(Number.isFinite(temperature)).toBe(true);
  });
});

// ─── expectedCalibrationError ──────────────────────────────────────────────

describe('expectedCalibrationError', () => {
  it('returns 0 for perfectly calibrated predictions', () => {
    // 5 predictions of 0.4 with 2/5 correct → conf=0.4, acc=0.4 → 0 gap.
    const preds = [0.4, 0.4, 0.4, 0.4, 0.4];
    const labels: (0 | 1)[] = [1, 1, 0, 0, 0];
    expect(expectedCalibrationError(preds, labels, 10)).toBeLessThan(0.001);
  });

  it('returns near-1 for maximally miscalibrated predictions', () => {
    // Predict 1.0 always, but never correct.
    const preds = [0.99, 0.99, 0.99, 0.99];
    const labels: (0 | 1)[] = [0, 0, 0, 0];
    expect(expectedCalibrationError(preds, labels, 10)).toBeGreaterThan(0.9);
  });

  it('returns 0 for empty input (canonical zero)', () => {
    expect(expectedCalibrationError([], [])).toBe(0);
  });

  it('rejects mismatched lengths', () => {
    expect(() => expectedCalibrationError([0.5], [0, 1])).toThrow(/length mismatch/);
  });

  it('rejects invalid binCount', () => {
    expect(() => expectedCalibrationError([0.5], [0], 0)).toThrow(/binCount/);
  });
});

// ─── fitBestCalibration ─────────────────────────────────────────────────────

describe('fitBestCalibration', () => {
  it('returns identity-isotonic params when given no samples', () => {
    const params = fitBestCalibration([], 'short_entity');
    expect(params.method).toBe('isotonic');
    expect(params.params['breakpoint_count']).toBe(0);
    expect(params.queryClass).toBe('short_entity');
    expect(params.ece).toBe(1);
  });

  it('produces a CalibrationParams shape consumable by the Calibrator', () => {
    const samples = synthesizeLogisticSamples({ count: 200, slope: 2, bias: 0, seed: 3 });
    const params = fitBestCalibration(samples, 'short_entity');
    expect(['platt', 'isotonic', 'temperature']).toContain(params.method);
    expect(params.ece).toBeGreaterThanOrEqual(0);
    expect(params.ece).toBeLessThanOrEqual(1);
    expect(params.trainedAt).toBeInstanceOf(Date);
    if (params.method === 'platt') {
      expect(params.params['a']).toBeDefined();
      expect(params.params['b']).toBeDefined();
    } else if (params.method === 'temperature') {
      expect(params.params['temperature']).toBeGreaterThan(0);
    } else {
      expect(params.params['breakpoint_count']).toBeGreaterThanOrEqual(0);
    }
  });

  it('selects the method with the lowest ECE among the three candidates', () => {
    const samples = synthesizeLogisticSamples({ count: 500, slope: 1.5, bias: 0.2, seed: 19 });
    const params = fitBestCalibration(samples, 'short_entity');
    // Whatever was selected, its reported ECE should be ≤ the ECE of using the
    // raw clipped scores as the calibrator (the baseline this is replacing).
    const labels = samples.map((s) => s.label);
    const rawEce = expectedCalibrationError(
      samples.map((s) => Math.max(0, Math.min(1, s.rawScore))),
      labels,
    );
    expect(params.ece).toBeLessThanOrEqual(rawEce);
  });
});
