import { describe, it, expect } from 'vitest';
import { buildSearchDecisionInput } from '../../../../src/application/search/search-usecase-decision-input.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(route: QueryPlanV1['route']): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route,
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

describe('buildSearchDecisionInput', () => {
  it('sets anchorEvidencePresent when mixed route and topEntity', () => {
    const eid = createEntityId();
    const plan = {
      ...minimalPlan('mixed'),
      anchors: [{
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: [eid],
        confidence: 0.95,
        source: 'alias',
      }],
    } as QueryPlanV1;
    const resolverResult: EntityResolveResult = {
      status: 'resolved',
      candidates: [],
      topEntity: { entityId: eid, canonicalLabel: 'X', calibratedScore: 0.9 },
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0.9,
        top2CalibratedScore: 0,
        calibratedGap: 0.9,
        decisionConfidenceC: 0.9,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      conformalSetSize: 1,
    };
    const input = buildSearchDecisionInput(plan, resolverResult, []);
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(true);
  });

  it('uses effectiveRoute when API override forces mixed execution', () => {
    const eid = createEntityId();
    const plan = {
      ...minimalPlan('entity'),
      anchors: [{
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: [eid],
        confidence: 0.95,
        source: 'alias',
      }],
    } as QueryPlanV1;
    const resolverResult: EntityResolveResult = {
      status: 'resolved',
      candidates: [],
      topEntity: { entityId: eid, canonicalLabel: 'X', calibratedScore: 0.9 },
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0.9,
        top2CalibratedScore: 0,
        calibratedGap: 0.9,
        decisionConfidenceC: 0.9,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      conformalSetSize: 1,
    };

    const input = buildSearchDecisionInput(plan, resolverResult, [], 'mixed');
    expect(input.effectiveRoute).toBe('mixed');
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(true);
    expect(input.admissionContext?.requires_anchor_evidence).toBe(true);
  });

  it('omits rankingSignals when no ranked results', () => {
    const plan = minimalPlan('entity');
    const resolverResult: EntityResolveResult = {
      status: 'resolved',
      candidates: [],
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0,
        top2CalibratedScore: 0,
        calibratedGap: 0,
        decisionConfidenceC: 0,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      conformalSetSize: 0,
    };
    const input = buildSearchDecisionInput(plan, resolverResult, undefined);
    expect(input.rankingSignals).toBeUndefined();
  });
});
