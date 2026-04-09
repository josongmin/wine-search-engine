import { describe, it, expect } from 'vitest';
import { StubDoc2QueryGenerator } from '../stub-doc2query-generator.js';
import type { Doc2QueryInput } from '../../../domain/retrieval/port/doc2query-generator.port.js';

const BASE_INPUT: Doc2QueryInput = {
  canonicalLabel: '2018 Château Margaux',
  producer: 'Château Margaux',
  region: 'France / Bordeaux / Margaux',
  country: 'France',
  grapePrimary: 'Cabernet Sauvignon',
  grapes: ['Cabernet Sauvignon', 'Merlot'],
  body: 0.85,
  tannin: 0.75,
  priceUsd: 1200,
  priceBand: 'luxury',
  vintageYear: 2018,
  alcoholPct: 13.5,
  flavorProfiles: ['black fruit', 'cedar', 'tobacco'],
  pairingTags: ['steak', 'lamb'],
  drinkingWindowStart: 2025,
  drinkingWindowEnd: 2045,
  isTopRated: true,
  koreanAliases: ['샤토 마고', '샤토 마고 2018'],
  numQueries: 5,
};

describe('StubDoc2QueryGenerator', () => {
  const gen = new StubDoc2QueryGenerator();

  it('returns an empty array for an empty canonicalLabel (no I/O)', async () => {
    expect(await gen.generate({ ...BASE_INPUT, canonicalLabel: '' })).toEqual([]);
    expect(await gen.generate({ ...BASE_INPUT, canonicalLabel: '   ' })).toEqual([]);
  });

  it('returns an empty array when numQueries <= 0', async () => {
    expect(await gen.generate({ ...BASE_INPUT, numQueries: 0 })).toEqual([]);
    expect(await gen.generate({ ...BASE_INPUT, numQueries: -1 })).toEqual([]);
  });

  it('produces exactly numQueries synthetic queries from a populated input', async () => {
    const out = await gen.generate({ ...BASE_INPUT, numQueries: 3 });
    expect(out).toHaveLength(3);
    for (const q of out) {
      expect(typeof q).toBe('string');
      expect(q.length).toBeGreaterThan(0);
    }
  });
});
