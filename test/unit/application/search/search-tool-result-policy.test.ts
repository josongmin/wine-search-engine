import { describe, expect, it } from 'vitest';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import {
  applySearchToolAlcoholResultPolicy,
  applySearchToolBudgetResultPolicy,
  applySearchToolNegationResultPolicy,
} from '../../../../src/application/search/search-tool-result-policy.js';

function makeResult(
  entityId: string,
  canonicalLabel: string,
  overrides?: Partial<SearchResponseV1['results'][number]['entity']>,
): SearchResponseV1['results'][number] {
  return {
    entity: {
      entityId,
      canonicalLabel,
      type: 'wine',
      ...overrides,
    },
    relevanceScore: 0.9,
    match: {
      matchType: 'hybrid',
      scoreComponents: {
        lexical: 0.8,
        semantic: 0.9,
        attribute: 0.7,
        popularity: 0.6,
        preferenceAlignment: 0.5,
      },
    },
    constraints: { matched: [], unmet: [], inferred: [] },
    uncertainty: {
      uncertaintyConfidence: 0.8,
      missingInfo: [],
      approximationUsed: false,
    },
    evidenceItems: [],
  };
}

function makeSearchResponse(results?: SearchResponseV1['results']): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-search-tool-policy',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    results: results ?? [
      makeResult('wine-unknown', 'Unknown First'),
      makeResult('wine-verified', 'Verified Second', { alcoholPct: 11.5 }),
      makeResult('wine-filtered', 'Filtered Third', { alcoholPct: 14 }),
    ],
    meta: {
      requestId: 'req-search-tool-policy',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

describe('applySearchToolNegationResultPolicy', () => {
  it('fails closed with an empty result set when explicit negation removes every candidate', () => {
    const response = makeSearchResponse([
      makeResult('wine-merlot-1', 'Merlot One', { grapes: ['Merlot'] }),
      makeResult('wine-merlot-2', 'Merlot Two', { grapes: ['Merlot'] }),
    ]);

    const filtered = applySearchToolNegationResultPolicy(response, ['merlot']);

    expect(filtered.filteredCount).toBe(2);
    expect(filtered.response.results).toEqual([]);
  });
});

describe('applySearchToolBudgetResultPolicy', () => {
  it('treats missing and malformed prices as equally ineligible under an explicit budget', () => {
    const response = makeSearchResponse([
      makeResult('wine-missing', 'Missing Price'),
      makeResult('wine-malformed', 'Malformed Price', { priceRange: 'POA' }),
      makeResult('wine-over', 'Over Budget', { priceRange: '100000원' }),
    ]);

    const filtered = applySearchToolBudgetResultPolicy(
      response,
      { maxKrw: 50_000 },
      { krwPerUsd: 1_400 },
    );

    expect(filtered.mode).toBe('strict');
    expect(filtered.response.results).toEqual([]);
  });

  it('does not relax unknown-price candidates back into an explicit budget result set', () => {
    const response = makeSearchResponse([
      makeResult('wine-unknown', 'Unknown Price'),
      makeResult('wine-over', 'Over Budget', { priceRange: '$120' }),
    ]);

    const filtered = applySearchToolBudgetResultPolicy(
      response,
      { maxKrw: 50_000 },
      { krwPerUsd: 1_400 },
    );

    expect(filtered.mode).toBe('strict');
    expect(filtered.response.results).toEqual([]);
  });
});

describe('applySearchToolAlcoholResultPolicy', () => {
  it('preserves original relevance order while removing only verified wines above the ceiling', () => {
    const response = makeSearchResponse();

    const filtered = applySearchToolAlcoholResultPolicy(response, 12);

    expect(filtered.filteredCount).toBe(1);
    expect(filtered.unknownCount).toBe(1);
    expect(filtered.response.results.map((result) => result.entity.canonicalLabel)).toEqual([
      'Unknown First',
      'Verified Second',
    ]);
  });
});
