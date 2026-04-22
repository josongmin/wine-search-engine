import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionCompiler } from '../execution-compiler.js';
import type { QueryPlanV2 } from '../../model/query-plan.js';
import type { RetrievalMode } from '../../model/retrieval-mode.js';
import type { QueryRoute } from '../../model/query-route.js';
import { bootstrapLogger } from '../../../../config/bootstrap-logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Minimal QueryPlanV2 fixture factory
// ---------------------------------------------------------------------------

function makeMinimalPlan(
  overrides: {
    suggestedRoute?: QueryRoute;
    suggestedRetrievalMode?: RetrievalMode;
    admission_context?: QueryPlanV2['admission_context'];
    queryBudget?: QueryPlanV2['queryBudget'];
  } = {},
): QueryPlanV2 {
  return {
    rawQuery: 'test query',
    normalizedQuery: 'test query',
    intent: 'entity_exact',
    suggestedRoute: overrides.suggestedRoute ?? 'entity',
    suggestedRetrievalMode: overrides.suggestedRetrievalMode ?? 'entity_lookup',
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
    ...(overrides.queryBudget !== undefined && {
      queryBudget: overrides.queryBudget,
    }),
    ...(overrides.admission_context !== undefined && {
      admission_context: overrides.admission_context,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionCompiler', () => {
  const compiler = new ExecutionCompiler();

  // 1. No API override → uses planner's suggestedRoute
  it('uses planner suggestedRoute when no API override is provided', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.effectiveRoute).toBe('hybrid');
    expect(result.execution.routeSource).toBe('planner');
  });

  // 2. API override 'entity' → overrides planner's hybrid suggestion
  it('overrides planner hybrid suggestion when API override is entity', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
    });
    const result = compiler.compile({ plan, apiRouteOverride: 'entity' });
    expect(result.execution.effectiveRoute).toBe('entity');
    expect(result.execution.routeSource).toBe('api_override');
  });

  // 3. producer_browse mode forces route to 'hybrid'
  it('forces route to hybrid for producer_browse mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity', // planner says entity
      suggestedRetrievalMode: 'producer_browse',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.effectiveRoute).toBe('hybrid');
    expect(result.execution.routeSource).toBe('planner');
  });

  // 3b. region_browse mode forces route to 'hybrid'
  it('forces route to hybrid for region_browse mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'region_browse',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.effectiveRoute).toBe('hybrid');
  });

  // 3c. compare_candidates mode forces route to 'hybrid'
  it('forces route to hybrid for compare_candidates mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'compare_candidates',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.effectiveRoute).toBe('hybrid');
    expect(result.execution.executionTopology).toBe('dual_lane');
  });

  // 3d. recommendation mode forces route to 'hybrid'
  it('forces route to hybrid for recommendation mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'mixed',
      suggestedRetrievalMode: 'recommendation',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.effectiveRoute).toBe('hybrid');
    expect(result.execution.executionTopology).toBe('dual_lane');
  });

  it('keeps explicit hybrid API override on general_only topology', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'attribute_search',
    });
    const result = compiler.compile({ plan, apiRouteOverride: 'hybrid' });
    expect(result.execution.effectiveRoute).toBe('hybrid');
    expect(result.execution.routeSource).toBe('api_override');
    expect(result.execution.executionTopology).toBe('general_only');
  });

  // 4. compare_candidates enables precision rerank in budget
  it('enables precision rerank for compare_candidates mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'compare_candidates',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.budget.enablePrecisionRerank).toBe(true);
    expect(result.execution.budget.maxCandidates).toBe(20);
    expect(result.execution.budget.rerankLimit).toBe(20);
  });

  // 5. entity_lookup disables precision rerank
  it('disables precision rerank for entity_lookup mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'entity_lookup',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.budget.enablePrecisionRerank).toBe(false);
    expect(result.execution.budget.maxCandidates).toBe(10);
    expect(result.execution.budget.rerankLimit).toBe(0);
  });

  // 6. maxCandidatesOverride overrides default budget
  it('applies maxCandidatesOverride over mode default', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'entity_lookup',
    });
    const result = compiler.compile({ plan, maxCandidatesOverride: 42 });
    expect(result.execution.budget.maxCandidates).toBe(42);
    // precision rerank stays at mode default
    expect(result.execution.budget.enablePrecisionRerank).toBe(false);
    expect(result.execution.budget.rerankLimit).toBe(0);
  });

  it('threads queryBudget.rerankLimit into the execution contract for rerank-enabled modes', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      queryBudget: {
        maxLatencyMs: 500,
        maxCandidates: 50,
        rerankLimit: 7,
      },
    });
    const result = compiler.compile({ plan });
    expect(result.execution.budget.maxCandidates).toBe(50);
    expect(result.execution.budget.rerankLimit).toBe(7);
    expect(result.execution.budget.enablePrecisionRerank).toBe(true);
  });

  it('caps rerankLimit by maxCandidates in the execution contract', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      queryBudget: {
        maxLatencyMs: 500,
        maxCandidates: 50,
        rerankLimit: 100,
      },
    });
    const result = compiler.compile({ plan, maxCandidatesOverride: 12 });
    expect(result.execution.budget.maxCandidates).toBe(12);
    expect(result.execution.budget.rerankLimit).toBe(12);
  });

  // 7. ProvenancePolicy correctly maps requires_identity_seal: true
  it('maps requires_identity_seal: true to requireIdentitySeal: true', () => {
    const plan = makeMinimalPlan({
      admission_context: {
        requires_identity_seal: true,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
    });
    const result = compiler.compile({ plan });
    expect(result.execution.provenancePolicy.requireIdentitySeal).toBe(true);
    expect(result.execution.provenancePolicy.requireConstraintEvidence).toBe(false);
    expect(result.execution.provenancePolicy.requireAnchorEvidence).toBe(false);
  });

  // 7b. ProvenancePolicy correctly maps all fields from admission_context
  it('maps all admission_context fields to ProvenancePolicy', () => {
    const plan = makeMinimalPlan({
      admission_context: {
        requires_identity_seal: true,
        requires_constraint_evidence: true,
        requires_anchor_evidence: true,
      },
    });
    const result = compiler.compile({ plan });
    expect(result.execution.provenancePolicy).toEqual({
      requireIdentitySeal: true,
      requireConstraintEvidence: true,
      requireAnchorEvidence: true,
    });
  });

  // 8. ProvenancePolicy defaults to false when admission_context absent
  it('defaults all ProvenancePolicy flags to false when admission_context is absent', () => {
    const plan = makeMinimalPlan(); // no admission_context
    const result = compiler.compile({ plan });
    expect(result.execution.provenancePolicy).toEqual({
      requireIdentitySeal: false,
      requireConstraintEvidence: false,
      requireAnchorEvidence: false,
    });
  });

  // 9a. routeSource is 'planner' when no override
  it('sets routeSource to planner when no API override given', () => {
    const plan = makeMinimalPlan({ suggestedRoute: 'entity' });
    const result = compiler.compile({ plan });
    expect(result.execution.routeSource).toBe('planner');
  });

  // 9b. routeSource is 'api_override' when override given
  it('sets routeSource to api_override when override given', () => {
    const plan = makeMinimalPlan({ suggestedRoute: 'entity' });
    const result = compiler.compile({ plan, apiRouteOverride: 'hybrid' });
    expect(result.execution.routeSource).toBe('api_override');
  });

  // 10. CompiledWineQuery.query contains all QueryUnderstandingSnapshot fields from plan
  it('query snapshot contains all expected fields from the plan', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      admission_context: {
        requires_identity_seal: false,
        requires_constraint_evidence: true,
        requires_anchor_evidence: false,
      },
    });
    const result = compiler.compile({ plan });
    const { query } = result;

    // QueryUnderstandingSnapshot fields (no execution decisions)
    expect(query.rawQuery).toBe(plan.rawQuery);
    expect(query.normalizedQuery).toBe(plan.normalizedQuery);
    expect(query.intent).toBe(plan.intent);
    expect(query.queryClass).toBe(plan.queryClass);
    expect(query.anchors).toBe(plan.anchors);
    expect(query.constraints).toBe(plan.constraints);
    expect(query.expansions).toBe(plan.expansions);
    expect(query.uncertainty).toBe(plan.uncertainty);
    expect(query.plannerVersion).toBe(plan.plannerVersion);
    expect(query.policyRuleVersion).toBe(plan.policyRuleVersion);
    expect(query.thresholdProfileId).toBe(plan.thresholdProfileId);
    // suggestedRoute/suggestedRetrievalMode are planner hints — they live on the
    // plan, not the snapshot. Execution decisions are in result.execution.
    expect(result.execution.effectiveRoute).toBeDefined();
    expect(result.execution.effectiveRetrievalMode).toBeDefined();
  });

  it('forwards plan.constraintExtraction onto compiled.query', () => {
    const extraction = {
      candidatePhraseCount: 9,
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
    const plan = { ...makeMinimalPlan(), constraintExtraction: extraction };
    const result = compiler.compile({ plan });
    expect(result.query.constraintExtraction).toEqual(extraction);
  });

  it('forwards plan.retrievalPlan onto compiled.query', () => {
    const retrievalPlan = {
      hardFilterTokens: ['region:Bordeaux'],
      softBoosts: [],
      inferredBoosts: [],
      sensoryPriors: [],
      planVersion: 'retrieval-plan-v1.0',
    };
    const plan = { ...makeMinimalPlan(), retrievalPlan };
    const result = compiler.compile({ plan });
    expect(result.query.retrievalPlan).toEqual(retrievalPlan);
  });

  it('forwards plan.retrievalObjective onto compiled.query', () => {
    const retrievalObjective = {
      objectiveVersion: 'retrieval-objective-v1.0' as const,
      signals: [
        {
          axis: 'beginner_suitability' as const,
          attribute: 'beginner_suitability',
          operator: '>=' as const,
          value: 0.65,
          sourcePhrase: '초보자',
          confidence: 0.88,
          sourceTier: 'soft' as const,
        },
      ],
    };
    const plan = { ...makeMinimalPlan(), retrievalObjective };
    const result = compiler.compile({ plan });
    expect(result.query.retrievalObjective).toEqual(retrievalObjective);
  });

  // Extra: attribute_search has correct budget defaults
  it('sets correct defaults for attribute_search mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.budget.maxCandidates).toBe(50);
    expect(result.execution.budget.enablePrecisionRerank).toBe(true);
  });

  // Extra: entity_resolution has precision rerank enabled
  it('enables precision rerank for entity_resolution mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'entity_resolution',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.budget.enablePrecisionRerank).toBe(true);
    expect(result.execution.budget.maxCandidates).toBe(20);
  });

  // Extra: no_match_detection is lean
  it('sets lean defaults for no_match_detection mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'entity',
      suggestedRetrievalMode: 'no_match_detection',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.budget.maxCandidates).toBe(5);
    expect(result.execution.budget.enablePrecisionRerank).toBe(false);
  });

  // Extra: similar_items preserves 'mixed' route
  it('preserves mixed route for similar_items mode', () => {
    const plan = makeMinimalPlan({
      suggestedRoute: 'mixed',
      suggestedRetrievalMode: 'similar_items',
    });
    const result = compiler.compile({ plan });
    expect(result.execution.effectiveRoute).toBe('mixed');
    expect(result.execution.budget.maxCandidates).toBe(20);
    expect(result.execution.budget.enablePrecisionRerank).toBe(false);
  });

  it.each(['semantic_hybrid', 'hybrid_search'] as const)(
    'normalizes legacy retrieval mode alias %s without warning',
    (legacyMode) => {
      const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => bootstrapLogger);
      const plan = makeMinimalPlan({
        suggestedRoute: 'hybrid',
        suggestedRetrievalMode: legacyMode as RetrievalMode,
      });

      const result = compiler.compile({ plan });

      expect(result.execution.effectiveRetrievalMode).toBe('attribute_search');
      expect(result.execution.budget.maxCandidates).toBe(50);
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );
});
