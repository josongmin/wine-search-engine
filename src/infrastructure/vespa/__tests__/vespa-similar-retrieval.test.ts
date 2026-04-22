import { describe, expect, it, vi } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { AnchorProfile } from '../../../domain/mixed/model/anchor-profile.js';
import type { SearchIndexPort } from '../../../domain/retrieval/port/search-index.port.js';
import { VespaSimilarRetrieval } from '../vespa-similar-retrieval.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/index.js';

function makeAnchorProfile(): AnchorProfile {
  return {
    entityId: createEntityId('anchor-similar-test'),
    canonicalLabel: 'Anchor Wine',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    body: 0.8,
    sweetness: 0.1,
    style: 'structured red',
    embedding: [0.1, 0.2, 0.3],
    anchorConfidence: 0.93,
  };
}

describe('VespaSimilarRetrieval', () => {
  it('maps dense-hit summaries through the shared retrieval summary transport', async () => {
    const entityId = createEntityId('similar-summary-test');
    const searchIndex = {
      denseSearch: vi.fn().mockResolvedValue([
        {
          entityId,
          score: 0.98,
          rank: 1,
          similarity: 0.98,
          summary: {
            canonicalLabel: '  Similar Wine  ',
            producer: '  Similar Producer  ',
            producerPrestige: 0.91,
            drinkingWindowModelVersion: '  dw-similar-v4  ',
            searchTextEn: ` ${'S'.repeat(810)} `,
            pairing: ['steak'],
            occasion: ['celebration'],
            certifications: ['organic'],
          },
        },
      ]),
    } as unknown as SearchIndexPort;

    const retrieval = new VespaSimilarRetrieval(searchIndex);
    const [candidate] = await retrieval.retrieveSimilar(makeAnchorProfile(), 5);

    expect(candidate).toMatchObject({
      entityId,
      denseRank: 1,
      canonicalLabel: 'Similar Wine',
      producer: 'Similar Producer',
      producerPrestige: 0.91,
      drinkingWindowModelVersion: 'dw-similar-v4',
      pairing: ['steak'],
      occasion: ['celebration'],
      certifications: ['organic'],
      retrievalTrace: expect.objectContaining({
        retrievalProfile: 'similar_anchor',
        filtersApplied: [],
        candidateSources: ['anchor_similarity'],
      }),
    });
    expect(candidate?.searchTextEn).toBe('S'.repeat(800));
  });

  it('pushes hard constraints down into dense retrieval filters', async () => {
    const searchIndex = {
      denseSearch: vi.fn().mockResolvedValue([]),
    } as unknown as SearchIndexPort;
    const hardConstraints: readonly NormalizedConstraint[] = [
      {
        attribute: 'wine_type',
        operator: '=',
        value: 'white',
        source: 'planner',
        source_tier: 'hard',
      },
    ];

    const retrieval = new VespaSimilarRetrieval(searchIndex);
    await retrieval.retrieveSimilar(makeAnchorProfile(), 7, hardConstraints);

    expect(searchIndex.denseSearch).toHaveBeenCalledWith(
      makeAnchorProfile().embedding,
      ['wine_type:white'],
      7,
    );
  });

  it('records pushed-down filters in retrieval trace', async () => {
    const entityId = createEntityId('similar-filter-trace');
    const searchIndex = {
      denseSearch: vi.fn().mockResolvedValue([
        {
          entityId,
          score: 0.88,
          rank: 1,
          similarity: 0.88,
          summary: {
            canonicalLabel: 'Filtered Similar Wine',
          },
        },
      ]),
    } as unknown as SearchIndexPort;
    const hardConstraints: readonly NormalizedConstraint[] = [
      {
        attribute: 'wine_type',
        operator: '=',
        value: 'white',
        source: 'planner',
        source_tier: 'hard',
      },
    ];

    const retrieval = new VespaSimilarRetrieval(searchIndex);
    const [candidate] = await retrieval.retrieveSimilar(makeAnchorProfile(), 5, hardConstraints);

    expect(candidate?.retrievalTrace.filtersApplied).toEqual(['wine_type:white']);
  });
});
