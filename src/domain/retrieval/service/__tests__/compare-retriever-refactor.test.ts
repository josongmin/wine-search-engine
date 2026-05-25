import { describe, expect, it, vi } from 'vitest';
import { CompareRetriever } from '../compare-retriever.js';
import type { SearchIndexPort } from '../../port/search-index.port.js';
import { createEntityId } from '../../../shared/types/index.js';

/**
 * Refactor-invariant regression: after extracting shared sparse-pipeline
 * helpers, CompareRetriever must preserve its outer contract — the anchor
 * exclusion still happens, the candidate slice is bounded by `limit`, the
 * compare_default retrieval profile is still emitted, and hard-filter
 * tokens still appear on the trace.
 */
describe('CompareRetriever refactor invariants', () => {
  it('compareAgainstAnchor preserves anchor exclusion + compare_default profile + filter trace', async () => {
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
            style: 'bold red',
            priceBand: 'premium',
            wineType: 'red',
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
      {
        hard: [
          {
            attribute: 'wine_type',
            operator: '=',
            value: 'red',
            source_phrase: 'red',
            confidence: 1,
          },
        ],
        soft: [],
        inferred: [],
      },
      5,
    );

    // Anchor excluded → only wine-compare survives.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.entityId).toBe('wine-compare');
    // External contract preserved.
    expect(candidates[0]?.retrievalTrace.retrievalProfile).toBe('compare_default');
    expect(candidates[0]?.retrievalTrace.candidateSources).toEqual([
      'sparse_bm25',
      'compare_anchor',
    ]);
    expect(candidates[0]?.retrievalTrace.filtersApplied).toEqual(['wine_type:red']);
    expect(candidates[0]?.matchedConstraints).toContain('wine_type');
  });

  it('returns [] when anchor document is missing (short-circuits before sparseSearch)', async () => {
    const sparseSearch = vi.fn();
    const searchIndex: SearchIndexPort = {
      sparseSearch,
      denseSearch: vi.fn(),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(),
      bulkUpsert: vi.fn(),
    };
    const retriever = new CompareRetriever(searchIndex);

    const out = await retriever.compareAgainstAnchor(
      createEntityId('missing-anchor'),
      { hard: [], soft: [], inferred: [] },
      5,
    );

    expect(out).toEqual([]);
    expect(sparseSearch).not.toHaveBeenCalled();
  });
});
