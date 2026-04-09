import { describe, it, expect } from 'vitest';
import { findOptimalThreshold } from '../threshold-optimizer.js';

describe('findOptimalThreshold', () => {
  it('empty predictions → threshold=1, coverage=0, risk=0', () => {
    const r = findOptimalThreshold([], { maxRisk: 0.1 });
    expect(r.threshold).toBe(1);
    expect(r.coverage).toBe(0);
    expect(r.risk).toBe(0);
    expect(r.sampleSize).toBe(0);
  });

  it('all correct → threshold at lowest score, coverage=1, risk=0', () => {
    const preds = [
      { score: 0.9, correct: true },
      { score: 0.7, correct: true },
      { score: 0.5, correct: true },
      { score: 0.3, correct: true },
    ];
    const r = findOptimalThreshold(preds, { maxRisk: 0.0 });
    expect(r.coverage).toBe(1);
    expect(r.risk).toBe(0);
    expect(r.threshold).toBe(0.3);
    expect(r.sampleSize).toBe(4);
  });

  it('maxRisk=0 → only fully-correct prefix passes', () => {
    const preds = [
      { score: 0.99, correct: true },
      { score: 0.95, correct: true },
      { score: 0.9, correct: false }, // first wrong — breaks the zero-risk prefix
      { score: 0.8, correct: true },
    ];
    const r = findOptimalThreshold(preds, { maxRisk: 0.0 });
    expect(r.threshold).toBe(0.95);
    expect(r.coverage).toBe(2 / 4);
    expect(r.risk).toBe(0);
  });

  it('maxRisk=1 → all predictions pass', () => {
    const preds = [
      { score: 0.9, correct: false },
      { score: 0.8, correct: false },
      { score: 0.7, correct: true },
    ];
    const r = findOptimalThreshold(preds, { maxRisk: 1.0 });
    expect(r.coverage).toBe(1);
    expect(r.threshold).toBe(0.7);
    expect(r.sampleSize).toBe(3);
  });

  it('minCoverage constraint falls back when risk target unachievable', () => {
    // Zero-risk prefix covers only 1 point, but minCoverage demands 0.5.
    const preds = [
      { score: 0.95, correct: true },
      { score: 0.9, correct: false },
      { score: 0.8, correct: true },
      { score: 0.7, correct: true },
    ];
    const r = findOptimalThreshold(preds, { maxRisk: 0.0, minCoverage: 0.5 });
    // maxRisk=0 alone would give coverage 1/4=0.25 < 0.5 → fallback engages.
    expect(r.coverage).toBeGreaterThanOrEqual(0.5);
    expect(r.sampleSize).toBe(4);
  });

  it('all-NaN predictions → empty result fallback', () => {
    const preds = [
      { score: Number.NaN, correct: true },
      { score: Number.NaN, correct: false },
      { score: Number.POSITIVE_INFINITY, correct: true },
    ];
    const r = findOptimalThreshold(preds, { maxRisk: 0.1 });
    expect(r.sampleSize).toBe(0);
    expect(r.threshold).toBe(1);
    expect(r.coverage).toBe(0);
  });

  it('mixed finite + NaN predictions → only finite contribute', () => {
    const preds = [
      { score: 0.9, correct: true },
      { score: Number.NaN, correct: false },
      { score: 0.5, correct: true },
    ];
    const r = findOptimalThreshold(preds, { maxRisk: 0.1 });
    expect(r.sampleSize).toBe(2);
  });
});
