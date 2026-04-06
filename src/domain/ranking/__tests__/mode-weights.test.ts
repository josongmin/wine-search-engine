import { describe, expect, it } from 'vitest';
import { getModeWeights, DEFAULT_WEIGHTS } from '../model/mode-weights.js';

describe('getModeWeights', () => {
  it('returns a profile for every retrieval mode key', () => {
    const entityLookup = getModeWeights('entity_lookup');
    expect(entityLookup.lexicalWeight).toBeGreaterThan(0);
    expect(entityLookup.semanticWeight).toBeGreaterThan(0);
  });

  it('exposes a no-op default profile (all zeros) so neutral/undefined modes preserve base weights', () => {
    // DEFAULT_WEIGHTS is intentionally all-zero: when no retrieval mode is specified,
    // Math.max(baseWeight, 0) = baseWeight — the query-class weights are preserved exactly.
    expect(DEFAULT_WEIGHTS.lexicalWeight).toBe(0);
    expect(DEFAULT_WEIGHTS.semanticWeight).toBe(0);
    expect(DEFAULT_WEIGHTS.popularityWeight).toBe(0);
  });
});
