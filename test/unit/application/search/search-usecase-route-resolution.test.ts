import { describe, it, expect } from 'vitest';
import {
  buildSearchRouteResolutionContext,
  resolveRouteFromPlanAndOptionMode,
} from '../../../../src/application/search/search-usecase-route-resolution.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
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

function minimalCompiled(
  effectiveRoute: 'entity' | 'hybrid' | 'mixed',
  effectiveRetrievalMode: CompiledWineQuery['execution']['effectiveRetrievalMode'] = 'attribute_search',
): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'q',
      normalizedQuery: 'q',
      intent: 'search',
      queryClass: 'unknown',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {} as never,
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute,
      effectiveRetrievalMode,
      routeSource: 'planner',
      budget: { maxCandidates: 10, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  };
}

describe('resolveRouteFromPlanAndOptionMode', () => {
  it('forces hybrid for producer_browse when mode is auto', () => {
    const plan = minimalPlan('entity', 'producer_browse');
    expect(resolveRouteFromPlanAndOptionMode(plan, minimalCompiled('hybrid', 'producer_browse'), 'auto')).toBe('hybrid');
  });

  it('returns explicit mode when not auto', () => {
    const plan = minimalPlan('hybrid', 'semantic_hybrid');
    expect(resolveRouteFromPlanAndOptionMode(plan, minimalCompiled('hybrid'), 'entity')).toBe('entity');
  });

  it('returns compiled route when mode is auto and no override exists', () => {
    const plan = minimalPlan('entity', 'semantic_hybrid');
    expect(resolveRouteFromPlanAndOptionMode(plan, minimalCompiled('entity'), undefined)).toBe('entity');
  });
});

describe('buildSearchRouteResolutionContext', () => {
  it('uses top-level retrieval_mode override', () => {
    const plan = minimalPlan('entity', 'semantic_hybrid');
    const compiled = minimalCompiled('entity');
    const request: SearchRequest = {
      query: 'x',
      retrieval_mode: 'mixed',
    };
    const ctx = buildSearchRouteResolutionContext(plan, request, compiled);
    expect(ctx.effectiveRoute).toBe('mixed');
    expect(ctx.retrievalModeSource).toBe('api_override');
    expect(ctx.plannerSuggestedMode).toBe('attribute_search');
    expect(ctx.apiOverrideMode).toBe('mixed');
  });

  it('uses planner retrieval mode when retrieval_mode is auto', () => {
    const plan = minimalPlan('hybrid', 'attribute_search');
    const compiled = minimalCompiled('hybrid', 'attribute_search');
    const request: SearchRequest = {
      query: 'x',
      retrieval_mode: 'auto',
    };
    const ctx = buildSearchRouteResolutionContext(plan, request, compiled);
    expect(ctx.effectiveRoute).toBe('hybrid');
    expect(ctx.retrievalModeSource).toBe('planner');
    expect(ctx.apiOverrideMode).toBeUndefined();
    expect(ctx.plannerSuggestedMode).toBe('attribute_search');
  });

  it('keeps plannerSuggestedMode on retrieval mode even when route and mode differ', () => {
    const plan = minimalPlan('entity', 'semantic_hybrid');
    const compiled = minimalCompiled('entity', 'attribute_search');
    const request: SearchRequest = {
      query: 'x',
    };
    const ctx = buildSearchRouteResolutionContext(plan, request, compiled);
    expect(ctx.effectiveRoute).toBe('entity');
    expect(ctx.plannerSuggestedMode).toBe('attribute_search');
  });
});
