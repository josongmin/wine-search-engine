import { describe, it, expect } from 'vitest';
import {
  planToObservabilitySlice,
  QUERY_FAMILY_LABELS,
} from '../../model/query-observability-vocab.js';
import type { QueryPlanV2 } from '../../model/query-plan.js';

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
        decisionEffect: 'force_clarification',
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
