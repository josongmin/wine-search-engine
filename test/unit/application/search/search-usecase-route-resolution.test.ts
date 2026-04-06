import { describe, it, expect } from 'vitest';
import {
  buildSearchRouteResolutionContext,
  resolveRouteFromPlanAndOptionMode,
} from '../../../../src/application/search/search-usecase-route-resolution.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';

function minimalPlan(
  route: QueryPlanV1['route'],
  retrievalMode: QueryPlanV1['retrievalMode'],
): QueryPlanV1 {
  return {
    route,
    retrievalMode,
  } as QueryPlanV1;
}

describe('resolveRouteFromPlanAndOptionMode', () => {
  it('forces hybrid for producer_browse when mode is auto', () => {
    const plan = minimalPlan('entity', 'producer_browse');
    expect(resolveRouteFromPlanAndOptionMode(plan, 'auto')).toBe('hybrid');
  });

  it('returns explicit mode when not auto', () => {
    const plan = minimalPlan('hybrid', 'semantic_hybrid');
    expect(resolveRouteFromPlanAndOptionMode(plan, 'entity')).toBe('entity');
  });

  it('returns plan.route when mode is auto and not specialized browse', () => {
    const plan = minimalPlan('entity', 'semantic_hybrid');
    expect(resolveRouteFromPlanAndOptionMode(plan, undefined)).toBe('entity');
  });
});

describe('buildSearchRouteResolutionContext', () => {
  it('uses top-level retrieval_mode override', () => {
    const plan = minimalPlan('entity', 'semantic_hybrid');
    const request: SearchRequest = {
      query: 'x',
      retrieval_mode: 'mixed',
    };
    const ctx = buildSearchRouteResolutionContext(plan, request);
    expect(ctx.effectiveRoute).toBe('mixed');
    expect(ctx.retrievalModeSource).toBe('api_override');
    expect(ctx.plannerSuggestedMode).toBe('entity');
    expect(ctx.apiOverrideMode).toBe('mixed');
  });

  it('uses planner when retrieval_mode is auto', () => {
    const plan = minimalPlan('hybrid', 'semantic_hybrid');
    const request: SearchRequest = {
      query: 'x',
      retrieval_mode: 'auto',
    };
    const ctx = buildSearchRouteResolutionContext(plan, request);
    expect(ctx.effectiveRoute).toBe('hybrid');
    expect(ctx.retrievalModeSource).toBe('planner');
    expect(ctx.apiOverrideMode).toBeUndefined();
  });
});
