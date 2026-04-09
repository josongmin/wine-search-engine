import { describe, it, expect } from 'vitest';
import { decideHedgeRetrieval } from '../hedge-retrieval-policy.js';

describe('decideHedgeRetrieval', () => {
  it('high confidence → no hedge', () => {
    const d = decideHedgeRetrieval(
      { intent: 'entity_exact', confidence: 0.9 },
      [{ intent: 'entity_fuzzy', confidence: 0.7 }],
    );
    expect(d.hedge).toBe(false);
    expect(d.intents).toEqual(['entity_exact']);
    expect(d.reason).toBe('primary_high_confidence');
  });

  it('low confidence + alternative → hedge', () => {
    const d = decideHedgeRetrieval(
      { intent: 'semantic_discovery', confidence: 0.45 },
      [{ intent: 'facet_search', confidence: 0.4 }],
    );
    expect(d.hedge).toBe(true);
    expect(d.intents).toEqual(['semantic_discovery', 'facet_search']);
    expect(d.reason).toBe('primary_low_confidence');
  });

  it('tied confidences → hedge', () => {
    const d = decideHedgeRetrieval(
      { intent: 'facet_search', confidence: 0.7 },
      [{ intent: 'semantic_discovery', confidence: 0.65 }],
    );
    expect(d.hedge).toBe(true);
    expect(d.intents).toEqual(['facet_search', 'semantic_discovery']);
    expect(d.reason).toBe('tied_with_alternative');
  });

  it('no alternatives → no hedge regardless', () => {
    const d = decideHedgeRetrieval(
      { intent: 'mixed_query', confidence: 0.3 },
      [],
    );
    expect(d.hedge).toBe(false);
    expect(d.intents).toEqual(['mixed_query']);
    expect(d.reason).toBe('no_alternatives');
  });

  it('maximum 2 intents', () => {
    const d = decideHedgeRetrieval(
      { intent: 'semantic_discovery', confidence: 0.4 },
      [
        { intent: 'facet_search', confidence: 0.35 },
        { intent: 'pairing_search', confidence: 0.2 },
        { intent: 'mixed_query', confidence: 0.05 },
      ],
    );
    expect(d.hedge).toBe(true);
    expect(d.intents.length).toBeLessThanOrEqual(2);
    expect(d.intents).toEqual(['semantic_discovery', 'facet_search']);
  });

  it('single intent only, clear winner → no hedge', () => {
    const d = decideHedgeRetrieval(
      { intent: 'entity_exact', confidence: 0.8 },
      [{ intent: 'entity_fuzzy', confidence: 0.4 }],
    );
    expect(d.hedge).toBe(false);
    expect(d.intents).toEqual(['entity_exact']);
    expect(d.reason).toBe('primary_clear_winner');
  });
});
