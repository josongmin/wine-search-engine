import { describe, it, expect, vi } from 'vitest';
import { BrowseRetriever } from '../../../../src/domain/retrieval/service/browse-retriever.js';
import type { SearchIndexPort } from '../../../../src/domain/retrieval/port/search-index.port.js';
import type { SparseHit } from '../../../../src/domain/retrieval/port/search-index.port.js';
import { createEntityId } from '../../../../src/domain/shared/types/entity-id.js';
import type { ConstraintBundle } from '../../../../src/domain/shared/types/index.js';

const emptyConstraints: ConstraintBundle = { hard: [], soft: [], inferred: [] };

function makeSparseHit(entityId: string, rank: number): SparseHit {
  return {
    entityId: createEntityId(entityId),
    score: 10 - rank,
    rank,
    matchedFields: ['producer'],
    summary: {
      canonicalLabel: 'Test Wine',
      producer: 'Test Producer',
      region: 'Napa',
      style: 'bold red',
      priceBand: 'premium',
      wineType: 'red',
    },
  };
}

function makeSearchIndex(sparseHits: readonly SparseHit[]): SearchIndexPort {
  return {
    sparseSearch: vi.fn().mockResolvedValue([...sparseHits]),
    denseSearch: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn().mockResolvedValue(null),
    upsertDocument: vi.fn().mockResolvedValue(undefined),
    bulkUpsert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('BrowseRetriever', () => {
  it('browseProducer delegates to sparseSearch and maps HybridCandidate traces', async () => {
    const hits = [makeSparseHit('wine-1', 1)];
    const searchIndex = makeSearchIndex(hits);
    const retriever = new BrowseRetriever(searchIndex);

    const out = await retriever.browseProducer('Opus One', emptyConstraints, 20);

    expect(searchIndex.sparseSearch).toHaveBeenCalledWith(
      ['Opus One', 'opus one'],
      undefined,
      160,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.entityId).toBe(createEntityId('wine-1'));
    expect(out[0]?.retrievalTrace.retrievalProfile).toBe('producer_browse');
    expect(out[0]?.retrievalTrace.candidateSources).toEqual(['sparse']);
  });

  it('browseRegion uses region_browse profile', async () => {
    const hits = [makeSparseHit('wine-2', 1)];
    const searchIndex = makeSearchIndex(hits);
    const retriever = new BrowseRetriever(searchIndex);

    const out = await retriever.browseRegion('Bordeaux / Médoc', emptyConstraints, 15);

    expect(searchIndex.sparseSearch).toHaveBeenCalledWith(
      ['Bordeaux / Médoc', 'Bordeaux', 'Médoc'],
      undefined,
      120,
    );
    expect(out[0]?.retrievalTrace.retrievalProfile).toBe('region_browse');
  });

  it('returns empty when seed string is whitespace-only', async () => {
    const searchIndex = makeSearchIndex([]);
    const retriever = new BrowseRetriever(searchIndex);

    const out = await retriever.browseProducer('   ', emptyConstraints, 10);

    expect(out).toEqual([]);
    expect(searchIndex.sparseSearch).not.toHaveBeenCalled();
  });

  it('passes mapped hard constraints as sparse filter tokens', async () => {
    const hits = [makeSparseHit('wine-1', 1)];
    const searchIndex = makeSearchIndex(hits);
    const retriever = new BrowseRetriever(searchIndex);
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 0.9,
        },
      ],
      soft: [],
      inferred: [],
    };

    const out = await retriever.browseProducer('Opus One', constraints, 12);

    expect(searchIndex.sparseSearch).toHaveBeenCalledWith(
      ['Opus One', 'opus one'],
      ['wine_type:red'],
      96,
    );
    expect(out[0]?.retrievalTrace.filtersApplied).toEqual(['wine_type:red']);
    expect(out[0]?.matchedConstraints).toContain('wine_type');
  });
});
