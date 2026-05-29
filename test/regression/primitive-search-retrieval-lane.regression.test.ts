/**
 * Regression: T-IR-01 primitive-search retrieval-lane propagation.
 *
 * The path-authoritative `/v1/search/{hybrid,semantic,lexical}` routes set a
 * `retrievalLane` on `SearchRequest`, which `SearchUseCase` forwards into the
 * `RequestExecutionContext`. This test pins the deterministic hop where
 * `buildHybridRetrievalInputForPlan` copies that lane onto the
 * `HybridRetrievalInput` so the candidate pool can gate channels.
 *
 * Invariant under test: the lane survives the plan → retrieval-input
 * translation verbatim, and is OMITTED (not `'hybrid'`-defaulted) when the
 * caller did not set one — so the legacy `/v1/search` monolith and the entity
 * lookup route keep their full channel mix.
 */

import { describe, expect, it } from 'vitest';
import { buildHybridRetrievalInputForPlan } from '../../src/application/search/search-usecase-hybrid-candidates.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { RequestExecutionContext } from '../../src/domain/shared/request-execution-context.js';

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'burgundy pinot noir',
    normalizedQuery: 'burgundy pinot noir',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'known_item',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
  } as QueryPlanV1;
}

function contextWithLane(
  lane: RequestExecutionContext['retrievalLane'],
): RequestExecutionContext {
  return {
    requestId: 'req-lane-test',
    ...(lane !== undefined ? { retrievalLane: lane } : {}),
  };
}

describe('T-IR-01 retrieval-lane propagation into HybridRetrievalInput', () => {
  it('propagates semantic_only verbatim', () => {
    const input = buildHybridRetrievalInputForPlan(
      minimalPlan(),
      'hybrid',
      undefined,
      undefined,
      contextWithLane('semantic_only'),
    );
    expect(input.retrievalLane).toBe('semantic_only');
  });

  it('propagates lexical_only verbatim', () => {
    const input = buildHybridRetrievalInputForPlan(
      minimalPlan(),
      'hybrid',
      undefined,
      undefined,
      contextWithLane('lexical_only'),
    );
    expect(input.retrievalLane).toBe('lexical_only');
  });

  it('propagates explicit hybrid verbatim', () => {
    const input = buildHybridRetrievalInputForPlan(
      minimalPlan(),
      'hybrid',
      undefined,
      undefined,
      contextWithLane('hybrid'),
    );
    expect(input.retrievalLane).toBe('hybrid');
  });

  it('omits retrievalLane when the caller did not set one (legacy monolith path)', () => {
    const input = buildHybridRetrievalInputForPlan(
      minimalPlan(),
      'hybrid',
      undefined,
      undefined,
      contextWithLane(undefined),
    );
    expect(input.retrievalLane).toBeUndefined();
  });

  it('omits retrievalLane when no requestContext is supplied at all', () => {
    const input = buildHybridRetrievalInputForPlan(minimalPlan(), 'hybrid');
    expect(input.retrievalLane).toBeUndefined();
  });
});
