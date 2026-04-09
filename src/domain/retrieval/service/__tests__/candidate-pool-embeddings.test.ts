import { describe, expect, it } from 'vitest';
import { combineSemanticEmbeddings } from '../semantic-embedding-combiner.js';

describe('combineSemanticEmbeddings', () => {
  it('returns undefined for empty input', () => {
    expect(combineSemanticEmbeddings([])).toBeUndefined();
  });

  it('returns the original embedding when only one query embedding exists', () => {
    expect(combineSemanticEmbeddings([[1, 0, 0]])).toEqual([1, 0, 0]);
  });

  it('combines multiple semantic query embeddings into a normalized centroid', () => {
    const combined = combineSemanticEmbeddings([
      [1, 0],
      [0, 1],
    ]);

    expect(combined?.[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(combined?.[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });
});
