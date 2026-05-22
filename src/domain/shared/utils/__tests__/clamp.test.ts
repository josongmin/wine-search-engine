import { describe, expect, it } from 'vitest';
import { clamp, clamp01, assertScore01 } from '../clamp.js';

describe('clamp01', () => {
  it('passes values already in [0, 1] through unchanged', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps out-of-range values to the nearest bound', () => {
    expect(clamp01(-0.001)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });

  it('clamps non-finite input to 0 (defensive normalization)', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('clamp', () => {
  it('clamps to the inclusive [lo, hi] range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('returns lo for non-finite input', () => {
    expect(clamp(Number.NaN, 2, 8)).toBe(2);
  });

  it('returns lo when the range is inverted (caller bug, no silent swap)', () => {
    expect(clamp(5, 10, 0)).toBe(10);
  });
});

describe('assertScore01', () => {
  it('returns the value unchanged for valid [0, 1] scores', () => {
    expect(assertScore01(0, 'normalizedScore')).toBe(0);
    expect(assertScore01(0.42, 'relevanceScore')).toBe(0.42);
    expect(assertScore01(1, 'confidence')).toBe(1);
  });

  it('throws on values just outside the [0, 1] bound (rejection path)', () => {
    expect(() => assertScore01(-0.0001, 'normalizedScore')).toThrow(/normalizedScore/);
    expect(() => assertScore01(1.0001, 'relevanceScore')).toThrow(/relevanceScore/);
  });

  it('throws on non-finite input (NaN / Infinity)', () => {
    expect(() => assertScore01(Number.NaN, 'score')).toThrow(/\[0, 1\]/u);
    expect(() => assertScore01(Number.POSITIVE_INFINITY, 'score')).toThrow();
    expect(() => assertScore01(Number.NEGATIVE_INFINITY, 'score')).toThrow();
  });

  it('names the offending field in the error so the bug is locatable', () => {
    expect(() => assertScore01(2, 'producerPrestige')).toThrow(/producerPrestige must be a finite number in \[0, 1\]/u);
  });
});
