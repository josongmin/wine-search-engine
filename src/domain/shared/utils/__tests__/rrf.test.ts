import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../rrf.js';

describe('rrfFuse', () => {
  it('empty input → empty result', () => {
    const result = rrfFuse([]);
    expect(result.size).toBe(0);
  });

  it('single entity in single list → appears in result', () => {
    const ranking = new Map([['wine-a', 1]]);
    const result = rrfFuse([ranking]);
    expect(result.has('wine-a')).toBe(true);
    expect(result.get('wine-a')).toBeCloseTo(1 / (60 + 1), 10);
  });

  it('single list → ranks preserved (rank 1 > rank 2 > rank 3)', () => {
    const ranking = new Map([
      ['wine-a', 1],
      ['wine-b', 2],
      ['wine-c', 3],
    ]);
    const result = rrfFuse([ranking]);
    const a = result.get('wine-a')!;
    const b = result.get('wine-b')!;
    const c = result.get('wine-c')!;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('two lists that agree → top candidate gets highest score', () => {
    const sparse = new Map([
      ['wine-a', 1],
      ['wine-b', 2],
      ['wine-c', 3],
    ]);
    const dense = new Map([
      ['wine-a', 1],
      ['wine-b', 2],
      ['wine-c', 3],
    ]);
    const result = rrfFuse([sparse, dense]);
    const a = result.get('wine-a')!;
    const b = result.get('wine-b')!;
    const c = result.get('wine-c')!;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    // wine-a should be 2*(1/61)
    expect(a).toBeCloseTo(2 / 61, 10);
  });

  it('two lists disagree → candidate in both lists ranks above candidate in only one', () => {
    // wine-a is rank 1 in sparse only
    // wine-b is rank 2 in sparse AND rank 1 in dense
    const sparse = new Map([
      ['wine-a', 1],
      ['wine-b', 2],
    ]);
    const dense = new Map([
      ['wine-b', 1],
    ]);
    const result = rrfFuse([sparse, dense]);
    const a = result.get('wine-a')!;
    const b = result.get('wine-b')!;
    // wine-a: 1/(60+1) = 1/61 ≈ 0.01639
    // wine-b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61 ≈ 0.02852
    expect(b).toBeGreaterThan(a);
  });

  it('k parameter affects score magnitude but not relative ranking', () => {
    const sparse = new Map([
      ['wine-a', 1],
      ['wine-b', 2],
      ['wine-c', 3],
    ]);
    const dense = new Map([
      ['wine-a', 1],
      ['wine-b', 2],
      ['wine-c', 3],
    ]);

    const resultK60 = rrfFuse([sparse, dense], 60);
    const resultK10 = rrfFuse([sparse, dense], 10);

    // k=10 should produce higher scores than k=60 (denominator is smaller)
    expect(resultK10.get('wine-a')!).toBeGreaterThan(resultK60.get('wine-a')!);

    // Relative ranking must be preserved
    const ordered60 = ['wine-a', 'wine-b', 'wine-c'].map((id) => resultK60.get(id)!);
    const ordered10 = ['wine-a', 'wine-b', 'wine-c'].map((id) => resultK10.get(id)!);

    expect(ordered60[0]).toBeGreaterThan(ordered60[1]!);
    expect(ordered60[1]).toBeGreaterThan(ordered60[2]!);
    expect(ordered10[0]).toBeGreaterThan(ordered10[1]!);
    expect(ordered10[1]).toBeGreaterThan(ordered10[2]!);
  });

  it('uses k=60 as default', () => {
    const ranking = new Map([['wine-a', 1]]);
    const resultDefault = rrfFuse([ranking]);
    const resultExplicit = rrfFuse([ranking], 60);
    expect(resultDefault.get('wine-a')).toBe(resultExplicit.get('wine-a'));
  });

  describe('k guard', () => {
    it('throws when k=0 is passed', () => {
      const ranking = new Map([['wine-a', 1]]);
      expect(() => rrfFuse([ranking], 0)).toThrow('k must be ≥ 1');
    });

    it('throws when k is negative', () => {
      const ranking = new Map([['wine-a', 1]]);
      expect(() => rrfFuse([ranking], -5)).toThrow('k must be ≥ 1');
    });

    it('does not throw when k=1', () => {
      const ranking = new Map([['wine-a', 1]]);
      expect(() => rrfFuse([ranking], 1)).not.toThrow();
    });
  });

  it('entity only in one of two lists still appears in result', () => {
    const sparse = new Map([['wine-a', 1]]);
    const dense = new Map([['wine-b', 1]]);
    const result = rrfFuse([sparse, dense]);
    expect(result.has('wine-a')).toBe(true);
    expect(result.has('wine-b')).toBe(true);
  });

  it('three lists: entity in all three ranks highest', () => {
    const list1 = new Map([['wine-a', 1], ['wine-b', 2]]);
    const list2 = new Map([['wine-a', 1], ['wine-c', 2]]);
    const list3 = new Map([['wine-a', 1], ['wine-d', 2]]);
    const result = rrfFuse([list1, list2, list3]);
    const a = result.get('wine-a')!;
    const b = result.get('wine-b')!;
    const c = result.get('wine-c')!;
    const d = result.get('wine-d')!;
    expect(a).toBeGreaterThan(b);
    expect(a).toBeGreaterThan(c);
    expect(a).toBeGreaterThan(d);
  });
});
