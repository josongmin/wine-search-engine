import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpLearnedMatcherAdapter } from '../../../src/infrastructure/adapter/http-learned-matcher.js';
import type { ResolverCandidate } from '../../../src/domain/resolver/model/resolved-candidate.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

function makeCandidate(entityId: string, canonicalLabel: string): ResolverCandidate {
  return {
    entityId: createEntityId(entityId),
    entityType: 'wine',
    canonicalLabel,
    aliasMatches: [],
    sourceSignals: {
      canonicalExactMatch: 0,
      canonicalNormalizedMatch: 0,
      aliasExactMatch: 0,
      aliasFuzzyMatch: 0,
      aliasTypePrior: 0,
      producerMatch: 0,
      vintageMatch: 0,
      regionMatch: 0,
      grapeHintMatch: 0,
      phoneticMatch: 0,
      editDistanceScore: 0,
      ambiguityPenalty: 0,
    },
  };
}

describe('HttpLearnedMatcherAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends noisy lookup context in the match payload when available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            entity_id: 'entity-opus-one',
            match_probability: 0.91,
            model_id: 'matcher',
            model_version: '1.0.0',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpLearnedMatcherAdapter('http://matcher.local');
    const outputs = await adapter.match(
      '오푸스원 18',
      [makeCandidate('entity-opus-one', 'Opus One 2018')],
      {
        queryClass: 'short_entity',
        normalizedQueryViews: {
          raw: '오푸스원 18',
          strict: '오푸스원 18',
          accentless: '오푸스원 18',
          collapsedWhitespace: '오푸스원 18',
          punctuationStripped: '오푸스원 18',
          compact: '오푸스원18',
          phoneticCompact: 'psn18',
          vintageCanonicalized: '오푸스원 2018',
          vintageStripped: '오푸스원',
          transliterated: 'opus one',
          lookupVariants: ['오푸스원 18', 'opus one', 'opusone18'],
        },
        anchorLookupVariants: ['opus one', 'opusone18'],
        anchorLookupStrategies: ['transliterated_exact', 'compact_exact'],
      },
    );

    expect(outputs[0]?.entityId).toBe('entity-opus-one');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual(
      expect.objectContaining({
        query: '오푸스원 18',
        context: expect.objectContaining({
          query_class: 'short_entity',
          anchor_lookup_variants: ['opus one', 'opusone18'],
          anchor_lookup_strategies: ['transliterated_exact', 'compact_exact'],
        }),
      }),
    );
  });
});
