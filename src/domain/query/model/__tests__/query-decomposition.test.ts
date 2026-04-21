import { describe, expect, it } from 'vitest';
import {
  buildEntityComparisonLegs,
  getComparisonDecompositionSubtype,
  toQueryDecompositionHint,
} from '../query-decomposition.js';

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
    const comparisonLegs = buildEntityComparisonLegs(['Opus One', 'Screaming Eagle']);
    const hint = toQueryDecompositionHint({
      decomposed: true,
      subQueries: ['Opus One', 'Screaming Eagle'],
      comparisonIntent: 'compare',
      comparisonSubtype: 'entity',
      comparisonLegs,
    });

    expect(hint.strategy).toBe('comparison');
    expect(hint.subQueryCount).toBe(2);
    expect(hint.confidence).toBe(0.9);
    expect(hint.reason).toBe('comparison:compare');
    expect(hint.comparisonSubtype).toBe('entity');
    expect(hint.comparisonLegs).toBe(comparisonLegs);
  });

  it('builds explicit entity-default leg metadata when no concept subtype is established', () => {
    const legs = buildEntityComparisonLegs(['Opus One', 'Screaming Eagle']);

    expect(getComparisonDecompositionSubtype(legs)).toBe('entity');
    expect(legs).toEqual([
      {
        rawQuery: 'Opus One',
        retrievalQuery: 'Opus One',
        mode: 'entity',
        retrievalMode: 'auto',
        evidenceSource: 'entity_default',
      },
      {
        rawQuery: 'Screaming Eagle',
        retrievalQuery: 'Screaming Eagle',
        mode: 'entity',
        retrievalMode: 'auto',
        evidenceSource: 'entity_default',
      },
    ]);
  });
});
