import { describe, it, expect } from 'vitest';
import {
  compareScoreDescending,
  compareScoreWithTiebreaker,
  pickMaxByScore,
} from '../stable-comparator.js';

describe('compareScoreDescending', () => {
  it('returns negative when a > b', () => {
    expect(compareScoreDescending(0.9, 0.5)).toBeLessThan(0);
  });

  it('returns positive when b > a', () => {
    expect(compareScoreDescending(0.3, 0.7)).toBeGreaterThan(0);
  });

  it('returns 0 when equal', () => {
    expect(compareScoreDescending(0.5, 0.5)).toBe(0);
  });

  it('treats NaN as -Infinity (a NaN never beats a finite score)', () => {
    expect(compareScoreDescending(NaN, 0.5)).toBeGreaterThan(0);
    expect(compareScoreDescending(0.5, NaN)).toBeLessThan(0);
  });

  it('two NaNs are equal', () => {
    expect(compareScoreDescending(NaN, NaN)).toBe(0);
  });
});

describe('compareScoreWithTiebreaker', () => {
  it('sorts by score then by tiebreaker key', () => {
    type T = { id: string; score: number };
    const items: T[] = [
      { id: 'b', score: 0.5 },
      { id: 'a', score: 0.5 },
      { id: 'c', score: 0.9 },
    ];
    items.sort(compareScoreWithTiebreaker((x) => x.score, (x) => x.id));
    expect(items.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('produces stable order across runs (same input → same output)', () => {
    type T = { id: string; score: number };
    const cmp = compareScoreWithTiebreaker((x: T) => x.score, (x: T) => x.id);
    const golden: T[] = [
      { id: 'aa', score: 0.5 },
      { id: 'bb', score: 0.5 },
      { id: 'cc', score: 0.5 },
    ];
    const orderings = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const shuffled = [...golden].sort(() => 0); // no-op sort
      shuffled.sort(cmp);
      orderings.add(shuffled.map((x) => x.id).join(','));
    }
    expect(orderings.size).toBe(1);
  });
});

describe('pickMaxByScore', () => {
  type Item = { id: string; score: number };
  const score = (x: Item): number => x.score;
  const tie = (x: Item): string => x.id;

  it('empty list → undefined', () => {
    expect(pickMaxByScore([], score, tie)).toBeUndefined();
  });

  it('single item → returned', () => {
    const item: Item = { id: 'x', score: 0.5 };
    expect(pickMaxByScore([item], score, tie)).toBe(item);
  });

  it('picks the highest score', () => {
    const items: Item[] = [
      { id: 'a', score: 0.3 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.5 },
    ];
    expect(pickMaxByScore(items, score, tie)?.id).toBe('b');
  });

  it('ties broken by smallest tiebreaker key', () => {
    const items: Item[] = [
      { id: 'b', score: 0.5 },
      { id: 'a', score: 0.5 },
    ];
    expect(pickMaxByScore(items, score, tie)?.id).toBe('a');
  });

  it('NaN never beats finite', () => {
    const items: Item[] = [
      { id: 'a', score: NaN },
      { id: 'b', score: 0.1 },
    ];
    expect(pickMaxByScore(items, score, tie)?.id).toBe('b');
  });

  it('all-NaN → smallest tiebreaker key', () => {
    const items: Item[] = [
      { id: 'b', score: NaN },
      { id: 'a', score: NaN },
    ];
    expect(pickMaxByScore(items, score, tie)?.id).toBe('a');
  });

  it('stable across 1000 runs of the same input', () => {
    const items: Item[] = [
      { id: 'a', score: 0.5 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.5 },
    ];
    const results = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      results.add(pickMaxByScore(items, score, tie)!.id);
    }
    expect(results.size).toBe(1);
    expect(results.has('a')).toBe(true);
  });
});
