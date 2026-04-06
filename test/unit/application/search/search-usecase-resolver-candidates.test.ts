import { describe, expect, it, vi } from 'vitest';
import { buildResolverCandidatesFromPlan } from '../../../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: '오푸스원 2018',
    normalizedQuery: '오푸스원 2018',
    normalizedQueryViews: {
      raw: '오푸스원 2018',
      strict: '오푸스원 2018',
      accentless: '오푸스원 2018',
      collapsedWhitespace: '오푸스원 2018',
      punctuationStripped: '오푸스원 2018',
      compact: '오푸스원2018',
      vintageCanonicalized: '오푸스원 2018',
      vintageStripped: '오푸스원',
      lookupVariants: ['오푸스원 2018', 'opus one 2018'],
    },
    intent: 'known_item',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
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
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {},
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: 'test',
    policyRuleVersion: 'test',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

describe('buildResolverCandidatesFromPlan', () => {
  it('hydrates resolver candidates from anchor entity ids and preserves provenance signals', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      entityId: createEntityId('opus-one-2018'),
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });

    const candidates = await buildResolverCandidatesFromPlan(makePlan(), { getDocument });

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
      }),
    ]);
  });
});
