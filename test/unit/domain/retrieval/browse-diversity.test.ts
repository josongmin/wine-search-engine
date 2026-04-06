import { describe, it, expect } from 'vitest';
import {
  dedupeSparseHitsByEntity,
  diversifyProducerBrowseHits,
  diversifyRegionBrowseHits,
  expandRegionBrowseLexicalQueries,
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

  it('dedupeSparseHitsByEntity keeps best score', () => {
    const a = hit('x', 1, { canonicalLabel: 'Wine' });
    const b = hit('x', 3, { canonicalLabel: 'Wine' });
    expect(dedupeSparseHitsByEntity([a, b])).toEqual([b]);
  });

  it('diversifyProducerBrowseHits keeps one per product line × vintage', () => {
    const h1 = hit('a', 10, {
      canonicalLabel: 'Foo 2018',
      vintageYear: 2018,
    });
    const h2 = hit('b', 9, {
      canonicalLabel: 'Foo 2019',
      vintageYear: 2019,
    });
    const h3 = hit('c', 8, {
      canonicalLabel: 'Foo 2018',
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
    expect(producers.size).toBeGreaterThan(1);
    expect(out.length).toBe(6);
  });
});
