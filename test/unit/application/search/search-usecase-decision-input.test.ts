import { describe, it, expect } from 'vitest';
import { buildSearchDecisionInput } from '../../../../src/application/search/search-usecase-decision-input.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';
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

  it('does not treat an unaligned ranked result as identity evidence', () => {
    const resolvedId = createEntityId('entity-resolved');
    const differentRankedId = createEntityId('entity-ranked');
    const plan = minimalPlan('hybrid');
    const resolverResult: EntityResolveResult = {
      status: 'resolved',
      topEntity: { entityId: resolvedId, canonicalLabel: 'Resolved Wine', calibratedScore: 0.92 },
      candidates: [{
        entityId: resolvedId,
        canonicalLabel: 'Resolved Wine',
        calibratedScore: 0.92,
        rank: 1,
        evidenceRefs: ['alias:resolved'],
      }],
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0.92,
        top2CalibratedScore: 0.30,
        calibratedGap: 0.62,
        decisionConfidenceC: 0.92,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      conformalSetSize: 1,
    };
    const rankedResults: RankedResult[] = [{
      entityId: differentRankedId,
      canonicalLabel: 'Different Wine',
      finalScore: 0.88,
      rank: 1,
      componentScores: {
        entityIntegrity: 1,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 1,
        attributeAlignment: 0.5,
        preferenceAlignment: 0.5,
        popularity: 0.5,
        availability: 1,
        uncertaintyPenalty: 0,
      },
      evidenceItems: [{
        type: 'semantic_relevance',
        source: 'ranking_signal_computer',
        contribution: '+0.70',
        strength: 'high',
        provenance: 'Semantic relevance from dense retrieval similarity',
      }],
      matchedConstraints: [],
      unmetConstraints: [],
      inferredConstraints: [],
    }];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults);

    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(false);
  });

  it('captures matched hard constraints and anchor evidence from the ranked top result', () => {
    const eid = createEntityId('entity-anchor');
    const plan = {
      ...minimalPlan('mixed'),
      anchors: [{
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: [eid],
        confidence: 0.95,
        source: 'alias',
      }],
      constraints: {
        hard: [{
          attribute: 'country',
          operator: '=',
          value: 'france',
          source_phrase: 'france',
          confidence: 0.9,
        }],
        soft: [],
        inferred: [{
          attribute: 'appellation',
          operator: '=',
          value: 'pauillac',
          source_phrase: 'pauillac',
          confidence: 0.5,
        }],
      },
    } as QueryPlanV1;
    const resolverResult: EntityResolveResult = {
      status: 'resolved',
      topEntity: { entityId: eid, canonicalLabel: 'Anchored Wine', calibratedScore: 0.995 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Anchored Wine',
        calibratedScore: 0.995,
        rank: 1,
        evidenceRefs: ['alias:anchored'],
      }],
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0.995,
        top2CalibratedScore: 0.20,
        calibratedGap: 0.795,
        decisionConfidenceC: 0.995,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      conformalSetSize: 1,
    };
    const rankedResults: RankedResult[] = [{
      entityId: eid,
      canonicalLabel: 'Anchored Wine',
      finalScore: 0.95,
      rank: 1,
      componentScores: {
        entityIntegrity: 1,
        anchorSimilarity: 0.8,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 1,
        attributeAlignment: 0.9,
        preferenceAlignment: 0.5,
        popularity: 0.5,
        availability: 1,
        uncertaintyPenalty: 0,
      },
      evidenceItems: [{
        type: 'anchor_similarity',
        source: 'ranking_signal_computer',
        contribution: '+0.80',
        strength: 'high',
        provenance: 'Similarity to anchor entity based on attributes and embedding',
      }],
      matchedConstraints: ['country'],
      unmetConstraints: [],
      inferredConstraints: ['appellation'],
    }];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults, 'mixed');

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.constraintEvidencePresent).toBe(true);
    expect(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributes).toEqual(['country']);
    expect(input.evidenceSummary.constraintEvidence?.inferredAttributes).toEqual(['appellation']);
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(true);
    expect(input.evidenceSummary.anchorEvidence?.rankedSignalPresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.exactMatchCandidatePresent).toBe(true);
  });
});
