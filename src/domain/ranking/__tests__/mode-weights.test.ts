import { describe, expect, it } from 'vitest';
import { getModeWeights, DEFAULT_WEIGHTS } from '../model/mode-weights.js';

describe('getModeWeights', () => {
  it('returns a profile for every retrieval mode key', () => {
    const entityLookup = getModeWeights('entity_lookup');
    expect(entityLookup.lexicalWeight).toBeGreaterThan(0);
    expect(entityLookup.semanticWeight).toBeGreaterThan(0);
  });

  it('exposes a stable default hybrid profile', () => {
    expect(DEFAULT_WEIGHTS.lexicalWeight + DEFAULT_WEIGHTS.semanticWeight).toBeGreaterThan(0);
  });
});
