import { describe, expect, it } from 'vitest';
import {
  buildConstraintContradictionResponseParams,
  buildEntropyAbstainResponseParams,
} from '../../../../src/application/search/search-usecase-execute-builders.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { DecisionSnapshot } from '../../../../src/domain/shared/types/index.js';

function makePlan(): QueryPlanV1 {
  return {
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
    retrievalMode: 'attribute_search',
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    plannerVersion: '1.0.0',
  } as QueryPlanV1;
}

function makeCompiled(): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'find bordeaux',
      normalizedQuery: 'find bordeaux',
      intent: 'semantic_discovery',
      queryClass: 'short_entity',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {} as never,
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
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
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  } as CompiledWineQuery;
}

function makeSnapshot(): DecisionSnapshot {
  return {
    snapshot_id: 'snapshot-1',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'v1',
  };
}

describe('search-usecase-execute-builders synthetic decision traces', () => {
  it('keeps calibratedGap undefined for constraint contradiction failures', () => {
    const params = buildConstraintContradictionResponseParams({
      plan: makePlan(),
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-1',
      startTime: Date.now(),
      conflictDesc: 'producer=foo AND producer=bar',
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
    });

    expect(params.decisionOutput.decisionTrace.signals.calibratedGap).toBeUndefined();
  });

  it('keeps calibratedGap undefined for entropy abstain clarify responses', () => {
    const params = buildEntropyAbstainResponseParams({
      plan: makePlan(),
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-2',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'low_confidence',
        detail: 'entropy=0.99',
        recoverableBy: 'clarify',
        entropy: 0.99,
      },
      entropy: 0.99,
      results: [],
      rankedResults: [],
    });

    expect(params.decisionOutput.decisionTrace.signals.calibratedGap).toBeUndefined();
  });
});
