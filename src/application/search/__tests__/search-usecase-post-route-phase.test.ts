import { describe, expect, it, vi } from 'vitest';
import { runSearchPostRoutePhase } from '../search-usecase-post-route-phase.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';

describe('runSearchPostRoutePhase', () => {
  it('stores entropy-abstain responses in the cache', async () => {
    const response: SearchResponseV1 = {
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'ambiguous',
        nextAction: 'clarify',
        route: 'hybrid',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'req-1',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
      },
    };
    const setSearchResponse = vi.fn().mockResolvedValue(true);

    const result = await runSearchPostRoutePhase({
      plan: {
        rawQuery: 'find bordeaux',
        normalizedQuery: 'find bordeaux',
        intent: 'search',
        additionalIntents: [],
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'entity_lookup',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      request: { query: 'find bordeaux' },
      requestId: 'req-1',
      startTime: Date.now(),
      resolveResult: {} as never,
      rankedResults: [],
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: 'hybrid',
      retrievalModeSource: 'planner',
      abstainPolicy: {
        shouldAbstain: vi.fn().mockReturnValue({ abstain: true, entropy: 0.99 }),
      } as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: {
        decide: vi.fn(),
      } as never,
      responseBuilder: {
        build: vi.fn().mockReturnValue(response),
      } as never,
      cacheService: {
        setSearchResponse,
      } as never,
    });

    expect(result).toBe(response);
    expect(setSearchResponse).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedQuery: 'find bordeaux' }),
      {},
      response,
    );
  });
});
