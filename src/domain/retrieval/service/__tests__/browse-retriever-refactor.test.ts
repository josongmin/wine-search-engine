import { describe, expect, it, vi } from 'vitest';
import { BrowseRetriever } from '../browse-retriever.js';
import type { SearchIndexPort, SparseHit } from '../../port/search-index.port.js';
import { createEntityId } from '../../../shared/types/entity-id.js';
import type { ConstraintBundle } from '../../../shared/types/index.js';

/**
 * Refactor-invariant regression: after extracting the shared
 * sparse-retrieval-pipeline helpers, BrowseRetriever must still produce the
 * same external observable behavior — same sparseSearch invocation shape
 * (queries, filters, fetchLimit), same candidate count, same retrieval
 * profile, same filter token surface on the trace.
 *
 * These cases mirror inputs from the existing browse-retriever.test.ts but
 * focus on the contract preserved across the helper extraction.
 */

const emptyConstraints: ConstraintBundle = { hard: [], soft: [], inferred: [] };

function makeHit(id: string, rank: number): SparseHit {
  return {
    entityId: createEntityId(id),
    score: 10 - rank,
    rank,
    matchedFields: ['producer'],
    summary: {
      canonicalLabel: `Wine ${id}`,
      producer: 'Test Producer',
      region: 'Napa',
      style: 'bold red',
      priceBand: 'premium',
      wineType: 'red',
    },
  };
}

function makeClient(hits: readonly SparseHit[]): SearchIndexPort {
  return {
    sparseSearch: vi.fn().mockResolvedValue([...hits]),
    denseSearch: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn().mockResolvedValue(null),
    upsertDocument: vi.fn().mockResolvedValue(undefined),
    bulkUpsert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('BrowseRetriever refactor invariants', () => {
  it('producer browse: sparseSearch invocation matches pre-refactor contract', async () => {
    const client = makeClient([makeHit('wine-1', 1)]);
    const retriever = new BrowseRetriever(client);

    await retriever.browseProducer('Opus One', emptyConstraints, 20);

    expect(client.sparseSearch).toHaveBeenCalledWith(
      ['Opus One', 'opus one'],
      undefined,
      160,
    );
  });

  it('producer browse: hard filter tokens flow through to sparseSearch and trace', async () => {
    const client = makeClient([makeHit('wine-1', 1)]);
    const retriever = new BrowseRetriever(client);
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

    expect(client.sparseSearch).toHaveBeenCalledWith(
      ['Opus One', 'opus one'],
      ['wine_type:red'],
      96,
    );
    expect(out[0]?.retrievalTrace.filtersApplied).toEqual(['wine_type:red']);
    expect(out[0]?.matchedConstraints).toContain('wine_type');
  });

  it('region browse: still emits region_browse profile after refactor', async () => {
    const client = makeClient([makeHit('wine-2', 1)]);
    const retriever = new BrowseRetriever(client);

    const out = await retriever.browseRegion('Bordeaux / Médoc', emptyConstraints, 15);

    expect(client.sparseSearch).toHaveBeenCalledWith(
      ['Bordeaux / Médoc', 'Bordeaux', 'Médoc'],
      undefined,
      120,
    );
    expect(out[0]?.retrievalTrace.retrievalProfile).toBe('region_browse');
  });

  it('whitespace-only seed short-circuits without calling sparseSearch', async () => {
    const client = makeClient([]);
    const retriever = new BrowseRetriever(client);

    const out = await retriever.browseProducer('   ', emptyConstraints, 10);

    expect(out).toEqual([]);
    expect(client.sparseSearch).not.toHaveBeenCalled();
  });
});
