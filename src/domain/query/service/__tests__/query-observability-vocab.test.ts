import { describe, it, expect } from 'vitest';
import {
  planToObservabilitySlice,
  isQueryPlanV2,
  QUERY_FAMILY_LABELS,
} from '../../model/query-observability-vocab.js';
import type { CompiledWineQuery } from '../../model/compiled-wine-query.js';
import type { QueryPlanV1, QueryPlanV2 } from '../../model/query-plan.js';

// ---------------------------------------------------------------------------
// Minimal fixture factory
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<QueryPlanV2> = {}): QueryPlanV2 {
  return {
    rawQuery: 'test wine query',
    normalizedQuery: 'test wine query',
    intent: 'entity_exact',
    suggestedRoute: 'entity',
    suggestedRetrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: true,
      allowApproximate: false,
      requireClarification: false,
      fallbackMode: 'hybrid',
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
    plannerVersion: '2.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('planToObservabilitySlice', () => {
  it('builds a slice with expected fields', () => {
    const plan = makePlan();
    const slice = planToObservabilitySlice('req-123', plan);

    expect(slice.queryId).toBe('req-123');
    expect(slice.rawQuery).toBe('test wine query');
    expect(slice.intent).toBe('entity_exact');
    expect(slice.queryClass).toBe('short_entity');
    expect(slice.suggestedRetrievalMode).toBe('entity_lookup');
    expect(slice.suggestedRoute).toBe('entity');
    expect(slice.anchorCount).toBe(0);
    expect(slice.hardConstraintCount).toBe(0);
    expect(slice.softConstraintCount).toBe(0);
    expect(slice.overallUncertainty).toBe(0.1);
    expect(slice.ambiguityDetected).toBe(false);
    expect(slice.plannerVersion).toBe('2.0.0');
    expect(slice.policyRuleVersion).toBe('1.0.0');
    expect(slice.thresholdProfileId).toBe('default');
  });

  it('uses plan.constraintExtraction on QueryPlanV2 when the 4th argument is omitted', () => {
    const extraction = {
      candidatePhraseCount: 5,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: true,
      source: 'fallback' as const,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const plan = makePlan({ constraintExtraction: extraction });
    const slice = planToObservabilitySlice('req-ce-1', plan);
    expect(slice.constraintExtraction).toEqual(extraction);
  });

  it('4th argument overrides plan.constraintExtraction when both are present', () => {
    const fromPlan = {
      candidatePhraseCount: 1,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: true,
      source: 'fallback' as const,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const override = { ...fromPlan, candidatePhraseCount: 99 };
    const plan = makePlan({ constraintExtraction: fromPlan });
    const slice = planToObservabilitySlice('req-ce-2', plan, undefined, override);
    expect(slice.constraintExtraction?.candidatePhraseCount).toBe(99);
  });

  it('uses compiled.query.constraintExtraction when plan is V1 (search / interpret path)', () => {
    const extraction = {
      candidatePhraseCount: 7,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: true,
      source: 'fallback' as const,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const plan: QueryPlanV1 = {
      rawQuery: 'x',
      normalizedQuery: 'x',
      intent: 'facet_search',
      route: 'hybrid',
      retrievalMode: 'attribute_search',
      queryClass: 'pure_constraint',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'hybrid',
        policyReasonCodes: [],
      },
      uncertainty: {
        overall: 0.2,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.8,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
    };
    const compiled: CompiledWineQuery = {
      query: {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        intent: plan.intent,
        queryClass: plan.queryClass,
        anchors: plan.anchors,
        constraints: plan.constraints,
        expansions: plan.expansions,
        uncertainty: plan.uncertainty,
        plannerVersion: plan.plannerVersion,
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
        constraintExtraction: extraction,
      },
      execution: {
        effectiveRoute: 'hybrid',
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
    const slice = planToObservabilitySlice('req-v1-compiled-ce', plan, compiled);
    expect(slice.constraintExtraction).toEqual(extraction);
  });

  it('falls back to compiled.query.constraintExtraction when V2 plan omits it', () => {
    const extraction = {
      candidatePhraseCount: 3,
      ruleTableHitCount: 1,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: false,
      source: 'rule_only' as const,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const plan = makePlan();
    const compiled: CompiledWineQuery = {
      query: {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        intent: plan.intent,
        queryClass: plan.queryClass,
        anchors: plan.anchors,
        constraints: plan.constraints,
        expansions: plan.expansions,
        uncertainty: plan.uncertainty,
        plannerVersion: plan.plannerVersion,
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
        constraintExtraction: extraction,
      },
      execution: {
        effectiveRoute: 'entity',
        effectiveRetrievalMode: 'entity_lookup',
        routeSource: 'planner',
        budget: { maxCandidates: 10, enablePrecisionRerank: false },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    };
    const slice = planToObservabilitySlice('req-v2-compiled-ce', plan, compiled);
    expect(slice.constraintExtraction).toEqual(extraction);
  });

  it('prefers plan.constraintExtraction over compiled.query when both are set (V2)', () => {
    const fromCompiled = {
      candidatePhraseCount: 1,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: true,
      source: 'fallback' as const,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const fromPlan = { ...fromCompiled, candidatePhraseCount: 42 };
    const plan = makePlan({ constraintExtraction: fromPlan });
    const compiled: CompiledWineQuery = {
      query: {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        intent: plan.intent,
        queryClass: plan.queryClass,
        anchors: plan.anchors,
        constraints: plan.constraints,
        expansions: plan.expansions,
        uncertainty: plan.uncertainty,
        plannerVersion: plan.plannerVersion,
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
        constraintExtraction: fromCompiled,
      },
      execution: {
        effectiveRoute: 'entity',
        effectiveRetrievalMode: 'entity_lookup',
        routeSource: 'planner',
        budget: { maxCandidates: 10, enablePrecisionRerank: false },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    };
    const slice = planToObservabilitySlice('req-v2-priority', plan, compiled);
    expect(slice.constraintExtraction?.candidatePhraseCount).toBe(42);
  });

  it('derives queryFamily entity_exact for entity_exact intent', () => {
    const plan = makePlan({ intent: 'entity_exact', suggestedRetrievalMode: 'entity_lookup' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('entity_exact');
  });

  it('derives queryFamily entity_fuzzy for entity_fuzzy intent', () => {
    const plan = makePlan({ intent: 'entity_fuzzy', suggestedRetrievalMode: 'entity_resolution' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('entity_fuzzy');
  });

  it('derives queryFamily no_match for no_match_detection mode', () => {
    const plan = makePlan({ suggestedRetrievalMode: 'no_match_detection' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('no_match');
  });

  it('derives queryFamily producer_browse', () => {
    const plan = makePlan({ suggestedRetrievalMode: 'producer_browse' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('producer_browse');
  });

  it('derives queryFamily region_browse', () => {
    const plan = makePlan({ suggestedRetrievalMode: 'region_browse' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('region_browse');
  });

  it('derives queryFamily comparison for compare_candidates mode', () => {
    const plan = makePlan({ suggestedRetrievalMode: 'compare_candidates' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('comparison');
  });

  it('derives queryFamily recommendation for recommendation mode', () => {
    const plan = makePlan({ suggestedRetrievalMode: 'recommendation' });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('recommendation');
  });

  it('derives queryFamily ambiguous when ambiguityDetected', () => {
    const plan = makePlan({
      intent: 'facet_search',
      suggestedRetrievalMode: 'attribute_search',
      uncertainty: {
        overall: 0.7,
        ambiguityDetected: true,
        ambiguityTypes: ['entity'],
        ambiguitySeverity: 'high',
        decisionEffect: 'force_clarify',
        parserConfidence: 0.5,
        anchorConfidence: 0.5,
        constraintConfidence: 0.5,
      },
    });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('ambiguous');
  });

  it('derives queryFamily multi_intent for non-comparison decomposition hints', () => {
    const plan = makePlan({
      intent: 'facet_search',
      suggestedRetrievalMode: 'attribute_search',
      decompositionHint: {
        strategy: 'multi_intent',
        subQueryCount: 2,
        confidence: 0.8,
      },
      uncertainty: {
        overall: 0.2,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0.9,
        constraintConfidence: 0.9,
      },
    });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('multi_intent');
  });

  it('derives queryFamily attribute_constrained for facet_search with attribute_search mode', () => {
    const plan = makePlan({
      intent: 'facet_search',
      suggestedRetrievalMode: 'attribute_search',
      uncertainty: {
        overall: 0.2,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0.9,
        constraintConfidence: 0.9,
      },
    });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.queryFamily).toBe('attribute_constrained');
  });

  it('truncates rawQuery to 200 chars', () => {
    const longQuery = 'a'.repeat(300);
    const plan = makePlan({ rawQuery: longQuery });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.rawQuery).toHaveLength(200);
  });

  it('counts anchors, hard and soft constraints correctly', () => {
    const plan = makePlan({
      anchors: [
        { surfaceForm: 'Opus One', normalizedForm: 'opus one', confidence: 0.95, candidateEntityIds: [] },
      ],
      constraints: {
        hard: [
          { attribute: 'vintage', operator: 'eq', value: 2020, confidence: 0.9 },
          { attribute: 'region', operator: 'eq', value: 'Napa', confidence: 0.9 },
        ],
        soft: [
          { attribute: 'body', operator: 'eq', value: 'full', confidence: 0.7 },
        ],
        inferred: [],
      },
    });
    const slice = planToObservabilitySlice('q1', plan);
    expect(slice.anchorCount).toBe(1);
    expect(slice.hardConstraintCount).toBe(2);
    expect(slice.softConstraintCount).toBe(1);
  });
});

describe('QUERY_FAMILY_LABELS', () => {
  it('contains all expected labels', () => {
    expect(QUERY_FAMILY_LABELS).toContain('entity_exact');
    expect(QUERY_FAMILY_LABELS).toContain('comparison');
    expect(QUERY_FAMILY_LABELS).toContain('no_match');
    expect(QUERY_FAMILY_LABELS).toContain('ambiguous');
    expect(QUERY_FAMILY_LABELS).toContain('unknown');
  });
});

describe('isQueryPlanV2', () => {
  it('returns true for a genuine QueryPlanV2', () => {
    const plan = makePlan();
    expect(isQueryPlanV2(plan)).toBe(true);
  });

  it('returns false for a genuine QueryPlanV1', () => {
    // Minimal V1 shape: has `route` + `retrievalMode`, no `suggestedRoute`.
    const v1: QueryPlanV1 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'entity_exact',
      route: 'entity',
      retrievalMode: 'entity_lookup',
      queryClass: 'short_entity',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {
        requireExact: true,
        allowApproximate: false,
        requireClarification: false,
        fallbackMode: 'hybrid',
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
    };
    expect(isQueryPlanV2(v1)).toBe(false);
  });

  it('returns false for a V1 plan accidentally spread with suggestedRoute', () => {
    // Simulates the dangerous object-spread scenario: a V1 plan gets an
    // accidental `suggestedRoute` key. The double-check (`!('route' in plan)`)
    // must correctly reject this as non-V2 because `route` is still present.
    const v1Base: QueryPlanV1 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'entity_exact',
      route: 'entity',
      retrievalMode: 'entity_lookup',
      queryClass: 'short_entity',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {
        requireExact: true,
        allowApproximate: false,
        requireClarification: false,
        fallbackMode: 'hybrid',
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
    };
    // Force-add suggestedRoute to simulate accidental spread: { ...v1Plan, suggestedRoute: ... }
    const contaminatedV1 = { ...v1Base, suggestedRoute: 'entity' } as unknown as QueryPlanV1 | QueryPlanV2;
    // Must NOT be classified as V2 because `route` is still present.
    expect(isQueryPlanV2(contaminatedV1)).toBe(false);
  });

  it('clamps overallUncertainty to 1 when plan.uncertainty.overall is NaN', () => {
    const plan = makePlan({
      uncertainty: {
        overall: NaN,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0.9,
        constraintConfidence: 0.9,
      },
    });
    const slice = planToObservabilitySlice('q-nan', plan);
    expect(Number.isFinite(slice.overallUncertainty)).toBe(true);
    expect(slice.overallUncertainty).toBe(1);
  });
});
