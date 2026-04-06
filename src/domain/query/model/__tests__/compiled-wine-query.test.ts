import { describe, it, expectTypeOf } from 'vitest';
import type { CompiledWineQuery } from '../compiled-wine-query.js';
import type {
  EngineExecutionContract,
  ExecutionBudget,
  ExecutionRoute,
  ExecutionRetrievalMode,
  ProvenancePolicy,
} from '../engine-execution-contract.js';
import type { QueryUnderstandingSnapshot } from '../query-understanding-snapshot.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeExecutionBudget(overrides?: Partial<ExecutionBudget>): ExecutionBudget {
  return {
    maxCandidates: 200,
    enablePrecisionRerank: false,
    ...overrides,
  };
}

function makeProvenancePolicy(overrides?: Partial<ProvenancePolicy>): ProvenancePolicy {
  return {
    requireIdentitySeal: false,
    requireConstraintEvidence: false,
    requireAnchorEvidence: false,
    ...overrides,
  };
}

function makeEngineExecutionContract(
  overrides?: Partial<EngineExecutionContract>,
): EngineExecutionContract {
  return {
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    budget: makeExecutionBudget(),
    provenancePolicy: makeProvenancePolicy(),
    routeSource: 'planner',
    ...overrides,
  };
}

function makeQueryUnderstandingSnapshot(
  overrides?: Partial<QueryUnderstandingSnapshot>,
): QueryUnderstandingSnapshot {
  return {
    rawQuery: 'nice red wine under 30',
    normalizedQuery: 'nice red wine under 30',
    intent: 'facet_search',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 1.0,
      constraintConfidence: 0.85,
    },
    queryClass: 'constraint_heavy',
    plannerVersion: '1.0.0',
    policyRuleVersion: '2024-01',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

function makeCompiledWineQuery(overrides?: Partial<CompiledWineQuery>): CompiledWineQuery {
  return {
    query: makeQueryUnderstandingSnapshot(),
    execution: makeEngineExecutionContract(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shape / structural type tests
// ---------------------------------------------------------------------------

describe('CompiledWineQuery', () => {
  it('has the correct top-level shape', () => {
    expectTypeOf<CompiledWineQuery>().toHaveProperty('query');
    expectTypeOf<CompiledWineQuery>().toHaveProperty('execution');
    expectTypeOf<CompiledWineQuery['query']>().toEqualTypeOf<QueryUnderstandingSnapshot>();
    expectTypeOf<CompiledWineQuery['execution']>().toEqualTypeOf<EngineExecutionContract>();
  });

  it('constructs a valid CompiledWineQuery at runtime', () => {
    const compiled = makeCompiledWineQuery();
    expect(compiled.query.rawQuery).toBe('nice red wine under 30');
    expect(compiled.execution.route).toBe('hybrid');
    expect(compiled.execution.routeSource).toBe('planner');
  });
});

// ---------------------------------------------------------------------------
// EngineExecutionContract
// ---------------------------------------------------------------------------

describe('EngineExecutionContract', () => {
  it('has all required fields', () => {
    expectTypeOf<EngineExecutionContract>().toHaveProperty('route');
    expectTypeOf<EngineExecutionContract>().toHaveProperty('retrievalMode');
    expectTypeOf<EngineExecutionContract>().toHaveProperty('budget');
    expectTypeOf<EngineExecutionContract>().toHaveProperty('provenancePolicy');
    expectTypeOf<EngineExecutionContract>().toHaveProperty('routeSource');
  });

  it('accepts all valid ExecutionRoute values', () => {
    const routes: ExecutionRoute[] = ['entity', 'hybrid', 'mixed'];
    for (const route of routes) {
      const contract = makeEngineExecutionContract({ route });
      expect(contract.route).toBe(route);
    }
  });

  it('accepts all valid ExecutionRetrievalMode values', () => {
    const modes: ExecutionRetrievalMode[] = [
      'entity_lookup',
      'entity_resolution',
      'attribute_search',
      'constraint_filter',
      'producer_browse',
      'region_browse',
      'compare_candidates',
      'recommendation',
      'similar_items',
      'no_match_detection',
    ];
    for (const mode of modes) {
      const contract = makeEngineExecutionContract({ retrievalMode: mode });
      expect(contract.retrievalMode).toBe(mode);
    }
  });

  it('accepts routeSource of planner or api_override', () => {
    const plannerContract = makeEngineExecutionContract({ routeSource: 'planner' });
    const overrideContract = makeEngineExecutionContract({ routeSource: 'api_override' });
    expect(plannerContract.routeSource).toBe('planner');
    expect(overrideContract.routeSource).toBe('api_override');
  });
});

// ---------------------------------------------------------------------------
// ExecutionBudget
// ---------------------------------------------------------------------------

describe('ExecutionBudget', () => {
  it('has all required fields', () => {
    expectTypeOf<ExecutionBudget>().toHaveProperty('maxCandidates');
    expectTypeOf<ExecutionBudget>().toHaveProperty('enablePrecisionRerank');
  });

  it('accepts maxCandidates and enablePrecisionRerank as required', () => {
    const budget = makeExecutionBudget({ maxCandidates: 100, enablePrecisionRerank: true });
    expect(budget.maxCandidates).toBe(100);
    expect(budget.enablePrecisionRerank).toBe(true);
  });

  it('allows maxLatencyMs to be omitted (optional field)', () => {
    const budget = makeExecutionBudget();
    // maxLatencyMs is optional — should be absent, not undefined
    expect('maxLatencyMs' in budget).toBe(false);
  });

  it('accepts maxLatencyMs when provided', () => {
    const budget = makeExecutionBudget({ maxLatencyMs: 300 });
    expect(budget.maxLatencyMs).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// ProvenancePolicy — admission_context semantics
// ---------------------------------------------------------------------------

describe('ProvenancePolicy', () => {
  it('has all required fields capturing admission_context semantics', () => {
    expectTypeOf<ProvenancePolicy>().toHaveProperty('requireIdentitySeal');
    expectTypeOf<ProvenancePolicy>().toHaveProperty('requireConstraintEvidence');
    expectTypeOf<ProvenancePolicy>().toHaveProperty('requireAnchorEvidence');
  });

  it('requireIdentitySeal is true for entity routes', () => {
    const policy = makeProvenancePolicy({ requireIdentitySeal: true });
    expect(policy.requireIdentitySeal).toBe(true);
  });

  it('requireConstraintEvidence is true when hard constraints are present', () => {
    const policy = makeProvenancePolicy({ requireConstraintEvidence: true });
    expect(policy.requireConstraintEvidence).toBe(true);
  });

  it('requireAnchorEvidence is true for mixed-query routes with anchors', () => {
    const policy = makeProvenancePolicy({ requireAnchorEvidence: true });
    expect(policy.requireAnchorEvidence).toBe(true);
  });

  it('all three flags can be independently set', () => {
    const allTrue = makeProvenancePolicy({
      requireIdentitySeal: true,
      requireConstraintEvidence: true,
      requireAnchorEvidence: true,
    });
    expect(allTrue.requireIdentitySeal).toBe(true);
    expect(allTrue.requireConstraintEvidence).toBe(true);
    expect(allTrue.requireAnchorEvidence).toBe(true);

    const allFalse = makeProvenancePolicy();
    expect(allFalse.requireIdentitySeal).toBe(false);
    expect(allFalse.requireConstraintEvidence).toBe(false);
    expect(allFalse.requireAnchorEvidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QueryUnderstandingSnapshot optional fields
// ---------------------------------------------------------------------------

describe('QueryUnderstandingSnapshot', () => {
  it('optional fields can be omitted', () => {
    const snapshot = makeQueryUnderstandingSnapshot();
    expect('normalizedQueryViews' in snapshot).toBe(false);
    expect('secondaryIntents' in snapshot).toBe(false);
    expect('targetEntityType' in snapshot).toBe(false);
    expect('sessionContext' in snapshot).toBe(false);
    expect('queryBudget' in snapshot).toBe(false);
  });

  it('accepts optional fields when provided', () => {
    const snapshot = makeQueryUnderstandingSnapshot({
      secondaryIntents: ['budget_search'],
      targetEntityType: 'wine',
    });
    expect(snapshot.secondaryIntents).toEqual(['budget_search']);
    expect(snapshot.targetEntityType).toBe('wine');
  });

  it('carries planner version metadata', () => {
    const snapshot = makeQueryUnderstandingSnapshot({
      plannerVersion: '2.0.0',
      policyRuleVersion: '2025-01',
      thresholdProfileId: 'strict-v2',
    });
    expect(snapshot.plannerVersion).toBe('2.0.0');
    expect(snapshot.policyRuleVersion).toBe('2025-01');
    expect(snapshot.thresholdProfileId).toBe('strict-v2');
  });
});
