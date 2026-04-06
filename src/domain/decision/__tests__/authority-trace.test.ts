import { describe, it, expect } from 'vitest';
import { buildAuthorityTraceRef, buildAdmissionAuthorityTraceRef } from '../service/authority-trace.js';
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
});
