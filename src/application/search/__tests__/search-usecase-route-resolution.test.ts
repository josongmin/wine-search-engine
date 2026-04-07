import { describe, it, expect } from 'vitest';
import {
  buildSearchRouteResolutionContext,
  resolveRouteFromPlanAndOptionMode,
} from '../search-usecase-route-resolution.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../domain/query/model/compiled-wine-query.js';
import type { SearchRequest } from '../search-request.dto.js';

/** Minimal V1 plan fixture. */
function makeV1Plan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'red wine',
    normalizedQuery: 'red wine',
    intent: 'search',
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
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 0.9,
      constraintConfidence: 0.9,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

/** Minimal compiled fixture. */
function makeCompiled(effectiveRoute: 'entity' | 'hybrid' | 'mixed' = 'hybrid'): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'red wine',
      normalizedQuery: 'red wine',
      intent: 'search',
      queryClass: 'short_entity',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0.9,
        constraintConfidence: 0.9,
      },
    } as never,
    execution: {
      effectiveRoute,
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: { maxCandidates: 50, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  };
}

/** Minimal search request fixture. */
function makeRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { query: 'red wine', ...overrides };
}

describe('buildSearchRouteResolutionContext – compiled-first path', () => {
  it('uses compiled.execution.effectiveRoute when compiled is provided and no api override', () => {
    const plan = makeV1Plan({ route: 'entity' }); // V1 says entity
    const compiled = makeCompiled('hybrid');       // compiled says hybrid
    const request = makeRequest();

    const ctx = buildSearchRouteResolutionContext(plan, request, compiled);

    // effectiveRoute uses compiled.execution.effectiveRoute (not V1 plan.route)
    expect(ctx.effectiveRoute).toBe('hybrid');
    // plannerSuggestedMode: when compiled is present, returns effectiveRetrievalMode
    expect(ctx.plannerSuggestedMode).toBe('attribute_search');
    expect(ctx.retrievalModeSource).toBe('planner');
    expect(ctx.apiOverrideMode).toBeUndefined();
  });

  it('uses compiled effectiveRoute=entity when compiled suggests entity', () => {
    const plan = makeV1Plan({ route: 'hybrid' }); // V1 says hybrid
    const compiledEntity = makeCompiled('entity'); // compiled says entity
    const request = makeRequest();

    const ctx = buildSearchRouteResolutionContext(plan, request, compiledEntity);

    // effectiveRoute uses compiled.execution.effectiveRoute (not V1 plan.route)
    expect(ctx.effectiveRoute).toBe('entity');
    // plannerSuggestedMode: when compiled is present, returns effectiveRetrievalMode
    expect(ctx.plannerSuggestedMode).toBe('attribute_search');
  });

  it('api override takes precedence over compiled route', () => {
    const plan = makeV1Plan({ route: 'entity' });
    const compiled = makeCompiled('entity');
    const request = makeRequest({ retrieval_mode: 'hybrid' });

    const ctx = buildSearchRouteResolutionContext(plan, request, compiled);

    expect(ctx.effectiveRoute).toBe('hybrid');
    expect(ctx.apiOverrideMode).toBe('hybrid');
    expect(ctx.retrievalModeSource).toBe('api_override');
  });
});

describe('buildSearchRouteResolutionContext – V1 fallback path (no compiled)', () => {
  it('falls back to V1 plan route when compiled is absent', () => {
    const plan = makeV1Plan({ route: 'entity' });
    const request = makeRequest();

    const ctx = buildSearchRouteResolutionContext(plan, request);

    expect(ctx.effectiveRoute).toBe('entity');
    expect(ctx.plannerSuggestedMode).toBe('entity');
    expect(ctx.retrievalModeSource).toBe('planner');
    expect(ctx.apiOverrideMode).toBeUndefined();
  });

  it('falls back to hybrid when V1 plan has a hybrid-forced retrievalMode', () => {
    // compare_candidates triggers the hybrid-forced fallback in V1 path
    const plan = makeV1Plan({ route: 'entity', retrievalMode: 'compare_candidates' });
    const request = makeRequest();

    const ctx = buildSearchRouteResolutionContext(plan, request);

    expect(ctx.effectiveRoute).toBe('hybrid');
    expect(ctx.retrievalModeSource).toBe('planner');
  });

  it('api override takes precedence over V1 plan route when compiled is absent', () => {
    const plan = makeV1Plan({ route: 'entity' });
    const request = makeRequest({ retrieval_mode: 'mixed' });

    const ctx = buildSearchRouteResolutionContext(plan, request);

    expect(ctx.effectiveRoute).toBe('mixed');
    expect(ctx.apiOverrideMode).toBe('mixed');
    expect(ctx.retrievalModeSource).toBe('api_override');
  });
});

describe('resolveRouteFromPlanAndOptionMode', () => {
  it('uses compiled route when mode is auto and compiled is present', () => {
    const plan = makeV1Plan({ route: 'entity' });
    const compiled = makeCompiled('hybrid');

    expect(resolveRouteFromPlanAndOptionMode(plan, 'auto', compiled)).toBe('hybrid');
  });

  it('uses compiled route when mode is undefined and compiled is present', () => {
    const plan = makeV1Plan({ route: 'entity' });
    const compiled = makeCompiled('mixed');

    expect(resolveRouteFromPlanAndOptionMode(plan, undefined, compiled)).toBe('mixed');
  });

  it('returns the explicit mode when mode is not auto/undefined', () => {
    const plan = makeV1Plan({ route: 'entity' });
    const compiled = makeCompiled('hybrid');

    expect(resolveRouteFromPlanAndOptionMode(plan, 'entity', compiled)).toBe('entity');
    expect(resolveRouteFromPlanAndOptionMode(plan, 'mixed', compiled)).toBe('mixed');
  });

  it('falls back to V1 plan route when compiled is absent and mode is auto', () => {
    const plan = makeV1Plan({ route: 'hybrid' });

    expect(resolveRouteFromPlanAndOptionMode(plan, 'auto', undefined)).toBe('hybrid');
  });
});
