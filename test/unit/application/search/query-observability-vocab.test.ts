import { describe, expect, it } from 'vitest';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import {
  deriveQueryFamily,
  planToObservabilitySlice,
} from '../../../../src/domain/query/model/query-observability-vocab.js';

function makePlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'red wine under $30',
    normalizedQuery: 'red wine under $30',
    intent: 'facet_search',
    route: 'entity',
    retrievalMode: 'attribute_search',
    queryClass: 'unknown',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false, clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.2,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 0.2,
      constraintConfidence: 0.8,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

function makeCompiled(overrides: Partial<CompiledWineQuery> = {}): CompiledWineQuery {
  const query = makePlan();

  return {
    query: {
      rawQuery: query.rawQuery,
      normalizedQuery: query.normalizedQuery,
      intent: query.intent,
      queryClass: query.queryClass,
      anchors: query.anchors,
      constraints: query.constraints,
      expansions: query.expansions,
      uncertainty: query.uncertainty,
      plannerVersion: query.plannerVersion,
      policyRuleVersion: query.policyRuleVersion,
      thresholdProfileId: query.thresholdProfileId,
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'compare_candidates',
      routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
    ...overrides,
  };
}

describe('query-observability-vocab', () => {
  it('prefers compiled execution route/mode when compiled is available', () => {
    const plan = makePlan({ route: 'entity', retrievalMode: 'attribute_search' });
    const compiled = makeCompiled({
      execution: {
        effectiveRoute: 'mixed',
        effectiveRetrievalMode: 'recommendation',
        routeSource: 'planner',
        budget: { maxCandidates: 20, enablePrecisionRerank: true },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    });

    const slice = planToObservabilitySlice('req-1', plan, compiled);

    expect(slice.suggestedRoute).toBe('mixed');
    expect(slice.suggestedRetrievalMode).toBe('recommendation');
    expect(slice.queryFamily).toBe('recommendation');
    expect(deriveQueryFamily(plan, compiled)).toBe('recommendation');
  });

  it('falls back to the V1 plan when compiled is absent', () => {
    const plan = makePlan({ route: 'entity', retrievalMode: 'attribute_search' });

    const slice = planToObservabilitySlice('req-2', plan);

    expect(slice.suggestedRoute).toBe('entity');
    expect(slice.suggestedRetrievalMode).toBe('attribute_search');
    expect(slice.queryFamily).toBe('attribute_constrained');
    expect(deriveQueryFamily(plan)).toBe('attribute_constrained');
  });

  it('uses compiled.query.constraintExtraction for V1 plan + compiled (pre-route shape)', () => {
    const extraction = {
      candidatePhraseCount: 11,
      ruleTableHitCount: 0,
      llmHitCount: 2,
      llmSkippedCount: 0,
      fallbackTriggered: false,
      source: 'hybrid' as const,
      llmLatencyMs: 40,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const plan = makePlan();
    const base = makeCompiled();
    const compiled = makeCompiled({
      query: { ...base.query, constraintExtraction: extraction },
    });
    const slice = planToObservabilitySlice('req-ce-v1', plan, compiled);
    expect(slice.constraintExtraction).toEqual(extraction);
  });
});
