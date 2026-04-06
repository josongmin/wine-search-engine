import { describe, expect, it } from 'vitest';
import { toQueryDecompositionHint } from '../query-decomposition.js';

describe('toQueryDecompositionHint', () => {
  it('maps non-decomposed outcomes to none strategy', () => {
    expect(toQueryDecompositionHint({ decomposed: false })).toEqual({
      strategy: 'none',
      subQueryCount: 0,
      confidence: 0,
      reason: 'no_decomposition_detected',
    });
  });

  it('maps comparison outcomes to comparison strategy', () => {
    const hint = toQueryDecompositionHint({
      decomposed: true,
      subQueries: ['Opus One', 'Screaming Eagle'],
      comparisonIntent: 'compare',
    });

    expect(hint.strategy).toBe('comparison');
    expect(hint.subQueryCount).toBe(2);
    expect(hint.confidence).toBe(0.9);
    expect(hint.reason).toBe('comparison:compare');
  });
});
