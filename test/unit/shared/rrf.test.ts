import { describe, it, expect } from 'vitest';
import { rrfFuse, rrfContribution, RRF_DEFAULT_K } from '../../../src/domain/shared/utils/rrf.js';

describe('rrfFuse', () => {
  it('single ranked list: top rank gets highest score', () => {
    const ranking = new Map([
      ['entity-A', 1],
      ['entity-B', 2],
      ['entity-C', 3],
    ]);

    const result = rrfFuse([ranking]);
    // Rank 1 → 1/(60+1) = 0.01639..., rank 2 → 1/(60+2), rank 3 → 1/(60+3)
    expect(result.get('entity-A')!).toBeGreaterThan(result.get('entity-B')!);
    expect(result.get('entity-B')!).toBeGreaterThan(result.get('entity-C')!);
  });

  it('item in 2 lists ranks higher than item in 1 list', () => {
    const list1 = new Map([
      ['entity-A', 1],
      ['entity-B', 2],
    ]);
    const list2 = new Map([
      ['entity-A', 1],
      ['entity-C', 2],
    ]);

    const result = rrfFuse([list1, list2]);
    // entity-A appears in both lists; entity-B and entity-C appear in one each
    expect(result.get('entity-A')!).toBeGreaterThan(result.get('entity-B')!);
    expect(result.get('entity-A')!).toBeGreaterThan(result.get('entity-C')!);
  });

  it('k=60 is the default and scores match formula', () => {
    const ranking = new Map([['entity-A', 1]]);
    const result = rrfFuse([ranking]);
    expect(result.get('entity-A')).toBeCloseTo(1 / (RRF_DEFAULT_K + 1), 10);
  });

  it('k can be overridden and scores use overridden k', () => {
    const ranking = new Map([['entity-A', 1]]);
    const resultDefault = rrfFuse([ranking]); // k=RRF_DEFAULT_K
    const resultCustom = rrfFuse([ranking], 10); // k=10

    // 1/(10+1) > 1/(60+1) so custom k produces higher score for rank 1
    expect(resultCustom.get('entity-A')!).toBeGreaterThan(resultDefault.get('entity-A')!);
    expect(resultCustom.get('entity-A')).toBeCloseTo(1 / (10 + 1), 10);
  });

  it('empty inputs yield empty result', () => {
    const result = rrfFuse([]);
    expect(result.size).toBe(0);
  });

  it('single empty ranking yields empty result', () => {
    const emptyRanking = new Map<string, number>();
    const result = rrfFuse([emptyRanking]);
    expect(result.size).toBe(0);
  });

  it('deduplicates by entityId when same id appears in multiple lists', () => {
    const list1 = new Map([['shared-entity', 1]]);
    const list2 = new Map([['shared-entity', 3]]);

    const result = rrfFuse([list1, list2]);
    // Should only have one entry for shared-entity, but with combined scores
    expect(result.size).toBe(1);
    // Score = 1/(RRF_DEFAULT_K+1) + 1/(RRF_DEFAULT_K+3)
    const expected = 1 / (RRF_DEFAULT_K + 1) + 1 / (RRF_DEFAULT_K + 3);
    expect(result.get('shared-entity')!).toBeCloseTo(expected, 10);
  });

  it('score is monotone decreasing in rank (higher rank → lower score)', () => {
    // For ranks 1, 2, 3, 5, 10: scores should be strictly decreasing.
    // rrfContribution(rank) = 1 / (RRF_DEFAULT_K + rank): smaller rank → larger score.
    const ranks = [1, 2, 3, 5, 10];
    const scores = ranks.map((r) => rrfContribution(r));

    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]!);
    }
  });

  it('multiple lists with distinct entities collect all entries', () => {
    const list1 = new Map([['A', 1], ['B', 2]]);
    const list2 = new Map([['C', 1], ['D', 2]]);

    const result = rrfFuse([list1, list2]);
    expect(result.size).toBe(4);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    expect(result.has('C')).toBe(true);
    expect(result.has('D')).toBe(true);
  });

  it('entity in multiple lists accumulates scores correctly', () => {
    const list1 = new Map([['X', 2]]);
    const list2 = new Map([['X', 5]]);
    const list3 = new Map([['X', 10]]);

    const result = rrfFuse([list1, list2, list3]);
    const expected = 1 / (RRF_DEFAULT_K + 2) + 1 / (RRF_DEFAULT_K + 5) + 1 / (RRF_DEFAULT_K + 10);
    expect(result.get('X')!).toBeCloseTo(expected, 10);
  });
});
