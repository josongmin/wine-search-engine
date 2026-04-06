import { describe, expect, it, vi } from 'vitest';
import { CompareRetriever } from '../../../../src/domain/retrieval/service/compare-retriever.js';
import type { SearchIndexPort } from '../../../../src/domain/retrieval/port/search-index.port.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

describe('CompareRetriever', () => {
  it('hydrates comparison candidates from the anchor document before ranking fallback', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [
        {
          entityId: createEntityId('wine-anchor'),
          score: 9,
          rank: 1,
          matchedFields: ['canonical_label'],
          summary: { canonicalLabel: 'Opus One 2018', producer: 'Opus One' },
        },
        {
          entityId: createEntityId('wine-compare'),
          score: 7,
          rank: 2,
          matchedFields: ['producer'],
          summary: {
            canonicalLabel: 'Ridge Monte Bello 2018',
            producer: 'Ridge',
            region: 'Napa Valley',
            grapePrimary: 'Cabernet Sauvignon',
          },
        },
      ]),
      denseSearch: vi.fn(),
      getDocument: vi.fn(async () => ({
        entityId: createEntityId('wine-anchor'),
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        aliasesIdentitySafe: [],
        aliasesNoisyRecall: [],
        producer: 'Opus One',
        region: 'Napa Valley',
        grapes: ['Cabernet Sauvignon'],
        searchTextKo: '',
        searchTextEn: 'Napa Valley Cabernet Sauvignon',
        semanticSummary: 'Napa Valley Cabernet Sauvignon',
        body: 5,
        sweetness: 1,
        style: 'bold red',
        priceBand: 'premium',
        pairing: [],
        occasion: [],
        availability: true,
        popularityScore: 0.9,
        grapePrimary: 'Cabernet Sauvignon',
        country: 'United States',
        appellation: 'Napa Valley',
      })),
      upsertDocument: vi.fn(),
      bulkUpsert: vi.fn(),
    };
    const retriever = new CompareRetriever(searchIndex);

    const candidates = await retriever.compareAgainstAnchor(
      createEntityId('wine-anchor'),
      { hard: [], soft: [], inferred: [] },
      5,
    );

    expect(searchIndex.getDocument).toHaveBeenCalledWith('wine-anchor');
    expect(searchIndex.sparseSearch).toHaveBeenCalled();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({
      entityId: 'wine-compare',
      canonicalLabel: 'Ridge Monte Bello 2018',
    }));
    expect(candidates[0]?.retrievalTrace.retrievalProfile).toBe('compare_candidates');
    expect(candidates[0]?.retrievalTrace.candidateSources).toEqual(['sparse', 'anchor']);
  });
});
