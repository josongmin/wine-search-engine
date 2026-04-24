import { describe, expect, it } from 'vitest';
import { buildRankedRouteResolveResult } from '../../../../src/application/search/search-usecase-ranked-route-resolve.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
} from '../../../../src/domain/retrieval/model/dual-lane-artifact.js';
import type { SearchExecutionLaneArtifacts } from '../../../../src/application/search/search-usecase-route-dispatch.js';

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
    normalizedQuery: '와인 잘 모르는 사람한테 선물할 거 실패 없는 걸로',
    intent: 'pairing_search',
    route: 'hybrid',
    retrievalMode: 'recommendation',
    queryClass: 'semantic_preference',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'heuristic-v1.0',
  } as QueryPlanV1;
}

function makeRankedResult(
  entityId: string,
  canonicalLabel: string,
  finalScore: number,
): RankedResult {
  return {
    entityId: createEntityId(entityId),
    canonicalLabel,
    finalScore,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.5,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.5,
      availability: 1,
      uncertaintyPenalty: 0,
      giftSuitability: 0.5,
      beginnerSuitability: 0.5,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

function makeIdentityResolveResult(
  entityId: string,
  canonicalLabel: string,
  calibratedScore: number,
): EntityResolveResult {
  return {
    status: 'resolved',
    decisionConfidenceC: calibratedScore,
    topEntity: {
      entityId: createEntityId(entityId),
      canonicalLabel,
      calibratedScore,
    },
    candidates: [
      {
        entityId: createEntityId(entityId),
        canonicalLabel,
        calibratedScore,
        rank: 1,
        evidenceRefs: ['identity:1'],
      },
    ],
    decisionTrace: {
      queryClass: 'semantic_preference',
      top1CalibratedScore: calibratedScore,
      top2CalibratedScore: 0.1,
      calibratedGap: calibratedScore - 0.1,
      decisionConfidenceC: calibratedScore,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['IDENTITY_ROUTE'],
      queryProvenance: {
        anchorLookupStrategies: ['exact'],
      },
    },
    conformalSetSize: 1,
  };
}

describe('buildRankedRouteResolveResult', () => {
  it('keeps ranked-route recommendation confidence on the live top-1 posterior', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('romanee-conti-2019', 'Romanee-Conti 2019', 0.3122959942365978),
      makeRankedResult('moet-brut', 'Moet Brut', 0.3121726279785977),
      makeRankedResult('cloudy-bay-2022', 'Cloudy Bay Sauvignon Blanc 2022', 0.311609788249404),
    ];

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      executionTopology: 'general_only',
      effectiveRetrievalMode: 'recommendation',
    });

    expect(result.decisionTrace.top1CalibratedScore).toBeCloseTo(0.3122959942365978, 10);
    expect(result.decisionTrace.decisionConfidenceC).toBeCloseTo(0.3122959942365978, 10);
    expect(result.conformalSetSize).toBe(3);
  });

  it('keeps top-1 confidence semantics for entity-style ranked routes', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('opus-one-2018', 'Opus One 2018', 0.72),
      makeRankedResult('sassicaia-2018', 'Sassicaia 2018', 0.31),
    ];

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      executionTopology: 'general_only',
      effectiveRetrievalMode: 'entity_lookup',
    });

    expect(result.decisionTrace.decisionConfidenceC).toBeCloseTo(0.72, 10);
    expect(result.conformalSetSize).toBeGreaterThanOrEqual(1);
  });

  it('uses corroborated identity posterior at the ranked-route calibrator seam', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('opus-one-2018', 'Opus One 2018', 0.72),
      makeRankedResult('sassicaia-2018', 'Sassicaia 2018', 0.31),
    ];
    const identityResolveResult = makeIdentityResolveResult('opus-one-2018', 'Opus One 2018', 0.93);
    const laneArtifacts: SearchExecutionLaneArtifacts<
      EntityLaneCandidateArtifact,
      GeneralLaneCandidateArtifact,
      DualLaneArtifact
    > = {
      identity: [],
      general: [],
      fused: [
        {
          entityId: createEntityId('opus-one-2018'),
          canonicalLabel: 'Opus One 2018',
          lanePresence: 'corroborated',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: createEntityId('opus-one-2018'),
            exactnessTier: 'exact',
            calibratedScore: 0.93,
            resolverRank: 1,
            canonicalLabel: 'Opus One 2018',
            evidenceRefs: ['identity:1'],
            sourceSignals: {
              canonicalExactMatch: 1,
              canonicalNormalizedMatch: 1,
              aliasExactMatch: 0,
              aliasFuzzyMatch: 0,
              editDistanceScore: 1,
            },
          },
          fusedCandidate: {
            entityId: createEntityId('opus-one-2018'),
            canonicalLabel: 'Opus One 2018',
            retrievalTrace: {
              retrievalProfile: 'dual_lane_fusion',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
            matchedConstraints: [],
            evidenceItems: [],
          },
        },
      ],
    };

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      executionTopology: 'dual_lane',
      effectiveRetrievalMode: 'entity_lookup',
      identityCalibration: {
        identityResolveResult,
        laneArtifacts,
      },
    });

    expect(result.decisionTrace.decisionConfidenceC).toBeCloseTo(0.93, 10);
    expect(result.topEntity?.calibratedScore).toBeCloseTo(0.93, 10);
    expect(result.candidates[0]?.calibratedScore).toBeCloseTo(0.93, 10);
    expect(result.decisionTrace.outcomeReasonCodes).toContain(
      'DUAL_LANE_CORROBORATED_IDENTITY_CALIBRATED',
    );
  });

  it('allows exact identity calibration on general_only ranked routes when sidecar identity evidence is provided', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('opus-one-2018', 'Opus One 2018', 0.72),
      makeRankedResult('sassicaia-2018', 'Sassicaia 2018', 0.31),
    ];
    const identityResolveResult = makeIdentityResolveResult('opus-one-2018', 'Opus One 2018', 0.93);
    const laneArtifacts: SearchExecutionLaneArtifacts<
      EntityLaneCandidateArtifact,
      GeneralLaneCandidateArtifact,
      DualLaneArtifact
    > = {
      identity: [],
      general: [],
      fused: [
        {
          entityId: createEntityId('opus-one-2018'),
          canonicalLabel: 'Opus One 2018',
          lanePresence: 'corroborated',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: createEntityId('opus-one-2018'),
            exactnessTier: 'exact',
            calibratedScore: 0.93,
            resolverRank: 1,
            canonicalLabel: 'Opus One 2018',
            evidenceRefs: ['identity:1'],
            sourceSignals: {
              canonicalExactMatch: 1,
              canonicalNormalizedMatch: 1,
              aliasExactMatch: 0,
              aliasFuzzyMatch: 0,
              editDistanceScore: 1,
            },
          },
          fusedCandidate: {
            entityId: createEntityId('opus-one-2018'),
            canonicalLabel: 'Opus One 2018',
            retrievalTrace: {
              retrievalProfile: 'dual_lane_fusion',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
            matchedConstraints: [],
            evidenceItems: [],
          },
        },
      ],
    };

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      executionTopology: 'general_only',
      effectiveRetrievalMode: 'entity_lookup',
      identityCalibration: {
        identityResolveResult,
        laneArtifacts,
      },
    } as never);

    expect(result.decisionTrace.decisionConfidenceC).toBeCloseTo(0.93, 10);
    expect(result.topEntity?.calibratedScore).toBeCloseTo(0.93, 10);
    expect(result.decisionTrace.outcomeReasonCodes).toContain(
      'DUAL_LANE_CORROBORATED_IDENTITY_CALIBRATED',
    );
  });

  it('allows dual-lane corroboration to calibrate alias_fuzzy identity evidence', () => {
    const rankedResults: RankedResult[] = [
      makeRankedResult('chateau-margaux-2015', 'Chateau Margaux 2015', 0.49),
      makeRankedResult('opus-one-2018', 'Opus One 2018', 0.48),
    ];
    const identityResolveResult = makeIdentityResolveResult(
      'chateau-margaux-2015',
      'Chateau Margaux 2015',
      0.94,
    );
    const laneArtifacts: SearchExecutionLaneArtifacts<
      EntityLaneCandidateArtifact,
      GeneralLaneCandidateArtifact,
      DualLaneArtifact
    > = {
      identity: [],
      general: [],
      fused: [
        {
          entityId: createEntityId('chateau-margaux-2015'),
          canonicalLabel: 'Chateau Margaux 2015',
          lanePresence: 'corroborated',
          identityProvenance: {
            source: 'entity_resolver',
            entityId: createEntityId('chateau-margaux-2015'),
            exactnessTier: 'alias_fuzzy',
            calibratedScore: 0.94,
            resolverRank: 1,
            canonicalLabel: 'Chateau Margaux 2015',
            evidenceRefs: ['identity:1'],
            sourceSignals: {
              canonicalExactMatch: 0,
              canonicalNormalizedMatch: 0,
              aliasExactMatch: 0,
              aliasFuzzyMatch: 0.94,
              editDistanceScore: 0.75,
            },
          },
          fusedCandidate: {
            entityId: createEntityId('chateau-margaux-2015'),
            canonicalLabel: 'Chateau Margaux 2015',
            retrievalTrace: {
              retrievalProfile: 'dual_lane_fusion',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: [],
            },
            matchedConstraints: [],
            evidenceItems: [],
          },
        },
      ],
    };

    const result = buildRankedRouteResolveResult(makePlan(), rankedResults, {
      outcomeReasonCode: 'HYBRID_ROUTE',
      executionTopology: 'dual_lane',
      effectiveRetrievalMode: 'attribute_search',
      identityCalibration: {
        identityResolveResult,
        laneArtifacts,
      },
    });

    expect(result.decisionTrace.decisionConfidenceC).toBeCloseTo(0.94, 10);
    expect(result.topEntity?.calibratedScore).toBeCloseTo(0.94, 10);
    expect(result.decisionTrace.outcomeReasonCodes).toContain(
      'DUAL_LANE_CORROBORATED_IDENTITY_CALIBRATED',
    );
  });
});
