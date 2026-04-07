import { describe, it, expect } from 'vitest';
import {
  buildAuthorityTraceRef,
  buildAdmissionAuthorityTraceRef,
  buildComparisonAuthorityTraceRef,
  buildInternalErrorAuthorityTraceRef,
} from '../service/authority-trace.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';

function minimalPlan(overrides?: Partial<QueryPlanV1>): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_resolution',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: true,
      allowApproximate: false,
      requireClarification: false,
      fallbackMode: 'none',
    },
    uncertainty: { level: 'low', decisionEffect: 'trace_only' },
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

function minimalSnapshot(): DecisionSnapshot {
  return {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: '1',
    feature_flags: {},
  };
}

describe('authority trace refs', () => {
  it('produces identical decision refs for identical inputs', () => {
    const plan = minimalPlan();
    const snap = minimalSnapshot();
    const a = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });
    const b = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^decision:v1:short_entity:[a-f0-9]{64}$/);
  });

  it('changes when chosen entity changes', () => {
    const plan = minimalPlan();
    const snap = minimalSnapshot();
    const a = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });
    const b = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      chosenEntityId: 'e2',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });
    expect(a).not.toBe(b);
  });

  it('uses compiled retrieval mode override when provided', () => {
    const plan = minimalPlan({ retrievalMode: 'entity_resolution' });
    const snap = minimalSnapshot();
    const plannerModeRef = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });
    const compiledModeRef = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      retrievalMode: 'recommendation',
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });

    expect(compiledModeRef).not.toBe(plannerModeRef);
  });

  it('changes decision ref when effective route changes', () => {
    const plan = minimalPlan({ route: 'entity', retrievalMode: 'attribute_search' });
    const snap = minimalSnapshot();
    const entityRef = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      route: 'entity',
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });
    const hybridRef = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      route: 'hybrid',
      chosenEntityId: 'e1',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });

    expect(hybridRef).not.toBe(entityRef);
  });

  it('builds admission ref deterministically', () => {
    const plan = minimalPlan();
    const snap = minimalSnapshot();
    const a = buildAdmissionAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      reason: 'EVIDENCE_INSUFFICIENT',
    });
    const b = buildAdmissionAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      reason: 'EVIDENCE_INSUFFICIENT',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^admission:v1:short_entity:[a-f0-9]{64}$/);
  });

  it('changes admission ref when compiled retrieval mode override changes', () => {
    const plan = minimalPlan({ retrievalMode: 'entity_resolution' });
    const snap = minimalSnapshot();
    const plannerModeRef = buildAdmissionAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      reason: 'POLICY_BLOCKED',
    });
    const compiledModeRef = buildAdmissionAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      reason: 'POLICY_BLOCKED',
      retrievalMode: 'recommendation',
    });

    expect(compiledModeRef).not.toBe(plannerModeRef);
  });

  it('changes admission ref when effective route changes', () => {
    const plan = minimalPlan({ route: 'entity', retrievalMode: 'attribute_search' });
    const snap = minimalSnapshot();
    const entityRef = buildAdmissionAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      reason: 'POLICY_BLOCKED',
      route: 'entity',
    });
    const hybridRef = buildAdmissionAuthorityTraceRef({
      queryPlan: plan,
      snapshot: snap,
      reason: 'POLICY_BLOCKED',
      route: 'hybrid',
    });

    expect(hybridRef).not.toBe(entityRef);
  });

  it('builds a decodable internal error authority ref', () => {
    const snap = minimalSnapshot();
    const ref = buildInternalErrorAuthorityTraceRef({
      snapshot: snap,
      requestId: 'req-123',
    });

    expect(ref).toMatch(/^decision:v1:internal_error:[a-f0-9]{64}$/);
  });

  it('builds a decodable comparison authority ref', () => {
    const ref = buildComparisonAuthorityTraceRef({
      originalQuery: 'Opus One vs Screaming Eagle',
      comparisonIntent: 'compare',
      overallStatus: 'resolved',
      leftAuthorityTraceRef: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
      rightAuthorityTraceRef: 'decision:v1:short_entity:2222222222222222222222222222222222222222222222222222222222222222',
    });

    expect(ref).toMatch(/^decision:v1:comparison_query:[a-f0-9]{64}$/);
  });
});
