import { describe, it, expect } from 'vitest';
import {
  dedupeSparseHitsByEntity,
  diversifyProducerBrowseHits,
  diversifyRegionBrowseHits,
  expandProducerBrowseLexicalQueries,
  expandRegionBrowseLexicalQueries,
  producerBrowseRankScore,
  stripVintageFromLabel,
} from '../../../../src/domain/retrieval/service/browse-diversity.js';
import type { SparseHit } from '../../../../src/domain/retrieval/port/search-index.port.js';
import { createEntityId } from '../../../../src/domain/shared/types/entity-id.js';

function hit(
  id: string,
  score: number,
  summary: NonNullable<SparseHit['summary']>,
): SparseHit {
  return {
    entityId: createEntityId(id),
    score,
    rank: 1,
    matchedFields: [],
    summary,
  };
}

describe('browse diversity helpers', () => {
  it('stripVintageFromLabel removes 4-digit years', () => {
    expect(stripVintageFromLabel('Opus One 2018')).toBe('Opus One');
  });

  it('expandRegionBrowseLexicalQueries includes path and segments', () => {
    expect(expandRegionBrowseLexicalQueries('A / B / C')).toEqual(['A / B / C', 'A', 'B', 'C']);
  });

  it('expandProducerBrowseLexicalQueries adds lowercase variant', () => {
    expect(expandProducerBrowseLexicalQueries('Opus One')).toEqual(['Opus One', 'opus one']);
  });

  it('producerBrowseRankScore lifts when prestige is present', () => {
    const low = hit('a', 10, { canonicalLabel: 'X', producerPrestige: 0 });
    const high = hit('b', 10, { canonicalLabel: 'Y', producerPrestige: 80 });
    expect(producerBrowseRankScore(high)).toBeGreaterThan(producerBrowseRankScore(low));
  });

  it('dedupeSparseHitsByEntity keeps best score', () => {
    const a = hit('x', 1, { canonicalLabel: 'Wine' });
    const b = hit('x', 3, { canonicalLabel: 'Wine' });
    expect(dedupeSparseHitsByEntity([a, b])).toEqual([b]);
  });

  it('diversifyProducerBrowseHits keeps one per product line × vintage', () => {
    const h1 = hit('a', 10, {
      canonicalLabel: 'Foo 2018',
      producer: 'P',
      grapePrimary: 'Cabernet',
      appellation: 'Napa',
      vintageYear: 2018,
    });
    const h2 = hit('b', 9, {
      canonicalLabel: 'Foo 2019',
      producer: 'P',
      grapePrimary: 'Cabernet',
      appellation: 'Napa',
      vintageYear: 2019,
    });
    const h3 = hit('c', 8, {
      canonicalLabel: 'Foo 2018',
      producer: 'P',
      grapePrimary: 'Cabernet',
      appellation: 'Napa',
      vintageYear: 2018,
    });
    const out = diversifyProducerBrowseHits([h1, h2, h3], 2);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.entityId)).toContain(createEntityId('a'));
    expect(out.map((h) => h.entityId)).toContain(createEntityId('b'));
  });

  it('diversifyRegionBrowseHits spreads producers', () => {
    const rows: SparseHit[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(
        hit(`w${i}`, 10 - i * 0.1, {
          canonicalLabel: `Wine ${i}`,
          producer: i < 5 ? 'P1' : 'P2',
          criticScoreNormalized: 80,
        }),
      );
    }
    const out = diversifyRegionBrowseHits(rows, 6);
    const producers = new Set(out.map((h) => h.summary?.producer));
    // Setup has exactly 2 producers (P1 and P2), both should appear in the output
    expect(producers.size).toBe(2);
    expect(out.length).toBe(6);
  });

  it('diversifyRegionBrowseHits with single producer returns up to limit', () => {
    // All 10 candidates from the same producer — result is limited but not diverse
    const rows: SparseHit[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(
        hit(`w${i}`, 10 - i * 0.1, {
          canonicalLabel: `Wine ${i}`,
          producer: 'OnlyProducer',
          criticScoreNormalized: 80,
        }),
      );
    }
    const out = diversifyRegionBrowseHits(rows, 6);
    // Output is capped at limit
    expect(out.length).toBe(6);
    // All are from the single producer — diversity is impossible
    const producers = new Set(out.map((h) => h.summary?.producer));
    expect(producers.size).toBe(1);
    expect([...producers][0]).toBe('OnlyProducer');
  });
});
