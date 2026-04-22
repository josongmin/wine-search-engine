import { describe, it, expect } from 'vitest';
import { buildSearchDecisionInput } from '../../../../src/application/search/search-usecase-decision-input.js';
import { buildEntityRouteRankedResults } from '../../../../src/application/search/search-usecase-entity-ranked-results.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../../../src/domain/resolver/model/resolved-candidate.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';
import type { EntityLaneCandidateArtifact } from '../../../../src/domain/retrieval/model/dual-lane-artifact.js';
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
  it('elevates single-token family branch splits into ranking ambiguity summary', () => {
    const input = buildSearchDecisionInput({
      plan: {
        ...minimalPlan('hybrid'),
        rawQuery: 'opus',
        normalizedQuery: 'opus',
        queryClass: 'short_entity',
      },
      resolveResult: makeResolverResult(),
      rankedResults: [
        makeRankedResult({
          entityId: createEntityId('overture-2019'),
          canonicalLabel: '2019 Opus One Overture',
          rank: 1,
        }),
        makeRankedResult({
          entityId: createEntityId('opus-2018'),
          canonicalLabel: 'Opus One 2018',
          rank: 2,
        }),
      ],
    });

    expect(input.ambiguitySummary).toEqual({
      types: ['ranking_family_branch_collision'],
      severity: 'high',
      sources: ['ranking'],
      decisionEffect: 'force_clarify',
    });
  });

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
    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults: [],
    });
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults: [],
      effectiveRoute: 'mixed',
    });
    expect(input.effectiveRoute).toBe('mixed');
    expect(input.evidenceSummary.anchorResolution).toEqual({
      anchorEntityPresent: false,
    });
    expect(input.evidenceSummary.anchorEvidencePresent).toBe(false);
    expect(input.provenanceContract.policy.requireAnchorEvidence).toBe(true);
  });

  it('carries effectiveRetrievalMode when compiled execution mode is provided', () => {
    const input = buildSearchDecisionInput({
      plan: minimalPlan('hybrid'),
      resolveResult: makeResolverResult(),
      rankedResults: [],
      effectiveRoute: 'hybrid',
      executionContext: {
        effectiveRetrievalMode: 'recommendation',
        retrievalKind: 'generic_hybrid',
      },
    });

    expect(input.effectiveRoute).toBe('hybrid');
    expect(input.effectiveRetrievalMode).toBe('recommendation');
    expect(input.retrievalKind).toBe('generic_hybrid');
    expect(input.provenanceContract.policy).toEqual({
      requireIdentitySeal: false,
      requireConstraintEvidence: false,
      requireAnchorEvidence: false,
    });
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults,
      effectiveRoute: 'mixed',
      decisionContext: {
        mixedAnchor: {
          entityId: anchorId,
          canonicalLabel: 'Opus One 2021',
          confidence: 0.97,
        },
      },
    });

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
    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
    });
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults,
      effectiveRoute: 'entity',
      identityResolveResult: resolverResult,
    });

    expect(input.evidenceSummary.constraintEvidencePresent).toBe(true);
    expect(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributes).toEqual([
      'grape_primary',
    ]);
    expect(input.evidenceSummary.constraintEvidence?.unmetRequiredAttributes).toEqual([]);
  });

  it('does not gate rich constraint evidence on hardConstraintPass scalar', () => {
    const plan: QueryPlanV1 = {
      ...minimalPlan('hybrid'),
      constraints: {
        hard: [{
          attribute: 'region',
          operator: '=',
          value: 'Bordeaux',
          source_phrase: 'Bordeaux',
          confidence: 1,
        }],
        soft: [],
        inferred: [],
      },
    };
    const resolverResult = makeResolverResult();
    const rankedResults: RankedResult[] = [makeRankedResult({
      matchedConstraints: ['region'],
      unmetConstraints: [],
      componentScores: {
        entityIntegrity: 1,
        semantic: 0.7,
        hardConstraintPass: false,
        softConstraint: 0,
        attributeAlignment: 0,
        preferenceAlignment: 0,
        popularity: 0,
        availability: 1,
        uncertaintyPenalty: 0,
      },
    })];

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults,
      effectiveRoute: 'hybrid',
    });

    expect(input.evidenceSummary.constraintEvidencePresent).toBe(true);
    expect(input.provenanceContract.observed.constraintEvidenceSatisfied).toBe(true);
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      effectiveRoute: 'hybrid',
      honestyContract: {
        executionMode: 'degraded',
        routeHealthy: false,
      },
    });

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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults,
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactMatchesResolveResult).toBe(
      false,
    );
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('none');
  });

  it('derives admission context from compiled provenance policy', () => {
    const plan = minimalPlan('entity');
    const resolverResult = makeResolverResult();

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      effectiveRoute: 'entity',
      executionContext: {
        effectiveRetrievalMode: 'entity_lookup',
        retrievalKind: 'entity_lookup',
        provenancePolicy: {
          requireIdentitySeal: true,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    });

    expect(input.effectiveRetrievalMode).toBe('entity_lookup');
    expect(input.retrievalKind).toBe('entity_lookup');
    expect(input.provenanceContract.policy).toEqual({
      requireIdentitySeal: true,
      requireConstraintEvidence: false,
      requireAnchorEvidence: false,
    });
  });

  it('does not recover exactness from query-level lookup strategy when the winner lacks an exact identity artifact', () => {
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: {
        ...resolverResult,
        decisionTrace: makeDecisionTrace({
          ...resolverResult.decisionTrace,
          queryProvenance: {
            anchorLookupStrategies: ['exact'],
          },
        }),
      },
      rankedResults,
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactMatchesResolveResult).toBe(
      false,
    );
    expect(input.evidenceSummary.identityEvidence?.identityEvidenceRefCount).toBe(0);
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('none');
  });

  it('prefers winner-aligned identity artifact exactness over query-level exact lookup strategy', () => {
    const eid = createEntityId('entity-artifact-exact');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Artifact Exact Wine', calibratedScore: 0.995 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Artifact Exact Wine',
        calibratedScore: 0.995,
        rank: 1,
        evidenceRefs: ['alias:artifact-exact'],
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
      canonicalLabel: 'Artifact Exact Wine',
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: {
        ...resolverResult,
        decisionTrace: makeDecisionTrace({
          ...resolverResult.decisionTrace,
          queryProvenance: {
            anchorLookupStrategies: ['exact'],
          },
        }),
      },
      rankedResults,
      executionContext: {
        winnerDualLaneArtifact: {
          entityId: eid,
          canonicalLabel: 'Artifact Exact Wine',
          lanePresence: 'entity_only',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: eid,
            exactnessTier: 'exact',
            calibratedScore: 0.995,
            resolverRank: 1,
            canonicalLabel: 'Artifact Exact Wine',
            evidenceRefs: ['identity:artifact-exact'],
            sourceSignals: {
              canonicalExactMatch: 1,
              canonicalNormalizedMatch: 1,
              aliasExactMatch: 0,
              aliasFuzzyMatch: 0,
              editDistanceScore: 0,
            },
          },
          fusedCandidate: {
            entityId: eid,
            canonicalLabel: 'Artifact Exact Wine',
            matchedConstraints: [],
            retrievalTrace: {
              retrievalProfile: 'test',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
          },
        },
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('exact');
  });

  it('accepts entity-only winner identity artifact as the exactness SSOT', () => {
    const eid = createEntityId('entity-only-exact');
    const plan = minimalPlan('entity');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Entity Only Wine', calibratedScore: 0.99 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Entity Only Wine',
        calibratedScore: 0.99,
        rank: 1,
        evidenceRefs: ['alias:entity-only'],
      }],
      decisionTrace: makeDecisionTrace({
        queryClass: 'short_entity',
        top1CalibratedScore: 0.99,
        top2CalibratedScore: 0.1,
        calibratedGap: 0.89,
        decisionConfidenceC: 0.99,
      }),
    });
    const winnerIdentityArtifact: EntityLaneCandidateArtifact = {
      entityId: eid,
      candidate: {
        entityId: eid,
        canonicalLabel: 'Entity Only Wine',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'entity_route_synthetic',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['entity_resolver'],
        },
        entityPosteriorScore: 0.99,
        identityExactnessTier: 'exact',
        lanePresence: 'entity_only',
      },
      resolvedCandidate: resolverResult.candidates[0]!,
      identityProvenance: {
        source: 'entity_resolver',
        entityId: eid,
        exactnessTier: 'exact',
        calibratedScore: 0.99,
        resolverRank: 1,
        canonicalLabel: 'Entity Only Wine',
        evidenceRefs: ['identity:entity-only'],
        sourceSignals: {
          canonicalExactMatch: 1,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 0,
          aliasFuzzyMatch: 0,
          editDistanceScore: 0,
        },
      },
      evidenceItems: [],
    };

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: resolverResult,
      rankedResults: [makeRankedResult({ entityId: eid, canonicalLabel: 'Entity Only Wine' })],
      effectiveRoute: 'entity',
      executionContext: {
        effectiveRetrievalMode: 'entity_lookup',
        retrievalKind: 'entity_lookup',
        winnerIdentityArtifact,
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.lanePresence).toBe('entity_only');
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('exact');
  });

  it('accepts winner-aligned artifacts even when identityResolveResult is omitted', () => {
    const eid = createEntityId('artifact-only-ssot');
    const plan = minimalPlan('entity');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Artifact Only Wine', calibratedScore: 0.98 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Artifact Only Wine',
        calibratedScore: 0.98,
        rank: 1,
        evidenceRefs: ['identity:artifact-only'],
      }],
    });
    const winnerIdentityArtifact: EntityLaneCandidateArtifact = {
      entityId: eid,
      candidate: {
        entityId: eid,
        canonicalLabel: 'Artifact Only Wine',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'entity_route_synthetic',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['entity_resolver'],
        },
        entityPosteriorScore: 0.98,
        identityExactnessTier: 'alias_exact',
        lanePresence: 'entity_only',
      },
      resolvedCandidate: resolverResult.candidates[0]!,
      identityProvenance: {
        source: 'entity_resolver',
        entityId: eid,
        exactnessTier: 'alias_exact',
        calibratedScore: 0.98,
        resolverRank: 1,
        canonicalLabel: 'Artifact Only Wine',
        evidenceRefs: ['identity:artifact-only'],
        sourceSignals: {
          canonicalExactMatch: 0,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          editDistanceScore: 0,
        },
      },
      evidenceItems: [],
    };

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults: [makeRankedResult({ entityId: eid, canonicalLabel: 'Artifact Only Wine' })],
      effectiveRoute: 'entity',
      executionContext: {
        effectiveRetrievalMode: 'entity_lookup',
        retrievalKind: 'entity_lookup',
        winnerIdentityArtifact,
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactMatchesResolveResult).toBe(
      true,
    );
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('alias_exact');
  });

  it('does not recover exactness from winner identity artifact candidate fields when provenance exactness is none', () => {
    const eid = createEntityId('entity-only-candidate-exactness');
    const plan = minimalPlan('entity');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Entity Artifact Wine', calibratedScore: 0.97 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Entity Artifact Wine',
        calibratedScore: 0.97,
        rank: 1,
        evidenceRefs: ['alias:entity-artifact'],
      }],
    });
    const winnerIdentityArtifact: EntityLaneCandidateArtifact = {
      entityId: eid,
      candidate: {
        entityId: eid,
        canonicalLabel: 'Entity Artifact Wine',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'entity_route_synthetic',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['entity_resolver'],
        },
        entityPosteriorScore: 0.97,
        identityExactnessTier: 'alias_exact',
        lanePresence: 'entity_only',
      },
      resolvedCandidate: resolverResult.candidates[0]!,
      identityProvenance: {
        source: 'entity_resolver',
        entityId: eid,
        exactnessTier: 'none',
        calibratedScore: 0.97,
        resolverRank: 1,
        canonicalLabel: 'Entity Artifact Wine',
        evidenceRefs: ['identity:entity-artifact'],
        sourceSignals: {
          canonicalExactMatch: 0,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          editDistanceScore: 0,
        },
      },
      evidenceItems: [],
    };

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: resolverResult,
      rankedResults: [makeRankedResult({ entityId: eid, canonicalLabel: 'Entity Artifact Wine' })],
      effectiveRoute: 'entity',
      executionContext: {
        effectiveRetrievalMode: 'entity_lookup',
        retrievalKind: 'entity_lookup',
        winnerIdentityArtifact,
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.lanePresence).toBe('entity_only');
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('none');
  });

  it('uses winner-aligned provenance exactness over duplicated dual-lane artifact fields', () => {
    const eid = createEntityId('provenance-ssot');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Provenance Wine', calibratedScore: 0.98 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Provenance Wine',
        calibratedScore: 0.98,
        rank: 1,
        evidenceRefs: ['identity:provenance'],
      }],
    });

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: resolverResult,
      rankedResults: [makeRankedResult({ entityId: eid, canonicalLabel: 'Provenance Wine' })],
      executionContext: {
        winnerDualLaneArtifact: {
          entityId: eid,
          canonicalLabel: 'Provenance Wine',
          lanePresence: 'corroborated',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: eid,
            exactnessTier: 'alias_exact',
            calibratedScore: 0.98,
            resolverRank: 1,
            canonicalLabel: 'Provenance Wine',
            evidenceRefs: ['identity:provenance'],
            sourceSignals: {
              canonicalExactMatch: 0,
              canonicalNormalizedMatch: 1,
              aliasExactMatch: 1,
              aliasFuzzyMatch: 0,
              editDistanceScore: 0,
            },
          },
          fusedCandidate: {
            entityId: eid,
            canonicalLabel: 'Provenance Wine',
            matchedConstraints: [],
            identityExactnessTier: 'exact',
            lanePresence: 'corroborated',
            retrievalTrace: {
              retrievalProfile: 'test',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
          },
        },
      },
    });

    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('alias_exact');
    expect(input.evidenceSummary.identityEvidence?.lanePresence).toBe('corroborated');
  });

  it('keeps dual-lane fused artifact exactness authoritative when entity-lane artifact disagrees', () => {
    const eid = createEntityId('dual-lane-ssot');
    const plan = minimalPlan('hybrid');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Dual Lane Wine', calibratedScore: 0.98 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Dual Lane Wine',
        calibratedScore: 0.98,
        rank: 1,
        evidenceRefs: ['identity:dual-lane'],
      }],
    });
    const winnerIdentityArtifact: EntityLaneCandidateArtifact = {
      entityId: eid,
      candidate: {
        entityId: eid,
        canonicalLabel: 'Dual Lane Wine',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'entity_route_synthetic',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['entity_resolver'],
        },
        entityPosteriorScore: 0.98,
        identityExactnessTier: 'alias_fuzzy',
        lanePresence: 'entity_only',
      },
      resolvedCandidate: resolverResult.candidates[0]!,
      identityProvenance: {
        source: 'entity_resolver',
        entityId: eid,
        exactnessTier: 'alias_fuzzy',
        calibratedScore: 0.98,
        resolverRank: 1,
        canonicalLabel: 'Dual Lane Wine',
        evidenceRefs: ['identity:entity-lane'],
        sourceSignals: {
          canonicalExactMatch: 0,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 0,
          aliasFuzzyMatch: 1,
          editDistanceScore: 0.5,
        },
      },
      evidenceItems: [],
    };

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: resolverResult,
      rankedResults: [makeRankedResult({ entityId: eid, canonicalLabel: 'Dual Lane Wine' })],
      executionContext: {
        winnerDualLaneArtifact: {
          entityId: eid,
          canonicalLabel: 'Dual Lane Wine',
          lanePresence: 'corroborated',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: eid,
            exactnessTier: 'alias_exact',
            calibratedScore: 0.98,
            resolverRank: 1,
            canonicalLabel: 'Dual Lane Wine',
            evidenceRefs: ['identity:dual-lane'],
            sourceSignals: {
              canonicalExactMatch: 0,
              canonicalNormalizedMatch: 1,
              aliasExactMatch: 1,
              aliasFuzzyMatch: 0,
              editDistanceScore: 0,
            },
          },
          fusedCandidate: {
            entityId: eid,
            canonicalLabel: 'Dual Lane Wine',
            matchedConstraints: [],
            identityExactnessTier: 'alias_exact',
            lanePresence: 'corroborated',
            retrievalTrace: {
              retrievalProfile: 'dual_lane_fusion',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
          },
        },
        winnerIdentityArtifact,
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.lanePresence).toBe('corroborated');
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('alias_exact');
  });

  it('rejects an outer-aligned identity artifact whose nested payload points at a different entity', () => {
    const eid = createEntityId('winner');
    const otherId = createEntityId('other');
    const plan = minimalPlan('entity');
    const resolverResult = makeResolverResult({
      topEntity: { entityId: eid, canonicalLabel: 'Winner Wine', calibratedScore: 0.97 },
      candidates: [{
        entityId: eid,
        canonicalLabel: 'Winner Wine',
        calibratedScore: 0.97,
        rank: 1,
        evidenceRefs: ['identity:winner'],
      }],
    });
    const misalignedArtifact: EntityLaneCandidateArtifact = {
      entityId: eid,
      candidate: {
        entityId: otherId,
        canonicalLabel: 'Other Wine',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'entity_route_synthetic',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['entity_resolver'],
        },
        entityPosteriorScore: 0.97,
        identityExactnessTier: 'exact',
        lanePresence: 'entity_only',
      },
      resolvedCandidate: {
        ...resolverResult.candidates[0]!,
        entityId: otherId,
      },
      identityProvenance: {
        source: 'entity_resolver',
        entityId: eid,
        exactnessTier: 'exact',
        calibratedScore: 0.97,
        resolverRank: 1,
        canonicalLabel: 'Winner Wine',
        evidenceRefs: ['identity:winner'],
        sourceSignals: {
          canonicalExactMatch: 1,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 0,
          aliasFuzzyMatch: 0,
          editDistanceScore: 0,
        },
      },
      evidenceItems: [],
    };

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: resolverResult,
      rankedResults: [makeRankedResult({ entityId: eid, canonicalLabel: 'Winner Wine' })],
      effectiveRoute: 'entity',
      executionContext: {
        effectiveRetrievalMode: 'entity_lookup',
        retrievalKind: 'entity_lookup',
        winnerIdentityArtifact: misalignedArtifact,
      },
    });

    expect(input.evidenceSummary.identityEvidencePresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactMatchesResolveResult).toBe(
      false,
    );
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('none');
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults,
      effectiveRoute: 'hybrid',
    });

    expect(input.evidenceSummary.identityEvidence?.source).toBe('identity_artifact');
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('none');
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      rankedResults,
      effectiveRoute: 'hybrid',
    });

    expect(input.evidenceSummary.identityEvidence?.source).toBe('identity_artifact');
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(false);
    expect(input.evidenceSummary.identityEvidence?.identityEvidenceRefCount).toBe(0);
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

    const input = buildSearchDecisionInput({
      plan,
      resolveResult: resolverResult,
      identityResolveResult: {
        ...resolverResult,
        decisionTrace: makeDecisionTrace({
          ...resolverResult.decisionTrace,
          queryProvenance: {
            anchorLookupStrategies: ['exact'],
          },
        }),
      },
      rankedResults,
      effectiveRoute: 'mixed',
      decisionContext: {
        mixedAnchor: {
          entityId: eid,
          canonicalLabel: 'Opus One 2021',
          confidence: 0.95,
        },
      },
      executionContext: {
        winnerDualLaneArtifact: {
          entityId: eid,
          canonicalLabel: 'Opus One 2021',
          lanePresence: 'corroborated',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: eid,
            exactnessTier: 'exact',
            calibratedScore: 0.95,
            resolverRank: 1,
            canonicalLabel: 'Opus One 2021',
            evidenceRefs: ['identity:exact'],
            sourceSignals: {
              canonicalExactMatch: 1,
              canonicalNormalizedMatch: 1,
              aliasExactMatch: 0,
              aliasFuzzyMatch: 0,
              editDistanceScore: 0,
            },
          },
          fusedCandidate: {
            entityId: eid,
            canonicalLabel: 'Opus One 2021',
            matchedConstraints: ['country'],
            retrievalTrace: {
              retrievalProfile: 'test',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
          },
        },
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
    expect(input.evidenceSummary.identityEvidence?.winnerIdentityArtifactPresent).toBe(true);
    expect(input.evidenceSummary.identityEvidence?.lanePresence).toBe('corroborated');
    expect(input.evidenceSummary.identityEvidence?.exactnessTier).toBe('exact');
  });
});
