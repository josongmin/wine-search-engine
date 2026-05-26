import { describe, expect, it } from 'vitest';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import {
  applySearchToolAlcoholResultPolicy,
  applySearchToolBudgetResultPolicy,
} from '../../../../src/application/search/search-tool-result-policy.js';
import { convertKrwToConstraintUsd } from '../../../../src/domain/shared/utils/canonical-price.js';

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

  it('accepts an exact-threshold candidate when numeric priceUsd matches the canonical budget ceiling', () => {
    const response = makeSearchResponse([
      makeResult('wine-threshold', 'Threshold Wine', {
        priceUsd: convertKrwToConstraintUsd(50_000),
        priceRange: '$37.04',
      }),
    ]);

    const filtered = applySearchToolBudgetResultPolicy(
      response,
      { maxKrw: 50_000 },
      { krwPerUsd: 1_350 },
    );

    expect(filtered.mode).toBe('unchanged');
    expect(filtered.response.results.map((result) => result.entity.entityId)).toEqual(['wine-threshold']);
  });

  it('parses USD range strings as explicit budget candidates', () => {
    const response = makeSearchResponse([
      makeResult('wine-range', 'Range Wine', { priceRange: '$20-$30' }),
      makeResult('wine-over', 'Over Range', { priceRange: '$20-$45' }),
    ]);

    const filtered = applySearchToolBudgetResultPolicy(
      response,
      { maxKrw: 50_000 },
      { krwPerUsd: 1_350 },
    );

    expect(filtered.mode).toBe('strict');
    expect(filtered.response.results.map((result) => result.entity.entityId)).toEqual(['wine-range']);
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
