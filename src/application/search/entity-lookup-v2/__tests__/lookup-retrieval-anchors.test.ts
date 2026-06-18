import { describe, expect, it } from 'vitest';
import { createCanonicalEntityId } from '../../../../domain/shared/types/index.js';
import { buildAnchorsFromRetrievalResult } from '../lookup-retrieval-anchors.js';
import type { LookupRetrievalResult } from '../../../../domain/resolver/v2/lookup-v2-types.js';

describe('buildAnchorsFromRetrievalResult', () => {
  it('projects timed channel hits into alias anchors', () => {
    const entityId = createCanonicalEntityId('wine:opus-one');
    const retrieval: LookupRetrievalResult = {
      candidates: [
        {
          entityId,
          canonicalLabel: 'Opus One',
          entityType: 'wine',
          channelHits: [
            {
              channel: 'exact_alias',
              matchedView: 'opus one',
              matchedAlias: 'opus one',
              channelScore: 1,
              channelRank: 1,
            },
            {
              channel: 'compact_exact',
              matchedView: 'opusone',
              channelScore: 0.9,
              channelRank: 1,
            },
          ],
        },
      ],
      coverage: [],
    };

    const anchors = buildAnchorsFromRetrievalResult({
      rawQuery: 'Opus One',
      normalizedQuery: 'opus one',
      retrieval,
    });

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.candidateEntityIds).toEqual([entityId]);
    expect(anchors[0]?.lookupStrategies).toEqual(
      expect.arrayContaining(['exact', 'compact_exact']),
    );
    expect(anchors[0]?.confidence).toBe(1);
  });
});
