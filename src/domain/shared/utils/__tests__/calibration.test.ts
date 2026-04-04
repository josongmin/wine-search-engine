import { describe, it, expect } from 'vitest';
import { plattScaling, temperatureScaling } from '../calibration.js';

describe('plattScaling', () => {
  it('returns 0.5 when a=1, b=0, logit=0', () => {
    const result = plattScaling(0, 1, 0);
    expect(result).toBeCloseTo(0.5, 10);
  });

  it('produces a value greater than 0.5 for a positive logit', () => {
    const result = plattScaling(2, 1, 0);
    expect(result).toBeGreaterThan(0.5);
  });

  it('produces a value less than 0.5 for a negative logit', () => {
    const result = plattScaling(-2, 1, 0);
    expect(result).toBeLessThan(0.5);
  });

  it('applies known a,b values correctly: plattScaling(1, 2, -1)', () => {
    // sigmoid(2*1 + -1) = sigmoid(1) = 1 / (1 + exp(-1)) ≈ 0.7310585...
    const expected = 1 / (1 + Math.exp(-1));
    expect(plattScaling(1, 2, -1)).toBeCloseTo(expected, 10);
  });

  it('applies known a,b values correctly: plattScaling(0.5, 3, 0.5)', () => {
    // sigmoid(3*0.5 + 0.5) = sigmoid(2) = 1/(1+exp(-2)) ≈ 0.8807970...
    const expected = 1 / (1 + Math.exp(-2));
    expect(plattScaling(0.5, 3, 0.5)).toBeCloseTo(expected, 10);
  });

  it('output is always in [0, 1] for extreme positive logit', () => {
    const result = plattScaling(1000, 1, 0);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('output is always in [0, 1] for extreme negative logit', () => {
    const result = plattScaling(-1000, 1, 0);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('output is monotonically increasing with logit (a > 0)', () => {
    const scores = [-2, -1, 0, 1, 2].map((l) => plattScaling(l, 1, 0));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]!);
    }
  });
});

describe('temperatureScaling', () => {
  it('T=1 produces same output as standard softmax', () => {
    const logits = [1, 2, 3];
    const result = temperatureScaling(logits, 1);
    // Standard softmax
    const exps = logits.map((l) => Math.exp(l - 3));
    const sum = exps.reduce((a, b) => a + b, 0);
    const expected = exps.map((e) => e / sum);
    result.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 10));
  });

  it('outputs sum to 1 for any temperature', () => {
    const logits = [1, 2, 3, 0.5];
    for (const T of [0.1, 0.5, 1, 2, 10]) {
      const result = temperatureScaling(logits, T);
      const sum = result.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('high temperature (T=1000) approaches uniform distribution', () => {
    const logits = [1, 2, 3, 4];
    const result = temperatureScaling(logits, 1000);
    const uniform = 1 / logits.length;
    result.forEach((v) => expect(v).toBeCloseTo(uniform, 2));
  });

  it('low temperature (T=0.01) approaches argmax (one-hot on max)', () => {
    const logits = [1, 5, 2, 3];
    const result = temperatureScaling(logits, 0.01);
    // Index 1 has max logit (5), should dominate
    expect(result[1]).toBeGreaterThan(0.99);
    expect(result[0]).toBeLessThan(0.01);
    expect(result[2]).toBeLessThan(0.01);
    expect(result[3]).toBeLessThan(0.01);
  });

  it('all outputs are in [0, 1]', () => {
    const logits = [-10, 0, 5, 100];
    const result = temperatureScaling(logits, 1);
    result.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  it('throws when temperature <= 0', () => {
    expect(() => temperatureScaling([1, 2, 3], 0)).toThrow('Temperature must be positive');
    expect(() => temperatureScaling([1, 2, 3], -1)).toThrow('Temperature must be positive');
  });

  it('throws when logits array is empty', () => {
    expect(() => temperatureScaling([], 1)).toThrow('Logits array must not be empty');
  });

  it('single element returns [1.0]', () => {
    const result = temperatureScaling([42], 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(1, 10);
  });
});
