import { describe, it, expect } from 'vitest';
import { computeProducerPrestige } from '../index-to-vespa.js';

describe('computeProducerPrestige', () => {
  it('returns undefined when ratingsCount is missing', () => {
    expect(computeProducerPrestige({})).toBeUndefined();
    expect(computeProducerPrestige({ ratingsCount: null })).toBeUndefined();
  });

  it('returns undefined for wines with zero ratings (no community validation)', () => {
    expect(computeProducerPrestige({ ratingsCount: 0, ratingAvg: 4.5 })).toBeUndefined();
    expect(computeProducerPrestige({ ratingsCount: -1, ratingAvg: 4.0 })).toBeUndefined();
  });

  it('returns volume-only when ratingAvg is missing', () => {
    // log10(101)/log10(10001) ≈ 2.004/4.000 ≈ 0.5011
    const v = computeProducerPrestige({ ratingsCount: 100 });
    expect(v).toBeGreaterThan(0.49);
    expect(v).toBeLessThan(0.52);
  });

  it('returns clamp01(volume × quality) for full input', () => {
    // ratingsCount=1000, ratingAvg=4.0
    // volume = log10(1001)/log10(10001) ≈ 3.0004/4.0001 ≈ 0.7501
    // quality = (4.0 - 3.0) / (4.5 - 3.0) ≈ 0.6667
    // prestige ≈ 0.5001
    const v = computeProducerPrestige({ ratingsCount: 1000, ratingAvg: 4.0 });
    expect(v).toBeGreaterThan(0.49);
    expect(v).toBeLessThan(0.51);
  });

  it('clamps quality from below at baseline (no negative contribution)', () => {
    // ratingAvg below 3.0 → quality clamps to 0 → prestige = 0
    expect(computeProducerPrestige({ ratingsCount: 5000, ratingAvg: 2.5 })).toBe(0);
    expect(computeProducerPrestige({ ratingsCount: 5000, ratingAvg: 3.0 })).toBe(0);
  });

  it('clamps quality from above at ceiling (no super-prestige)', () => {
    // ratingAvg=5.0 → quality clamps to 1.0; volume drives result
    const v5 = computeProducerPrestige({ ratingsCount: 10000, ratingAvg: 5.0 });
    const v45 = computeProducerPrestige({ ratingsCount: 10000, ratingAvg: 4.5 });
    // Both should be equal (quality saturated at 1.0)
    expect(v5).toEqual(v45);
  });

  it('caps volume at ceiling (no overshoot beyond 1.0)', () => {
    // ratingsCount above the 10K ceiling stays clamped
    const v100k = computeProducerPrestige({ ratingsCount: 100_000, ratingAvg: 4.5 });
    expect(v100k).toBeLessThanOrEqual(1.0);
    expect(v100k).toBeGreaterThanOrEqual(0.99);
  });

  it('preserves the monotone ranking volume × quality implies', () => {
    // A wine with high volume and modest quality outranks a tiny-volume top-rated wine.
    // 10K ratings @ 3.8 vs 10 ratings @ 4.5
    const vHigh = computeProducerPrestige({ ratingsCount: 10_000, ratingAvg: 3.8 })!;
    const vLow = computeProducerPrestige({ ratingsCount: 10, ratingAvg: 4.5 })!;
    expect(vHigh).toBeGreaterThan(vLow);
  });

  it('handles real corpus distribution (p50 → 0, p75 ≈ 0.15, p90 ≈ 0.25)', () => {
    // From measured silver-trackc distribution (n=2000):
    // p50=0, p75=54, p90=170. Multiplicative quality (assume avg=3.8 mid-tier).
    expect(computeProducerPrestige({ ratingsCount: 0, ratingAvg: 3.8 })).toBeUndefined();
    const p75 = computeProducerPrestige({ ratingsCount: 54, ratingAvg: 3.8 })!;
    const p90 = computeProducerPrestige({ ratingsCount: 170, ratingAvg: 3.8 })!;
    expect(p75).toBeGreaterThan(0);
    expect(p75).toBeLessThan(p90);
    expect(p90).toBeLessThan(0.4); // sanity: mid-tier doesn't dominate
  });
});
