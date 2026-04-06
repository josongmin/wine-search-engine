import { describe, it, expect, vi } from 'vitest';
import { runSearchPostRoutePhase } from '../../../../src/application/search/search-usecase-post-route-phase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
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
}

describe('runSearchPostRoutePhase', () => {
  it('returns entropy abstain response when policy abstains', async () => {
    const built = { queryType: 'search' as const, meta: {} } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1;
    const responseBuilder = { build: vi.fn(() => built) };
    const decisionEngine = { decide: vi.fn() };
    const abstainPolicy = {
      shouldAbstain: vi.fn(() => ({ abstain: true, entropy: 0.95 })),
    };
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const eid = createEntityId();
    const rankedResults = [
      {
        entityId: eid,
        canonicalLabel: 'W',
        finalScore: 0.5,
        rank: 1,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.5,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 1,
          uncertaintyPenalty: 0,
        },
        matchedConstraints: [],
        unmetConstraints: [],
        inferredConstraints: [],
        evidenceItems: [],
      },
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];

    const out = await runSearchPostRoutePhase({
      plan,
      request,
      requestId: 'r1',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        candidates: [],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.5,
          top2CalibratedScore: 0.5,
          calibratedGap: 0,
          decisionConfidenceC: 0.5,
          ambiguityDetected: true,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 2,
      },
      rankedResults,
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: 'hybrid',
      retrievalModeSource: 'planner',
      abstainPolicy: abstainPolicy as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine,
      responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
      cacheService: undefined,
    });

    expect(out).toBe(built);
    expect(responseBuilder.build).toHaveBeenCalledOnce();
    expect(decisionEngine.decide).not.toHaveBeenCalled();
  });
});
