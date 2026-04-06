import { describe, expect, it } from 'vitest';
import {
  anchorPreservationScore,
  browseLineDiversityAtK,
  grapeVarietyAtK,
  prestigeMeanAtK,
  producerVariety,
  setDiversityScore,
  type RankedHit,
} from '../../../scripts/eval/metrics.js';

describe('eval mode metrics helpers', () => {
  it('computes diversity from producer/region metadata instead of a flat placeholder', () => {
    const hits: RankedHit[] = [
      { entity_id: 'a', score: 1, producer: 'P1' },
      { entity_id: 'b', score: 0.9, producer: 'P1' },
      { entity_id: 'c', score: 0.8, producer: 'P2' },
    ];

    expect(setDiversityScore(hits)).toBeCloseTo(1 - (2 / 3), 5);
  });

  it('computes producer variety from distinct producer coverage', () => {
    const hits: RankedHit[] = [
      { entity_id: 'a', score: 1, producer: 'P1' },
      { entity_id: 'b', score: 0.9, producer: 'P1' },
      { entity_id: 'c', score: 0.8, producer: 'P2' },
      { entity_id: 'd', score: 0.7 },
    ];

    expect(producerVariety(hits)).toBeCloseTo(2 / 3, 5);
  });

  it('computes browse line diversity from producer, grape, appellation keys', () => {
    const hits: RankedHit[] = [
      {
        entity_id: 'a',
        score: 1,
        producer: 'P',
        grapes: ['Cabernet'],
        appellation: 'Napa',
      },
      {
        entity_id: 'b',
        score: 0.9,
        producer: 'P',
        grapes: ['Cabernet'],
        appellation: 'Napa',
      },
      {
        entity_id: 'c',
        score: 0.8,
        producer: 'Q',
        grapes: ['Pinot'],
        appellation: 'Sonoma',
      },
    ];
    expect(browseLineDiversityAtK(hits, 10)).toBeCloseTo(2 / 3, 5);
  });

  it('computes grape variety in top-k', () => {
    const hits: RankedHit[] = [
      { entity_id: 'a', score: 1, grapes: ['A'] },
      { entity_id: 'b', score: 0.9, grapes: ['A'] },
      { entity_id: 'c', score: 0.8, grapes: ['B'] },
    ];
    expect(grapeVarietyAtK(hits, 10)).toBeCloseTo(2 / 3, 5);
  });

  it('computes prestige mean at k with missing as zero', () => {
    const hits: RankedHit[] = [
      { entity_id: 'a', score: 1, producer_prestige: 1 },
      { entity_id: 'b', score: 0.9 },
    ];
    expect(prestigeMeanAtK(hits, 4)).toBeCloseTo(0.25, 5);
  });

  it('computes anchor preservation from actual anchor inclusion', () => {
    const hits: RankedHit[] = [
      { entity_id: 'anchor', score: 1 },
      { entity_id: 'other', score: 0.8 },
    ];

    expect(anchorPreservationScore('anchor', hits)).toBe(1);
    expect(anchorPreservationScore('missing', hits)).toBe(0);
  });
});
