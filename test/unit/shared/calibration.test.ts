import { describe, it, expect } from 'vitest';
import { plattScaling, temperatureScaling } from '../../../src/domain/shared/utils/calibration.js';

describe('plattScaling', () => {
  it('returns ~0.5 at logit=0 with a=1, b=0 (sigmoid midpoint)', () => {
    const result = plattScaling(0, 1, 0);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('returns ~1.0 for extreme positive logit', () => {
    const result = plattScaling(100, 1, 0);
    expect(result).toBeGreaterThan(0.999);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('returns ~0.0 for extreme negative logit', () => {
    const result = plattScaling(-100, 1, 0);
    expect(result).toBeLessThan(0.001);
    expect(result).toBeGreaterThanOrEqual(0.0);
  });

  it('output is always in [0, 1] for a range of inputs', () => {
    const logits = [-1000, -100, -10, -1, 0, 1, 10, 100, 1000];
    for (const logit of logits) {
      const result = plattScaling(logit, 1, 0);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });

  it('output is always in [0, 1] for various a/b parameters', () => {
    const cases = [
      { logit: 5, a: 2, b: -1 },
      { logit: -5, a: 0.5, b: 2 },
      { logit: 0.5, a: 3, b: 0.5 },
    ];
    for (const { logit, a, b } of cases) {
      const result = plattScaling(logit, a, b);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });

  it('larger logit (with positive a) produces larger probability', () => {
    const low = plattScaling(1, 1, 0);
    const high = plattScaling(2, 1, 0);
    expect(high).toBeGreaterThan(low);
  });
});

describe('temperatureScaling', () => {
  it('T=1 preserves relative order of probabilities', () => {
    const logits = [3, 1, 2];
    const result = temperatureScaling(logits, 1);
    // logit 3 should have highest probability, logit 1 lowest
    expect(result[0]).toBeGreaterThan(result[2]!);
    expect(result[2]).toBeGreaterThan(result[1]!);
  });

  it('T=0.001 produces near argmax distribution (winner gets ~1.0)', () => {
    const logits = [10, 1, 2];
    const result = temperatureScaling(logits, 0.001);
    expect(result[0]).toBeGreaterThan(0.99);
    expect(result[1]).toBeLessThan(0.01);
    expect(result[2]).toBeLessThan(0.01);
  });

  it('all scores equal yields uniform distribution', () => {
    const logits = [5, 5, 5];
    const result = temperatureScaling(logits, 1);
    expect(result[0]).toBeCloseTo(1 / 3, 5);
    expect(result[1]).toBeCloseTo(1 / 3, 5);
    expect(result[2]).toBeCloseTo(1 / 3, 5);
  });

  it('outputs sum to 1.0', () => {
    const logits = [1, 2, 3, 4, 5];
    const result = temperatureScaling(logits, 1.5);
    const sum = result.reduce((acc, v) => acc + v, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('monotonicity: if logit_i < logit_j then p_i < p_j (tested at T=0.5, 1.0, 2.0)', () => {
    // Use four logits in strict ascending order.
    const logits = [-2, 0, 1, 3];

    for (const temperature of [0.5, 1.0, 2.0]) {
      const probs = temperatureScaling(logits, temperature);
      // Every adjacent pair must be strictly increasing in the same order as logits.
      for (let i = 0; i < probs.length - 1; i++) {
        expect(probs[i]).toBeLessThan(probs[i + 1]!);
      }
    }
  });

  it('throws for non-positive temperature', () => {
    expect(() => temperatureScaling([1, 2, 3], 0)).toThrow('Temperature must be positive');
    expect(() => temperatureScaling([1, 2, 3], -1)).toThrow('Temperature must be positive');
  });

  it('throws for empty logits array', () => {
    expect(() => temperatureScaling([], 1)).toThrow('Logits array must not be empty');
  });

  it('all outputs are in [0, 1]', () => {
    const logits = [-10, 0, 10, 50];
    const result = temperatureScaling(logits, 2);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('higher temperature produces softer (more uniform) distribution', () => {
    const logits = [10, 1];
    const resultLowT = temperatureScaling(logits, 0.1);
    const resultHighT = temperatureScaling(logits, 10);
    // With low temperature, top logit dominates more
    expect(resultLowT[0]).toBeGreaterThan(resultHighT[0]!);
  });
});
