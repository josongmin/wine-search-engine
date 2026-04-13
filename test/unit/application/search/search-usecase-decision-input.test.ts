import { describe, it, expect } from 'vitest';
import { buildSearchDecisionInput } from '../../../../src/application/search/search-usecase-decision-input.js';
import { buildEntityRouteRankedResults } from '../../../../src/application/search/search-usecase-entity-ranked-results.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../../../src/domain/resolver/model/resolved-candidate.js';
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

function makeAnchoredPlan(route: QueryPlanV1['route'], anchorId: string): QueryPlanV1 {
  return {
    ...minimalPlan(route),
    anchors: [{
      surfaceForm: 'Opus One',
      normalizedForm: 'opus one',
      candidateEntityIds: [anchorId],
      confidence: 0.95,
      source: 'alias',
    }],
  } as QueryPlanV1;
}

function makeDecisionTrace(
  overrides: Partial<EntityResolveResult['decisionTrace']> = {},
): EntityResolveResult['decisionTrace'] {
  return {
    queryClass: 'unknown',
    top1CalibratedScore: 0,
    top2CalibratedScore: 0,
    calibratedGap: 0,
    decisionConfidenceC: 0,
    ambiguityDetected: false,
    ambiguityTypes: [],
    appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
    outcomeReasonCodes: [],
    ...overrides,
  };
}

function makeResolverResult(
  overrides: Partial<EntityResolveResult> = {},
): EntityResolveResult {
  return {
    status: 'resolved',
    candidates: [],
    decisionTrace: makeDecisionTrace(),
    conformalSetSize: 1,
    ...overrides,
  };
}

function makeRankedResult(overrides: Partial<RankedResult> = {}): RankedResult {
  return {
    entityId: createEntityId('ranked'),
    canonicalLabel: 'Ranked Wine',
    finalScore: 0.9,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.7,
      hardConstraintPass: true,
      softConstraint: 0,
      attributeAlignment: 0,
      preferenceAlignment: 0,
      popularity: 0,
      availability: 1,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    ...overrides,
  };
}

describe('buildSearchDecisionInput', () => {
  it('fails anchor evidence when mixed route is missing explicit anchor resolution context', () => {
    const eid = createEntityId();
    const plan = makeAnchoredPlan('mixed', eid);
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'X', calibratedScore: 0.9 },
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.9,
        calibratedGap: 0.9,
        decisionConfidenceC: 0.9,
      }),
    });
    const input = buildSearchDecisionInput(plan, resolverResult, []);
    expect(input.evidenceSummary.anchorResolution).toEqual({
      anchorEntityPresent: false,
    });
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(false);
  });

  it('uses effectiveRoute when API override forces mixed execution and keeps anchor evidence fail-closed without anchor context', () => {
    const eid = createEntityId();
    const plan = makeAnchoredPlan('entity', eid);
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'X', calibratedScore: 0.9 },
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.9,
        calibratedGap: 0.9,
        decisionConfidenceC: 0.9,
      }),
    });

    const input = buildSearchDecisionInput(plan, resolverResult, [], 'mixed');
    expect(input.effectiveRoute).toBe('mixed');
    expect(input.evidenceSummary.anchorResolution).toEqual({
      anchorEntityPresent: false,
    });
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(false);
    expect(input.admissionContext?.requires_anchor_evidence).toBe(true);
  });

  it('carries effectiveRetrievalMode when compiled execution mode is provided', () => {
    const input = buildSearchDecisionInput(
      minimalPlan('hybrid'),
      makeResolverResult(),
      [],
      'hybrid',
      undefined,
      undefined,
      'recommendation',
    );

    expect(input.effectiveRoute).toBe('hybrid');
    expect(input.effectiveRetrievalMode).toBe('recommendation');
  });

  it('requires explicit mixed-anchor resolution when mixed route context is present', () => {
    const eid = createEntityId('selected');
    const anchorId = createEntityId('anchor');
    const plan = makeAnchoredPlan('mixed', anchorId);
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Selected Wine', calibratedScore: 0.92 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Selected Wine',
        calibratedScore: 0.92,
        rank: 1,
        evidenceRefs: [],
      }],
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.92,
        top2CalibratedScore: 0.40,
        calibratedGap: 0.52,
        decisionConfidenceC: 0.92,
        outcomeReasonCodes: ['MIXED_ROUTE'],
      }),
    });
    const rankedResults: RankedResult[] = [makeRankedResult({
      entityId: eid,
      canonicalLabel: 'Selected Wine',
      finalScore: 0.89,
      componentScores: {
        entityIntegrity: 1,
        anchorSimilarity: 0.8,
        semantic: 0.4,
        hardConstraintPass: true,
        softConstraint: 0.2,
        attributeAlignment: 0.3,
        preferenceAlignment: 0.1,
        popularity: 0.1,
        availability: 1,
        uncertaintyPenalty: 0,
      },
      evidenceItems: [{
        type: 'anchor_similarity',
        source: 'ranker',
        contribution: '+0.80',
        strength: 'high',
        provenance: 'anchor similarity',
      }],
    })];

    const input = buildSearchDecisionInput(
      plan,
      resolverResult,
      rankedResults,
      'mixed',
      {
        mixedAnchor: {
          entityId: anchorId,
          canonicalLabel: 'Opus One 2021',
          confidence: 0.97,
        },
      },
    );

    expect(input.evidenceSummary.anchorResolution).toEqual({
      anchorEntityPresent: true,
      anchorEntityId: anchorId,
      anchorCanonicalLabel: 'Opus One 2021',
      anchorConfidence: 0.97,
    });
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(true);
  });

  it('omits rankingSignals when no ranked results', () => {
    const plan = minimalPlan('entity');
    const resolverResult = makeResolverResult({
      decisionTrace: makeDecisionTrace(),
      conformalSetSize: 0,
    });
    const input = buildSearchDecisionInput(plan, resolverResult, undefined);
    expect(input.rankingSignals).toBeUndefined();
  });

  it('derives constraint evidence from entity-route synthetic ranked results', () => {
    const eid = createEntityId('entity-kalaris');
    const plan: QueryPlanV1 = {
      ...minimalPlan('entity'),
      intent: 'entity_exact',
      retrievalMode: 'entity_lookup',
      queryClass: 'short_entity',
      constraints: {
        hard: [{
          attribute: 'grape_primary',
          operator: '=',
          value: 'Merlot',
          source_phrase: 'Merlot',
          confidence: 1,
        }],
        soft: [],
        inferred: [],
      },
    };
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: '2014 Kalaris Merlot', calibratedScore: 0.97 },
      candidates: [{
        entityId: eid,
        canonicalLabel: '2014 Kalaris Merlot',
        calibratedScore: 0.97,
        rank: 1,
        evidenceRefs: ['alias:kalaris-merlot'],
      }],
      decisionTrace: makeDecisionTrace({
        queryClass: 'short_entity',
        top1CalibratedScore: 0.97,
        top2CalibratedScore: 0,
        calibratedGap: 0.97,
        decisionConfidenceC: 0.97,
      }),
    });
    const rankedResults = buildEntityRouteRankedResults(
      plan,
      resolverResult,
      [{
        entityId: eid,
        entityType: 'wine',
        canonicalLabel: '2014 Kalaris Merlot',
        aliasMatches: [],
        attributeHints: {
          grape_primary: 'Merlot',
          producer: 'Kalaris',
          vintage_year: 2014,
        },
        sourceSignals: {
          canonicalExactMatch: 1,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          aliasTypePrior: 1,
          producerMatch: 0,
          vintageMatch: 0,
          regionMatch: 0,
          grapeHintMatch: 0,
          phoneticMatch: 0,
          editDistanceScore: 0,
          ambiguityPenalty: 0,
        },
        source: 'alias',
        sources: ['alias'],
      } satisfies ResolverCandidate],
    );

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults, 'entity');

    expect(input.evidenceSummary.constraintEvidencePresent).toBe(true);
    expect(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributes).toEqual([
      'grape_primary',
    ]);
    expect(input.evidenceSummary.constraintEvidence?.unmetRequiredAttributes).toEqual([]);
  });

  it('passes execution honesty signals into the decision input', () => {
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.8,
        top2CalibratedScore: 0.2,
        calibratedGap: 0.6,
        decisionConfidenceC: 0.8,
      }),
    });

    const input = buildSearchDecisionInput(
      plan,
      resolverResult,
      undefined,
      'hybrid',
      undefined,
      {
        executionMode: 'degraded',
        routeHealthy: false,
      },
    );

    expect(input.executionMode).toBe('degraded');
    expect(input.routeHealthy).toBe(false);
  });

  it('does not treat an unaligned ranked result as identity evidence', () => {
    const resolvedId = createEntityId('entity-resolved');
    const differentRankedId = createEntityId('entity-ranked');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: resolvedId, canonicalLabel: 'Resolved Wine', calibratedScore: 0.92 },
      candidates: [{
        entityId: resolvedId,
        canonicalLabel: 'Resolved Wine',
        calibratedScore: 0.92,
        rank: 1,
        evidenceRefs: ['alias:resolved'],
      }],
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.92,
        top2CalibratedScore: 0.30,
        calibratedGap: 0.62,
        decisionConfidenceC: 0.92,
      }),
    });
    const rankedResults: RankedResult[] = [makeRankedResult({
      entityId: differentRankedId,
      canonicalLabel: 'Different Wine',
      finalScore: 0.88,
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
    })];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults);

    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.rankedCorroborationTypes).toBeUndefined();
    expect(input.evidenceSummary.identityEvidence?.exactMatchCandidatePresent).toBeUndefined();
  });

  it('keeps exact-match identity on aligned ranked routes even when ranked evidence items are empty', () => {
    const eid = createEntityId('entity-exact');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Exact Wine', calibratedScore: 0.995 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Exact Wine',
        calibratedScore: 0.995,
        rank: 1,
        evidenceRefs: ['alias:exact'],
      }],
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.995,
        top2CalibratedScore: 0.2,
        calibratedGap: 0.795,
        decisionConfidenceC: 0.995,
      }),
    });
    const rankedResults: RankedResult[] = [makeRankedResult({
      entityId: eid,
      canonicalLabel: 'Exact Wine',
      finalScore: 0.95,
      componentScores: {
        entityIntegrity: 1,
        semantic: 0,
        hardConstraintPass: true,
        softConstraint: 0,
        attributeAlignment: 0,
        preferenceAlignment: 0,
        popularity: 0,
        availability: 0,
        uncertaintyPenalty: 0,
      },
      evidenceItems: [],
    })];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults);

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.rankedEvidenceItemCount).toBe(0);
    expect(input.evidenceSummary.identityEvidence?.exactMatchCandidatePresent).toBe(true);
  });

  it('does not mint identity evidence for synthetic ranked routes without ranked corroboration', () => {
    const eid = createEntityId('synthetic-ranked');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Synthetic Wine', calibratedScore: 0.95 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Synthetic Wine',
        calibratedScore: 0.95,
        rank: 1,
        evidenceRefs: [],
      }],
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.95,
        top2CalibratedScore: 0.50,
        calibratedGap: 0.45,
        decisionConfidenceC: 0.95,
        outcomeReasonCodes: ['HYBRID_ROUTE'],
      }),
    });
    const rankedResults: RankedResult[] = [makeRankedResult({
      entityId: eid,
      canonicalLabel: 'Synthetic Wine',
      finalScore: 0.95,
      componentScores: {
        entityIntegrity: 1,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 0.2,
        attributeAlignment: 0.1,
        preferenceAlignment: 0.1,
        popularity: 0.1,
        availability: 1,
        uncertaintyPenalty: 0,
      },
      evidenceItems: [],
    })];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults, 'hybrid');

    expect(input.evidenceSummary.identityEvidence?.source).toBe('ranked_synthetic');
    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
  });

  it('does not mint identity evidence for synthetic ranked routes with only negative ranked evidence', () => {
    const eid = createEntityId('synthetic-negative-ranked');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Synthetic Wine', calibratedScore: 0.95 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Synthetic Wine',
        calibratedScore: 0.95,
        rank: 1,
        evidenceRefs: [],
      }],
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.95,
        top2CalibratedScore: 0.50,
        calibratedGap: 0.45,
        decisionConfidenceC: 0.95,
        outcomeReasonCodes: ['HYBRID_ROUTE'],
      }),
    });
    const rankedResults: RankedResult[] = [makeRankedResult({
      entityId: eid,
      canonicalLabel: 'Synthetic Wine',
      finalScore: 0.95,
      componentScores: {
        entityIntegrity: 1,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 0.2,
        attributeAlignment: 0.1,
        preferenceAlignment: 0.1,
        popularity: 0.1,
        availability: 1,
        uncertaintyPenalty: 0,
      },
      evidenceItems: [{
        type: 'semantic_similarity',
        source: 'ranker',
        contribution: '-0.25',
        detail: 'negative evidence should not count as identity corroboration',
      }],
    })];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults, 'hybrid');

    expect(input.evidenceSummary.identityEvidence?.source).toBe('ranked_synthetic');
    expect(input.evidenceSummary.identityEvidence?.rankedEvidenceItemCount).toBe(1);
    expect(input.evidenceSummary.identityEvidence?.rankedCorroborationItemCount).toBeUndefined();
    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
  });

  it('captures matched hard constraints and anchor evidence from the ranked top result', () => {
    const eid = createEntityId('entity-anchor');
    const plan = {
      ...makeAnchoredPlan('mixed', eid),
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
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Anchored Wine', calibratedScore: 0.995 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Anchored Wine',
        calibratedScore: 0.995,
        rank: 1,
        evidenceRefs: ['alias:anchored'],
      }],
      decisionTrace: makeDecisionTrace({
        top1CalibratedScore: 0.995,
        top2CalibratedScore: 0.20,
        calibratedGap: 0.795,
        decisionConfidenceC: 0.995,
      }),
    });
    const rankedResults: RankedResult[] = [makeRankedResult({
      entityId: eid,
      canonicalLabel: 'Anchored Wine',
      finalScore: 0.95,
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
      inferredConstraints: ['appellation'],
    })];

    const input = buildSearchDecisionInput(plan, resolverResult, rankedResults, 'mixed', {
      mixedAnchor: {
        entityId: eid,
        canonicalLabel: 'Opus One 2021',
        confidence: 0.95,
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.constraintEvidencePresent).toBe(true);
    expect(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributes).toEqual(['country']);
    expect(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributeCount).toBe(1);
    expect(input.evidenceSummary.constraintEvidence?.inferredAttributes).toEqual(['appellation']);
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(true);
    expect(input.evidenceSummary.anchorResolution).toEqual({
      anchorEntityPresent: true,
      anchorEntityId: eid,
      anchorCanonicalLabel: 'Opus One 2021',
      anchorConfidence: 0.95,
    });
    expect(input.evidenceSummary.anchorEvidence?.rankedSignalPresent).toBe(true);
    expect(input.evidenceSummary.anchorEvidence?.rankedSignalItemCount).toBe(1);
    expect(input.evidenceSummary.identityEvidence?.rankedCorroborationTypes).toEqual([
      'anchor_similarity',
    ]);
    expect(input.evidenceSummary.identityEvidence?.exactMatchCandidatePresent).toBe(true);
  });
});
