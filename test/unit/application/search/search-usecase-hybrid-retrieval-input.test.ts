import { describe, expect, it } from 'vitest';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import {
  buildStructuredQueryExpansions,
  retrievalValueToPhrases,
  shouldRunTypedRecommendationDiscovery,
} from '../../../../src/application/search/search-usecase-hybrid-retrieval-input.js';
import { buildRetrievalPlan } from '../../../../src/domain/retrieval/service/retrieval-plan-builder.js';

function makePlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'gift wine',
    normalizedQuery: 'gift wine',
    intent: 'search',
    additionalIntents: [],
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      terms: [],
      confidence: 0,
      overall: 0,
      ambiguityDetected: false,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

describe('search-usecase-hybrid-retrieval-input soft-intent strategy', () => {
  it('expands gift suitability into lexical/semantic retrieval phrases', () => {
    expect(retrievalValueToPhrases('gift_suitability', 0.8)).toEqual([
      'gift wine',
      'giftable wine',
      'presentable bottle',
    ]);
  });

  it('expands price_band synonyms into bounded retrieval phrases', () => {
    expect(retrievalValueToPhrases('price_band', 'budget')).toEqual([
      'value wine',
      'affordable wine',
      'budget friendly wine',
    ]);
  });

  it('keeps drinking_window out of retrieval expansion', () => {
    expect(retrievalValueToPhrases('drinking_window', 'now')).toEqual([]);
  });

  it('does not lexicalize numeric range constraints into bare number phrases', () => {
    expect(
      retrievalValueToPhrases('price_usd', { min: 20, max: 50 }, undefined, 'range'),
    ).toEqual([]);
    expect(
      retrievalValueToPhrases('vintage_year', 2018, undefined, '>='),
    ).toEqual([]);
  });

  it('runs typed recommendation discovery for beginner-suitability soft intent without explicit wine type', () => {
    const plan = makePlan({
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'beginner_suitability',
            operator: '>=',
            value: 0.7,
            source_phrase: '입문자',
            confidence: 0.9,
            mapping_version: 'rule-based-v1.0',
          },
        ],
        inferred: [],
      },
    });

    expect(shouldRunTypedRecommendationDiscovery(plan)).toBe(true);
  });

  it('does not run typed recommendation discovery when explicit wine type already fixes the branch space', () => {
    const plan = makePlan({
      constraints: {
        hard: [
          {
            attribute: 'wine_type',
            operator: '=',
            value: 'red',
            source_phrase: 'red',
            confidence: 1,
            mapping_version: 'rule-based-v1.0',
          },
        ],
        soft: [
          {
            attribute: 'gift_suitability',
            operator: '>=',
            value: 0.8,
            source_phrase: 'gift',
            confidence: 0.9,
            mapping_version: 'rule-based-v1.0',
          },
        ],
        inferred: [],
      },
    });

    expect(shouldRunTypedRecommendationDiscovery(plan)).toBe(false);
  });

  it('adds suitability and price-band expansions into structured query expansion output', () => {
    const plan = makePlan({
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'gift_suitability',
            operator: '>=',
            value: 0.8,
            source_phrase: 'gift',
            confidence: 0.9,
            mapping_version: 'rule-based-v1.0',
          },
          {
            attribute: 'price_band',
            operator: '=',
            value: 'budget',
            source_phrase: 'budget',
            confidence: 0.9,
            mapping_version: 'rule-based-v1.0',
          },
        ],
        inferred: [],
      },
    });

    const expansions = buildStructuredQueryExpansions(plan, buildRetrievalPlan(plan.constraints));
    expect(expansions.lexical).toEqual(expect.arrayContaining([
      'gift wine',
      'affordable wine',
    ]));
    expect(expansions.semantic).toContain('gift wine');
    expect(expansions.semantic).not.toContain('affordable wine');
  });
});
