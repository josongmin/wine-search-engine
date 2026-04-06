import { describe, it, expect, vi } from 'vitest';
import { ConstraintSAT } from '../../../../src/domain/query/service/constraint-sat.js';
import { QuerySanitizer } from '../../../../src/domain/security/service/query-sanitizer.js';
import { runSearchPreRoutePhase } from '../../../../src/application/search/search-usecase-pre-route-phase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import type { QueryPlannerPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { ResponseBuilder } from '../../../../src/domain/response/service/response-builder.js';

describe('runSearchPreRoutePhase', () => {
  it('returns continue with plan when pipeline reaches main search', async () => {
    const plan = {
      rawQuery: 'red wine',
      normalizedQuery: 'red wine',
      intent: 'facet_search' as const,
      route: 'hybrid' as const,
      retrievalMode: 'semantic_hybrid' as const,
      queryClass: 'unknown',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {} as QueryPlanV1['policy'],
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    } as QueryPlanV1;

    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn(async () => plan),
    };

    const responseBuilder = { build: vi.fn() } as unknown as ResponseBuilder;

    const request: SearchRequest = { query: 'red wine' };

    const result = await runSearchPreRoutePhase({
      request,
      requestId: 'r1',
      startTime: Date.now(),
      snapshotVersions: undefined,
      securityGateDeps: {
        querySanitizer: new QuerySanitizer(),
      },
      queryPlanner,
      responseBuilder,
      constraintSAT: new ConstraintSAT(),
      cacheService: undefined,
      decomposedSearch: undefined,
    });

    expect(result.outcome).toBe('continue');
    if (result.outcome === 'continue') {
      expect(result.plan).toBe(plan);
    }
    expect(queryPlanner.plan).toHaveBeenCalled();
  });
});
