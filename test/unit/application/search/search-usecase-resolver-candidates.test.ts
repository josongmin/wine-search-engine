import { describe, expect, it, vi } from 'vitest';
import { buildResolverCandidatesFromGenerator } from '../../../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { EntityCandidateGeneratorInput } from '../../../../src/domain/resolver/model/entity-candidate-generator-input.js';

function makeGeneratorInput(): EntityCandidateGeneratorInput {
  return {
    rawQuery: '오푸스원 2018',
    normalizedQuery: '오푸스원 2018',
    anchors: [
      {
        surfaceForm: '오푸스원',
        normalizedForm: '오푸스원',
        candidateEntityIds: [createEntityId('opus-one-2018')],
        lookupStrategies: ['transliterated_exact'],
        confidence: 0.97,
        source: 'alias',
      },
    ],
  };
}

describe('buildResolverCandidatesFromGenerator', () => {
  it('hydrates resolver candidates from anchor entity ids and preserves provenance signals', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      entityId: createEntityId('opus-one-2018'),
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });

    const candidates = await buildResolverCandidatesFromGenerator(makeGeneratorInput(), { getDocument });

    expect(getDocument).toHaveBeenCalledWith(createEntityId('opus-one-2018'));
    expect(candidates).toEqual([
      expect.objectContaining({
        entityId: createEntityId('opus-one-2018'),
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        aliasMatches: [
          expect.objectContaining({
            aliasValue: '오푸스원',
            aliasType: 'translation',
            matchScore: 0.97,
          }),
        ],
        sourceSignals: expect.objectContaining({
          canonicalNormalizedMatch: 0.97,
          aliasExactMatch: 0.97,
          aliasFuzzyMatch: 0,
        }),
        source: 'alias',
        sources: ['alias'],
      }),
    ]);
  });

  it('merges mixed-source support for the same entity without losing provenance', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      entityId: createEntityId('opus-one-2018'),
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오푸스원 opus one',
        normalizedQuery: '오푸스원 opus one',
        anchors: [
          {
            ...makeGeneratorInput().anchors[0]!,
            source: 'alias',
          },
          {
            surfaceForm: 'opus one',
            normalizedForm: 'opus one',
            candidateEntityIds: [createEntityId('opus-one-2018')],
            lookupStrategies: ['fuzzy_char_ngram'],
            confidence: 0.7,
            source: 'planner_heuristic',
          },
        ],
      },
      { getDocument },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        source: undefined,
        sources: ['alias', 'planner_heuristic'],
      }),
    );
    expect(candidates[0]?.aliasMatches).toHaveLength(2);
  });
});
