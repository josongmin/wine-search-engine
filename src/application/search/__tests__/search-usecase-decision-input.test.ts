import { describe, expect, it } from 'vitest';
import { buildSearchDecisionInput } from '../search-usecase-decision-input.js';
import {
  hasExactMatchCandidate,
  hasIdentityEvidence,
} from '../../../domain/decision/model/decision-input.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { DualLaneArtifact } from '../../../domain/retrieval/model/dual-lane-artifact.js';

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: 'opus one',
    normalizedQuery: 'opus one',
    intent: 'entity_exact',
    route: 'hybrid',
    retrievalMode: 'hybrid',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: true,
      allowApproximate: false,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.9,
      constraintConfidence: 0.9,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
  };
}

function makeResolveResult(entityId: string, outcomeReasonCodes: readonly string[] = []): EntityResolveResult {
  return {
    status: 'resolved',
    topEntity: {
      entityId: createEntityId(entityId),
      canonicalLabel: entityId,
      calibratedScore: 0.97,
    },
    candidates: [{
      entityId: createEntityId(entityId),
      canonicalLabel: entityId,
      calibratedScore: 0.97,
      rank: 1,
      evidenceRefs: ['alias:match'],
    }],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: 0.97,
      top2CalibratedScore: 0.1,
      calibratedGap: 0.87,
      decisionConfidenceC: 0.97,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.03 },
      outcomeReasonCodes,
      queryProvenance: {
        anchorLookupStrategies: ['exact'],
      },
    },
    conformalSetSize: 1,
  };
}

function makeIdentityResolveResult(
  topEntityId: string,
  candidateEntityIds: readonly string[],
  anchorLookupStrategies: readonly string[],
): EntityResolveResult {
  return {
    status: 'resolved',
    topEntity: {
      entityId: createEntityId(topEntityId),
      canonicalLabel: topEntityId,
      calibratedScore: 0.95,
    },
    candidates: candidateEntityIds.map((entityId, index) => ({
      entityId: createEntityId(entityId),
      canonicalLabel: entityId,
      calibratedScore: 0.95 - index * 0.1,
      rank: index + 1,
      evidenceRefs: [`alias:${entityId}`],
    })),
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: 0.95,
      top2CalibratedScore: 0.85,
      calibratedGap: 0.1,
      decisionConfidenceC: 0.95,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.03 },
      outcomeReasonCodes: [],
      queryProvenance: {
        anchorLookupStrategies,
      },
    },
    conformalSetSize: 1,
  };
}

function makeRankedTop(entityId: string): RankedResult {
  return {
    entityId: createEntityId(entityId),
    canonicalLabel: entityId,
    finalScore: 0.91,
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [{
      type: 'identity',
      source: 'test',
      contribution: '+0.91',
      strength: 'high',
      provenance: 'test identity evidence',
    }],
    componentScores: {
      entityIntegrity: 1,
      hardConstraintPass: true,
      softConstraint: 0,
      semantic: 0.91,
      preferenceAlignment: 0,
      popularity: 0,
      availability: 0,
      uncertaintyPenalty: 0,
    },
  } as RankedResult;
}

describe('buildSearchDecisionInput', () => {
  it('does not mint identity or exact evidence from ranked synthetic resolve alone', () => {
    const input = buildSearchDecisionInput({
      plan: makePlan(),
      resolveResult: makeResolveResult('entity-ranked', ['HYBRID_ROUTE']),
      rankedResults: [makeRankedTop('entity-ranked')],
      effectiveRoute: 'hybrid',
    });

    expect(hasIdentityEvidence(input.evidenceSummary)).toBe(false);
    expect(hasExactMatchCandidate(input.evidenceSummary)).toBe(false);
  });

  it('does not recover exact identity evidence from query-level lookup strategy alone', () => {
    const input = buildSearchDecisionInput({
      plan: makePlan(),
      resolveResult: makeResolveResult('entity-identity'),
      identityResolveResult: makeResolveResult('entity-identity'),
      rankedResults: [makeRankedTop('entity-other')],
      effectiveRoute: 'hybrid',
    });

    expect(hasIdentityEvidence(input.evidenceSummary)).toBe(true);
    expect(hasExactMatchCandidate(input.evidenceSummary)).toBe(false);
  });

  it('prefers dual-lane artifact exactness over query-level lookup strategy when fused winner is not identity top1', () => {
    const resolveResult = makeResolveResult('entity-winner');
    const identityResolveResult = makeIdentityResolveResult(
      'entity-other',
      ['entity-other', 'entity-winner'],
      ['fuzzy_char_ngram'],
    );
    const winnerDualLaneArtifact: DualLaneArtifact = {
      entityId: createEntityId('entity-winner'),
      canonicalLabel: 'entity-winner',
      lanePresence: 'entity_only',
      agreement: {
        corroborated: false,
        disagreement: true,
        entityOnly: true,
        generalOnly: false,
      },
      exactnessTier: 'alias_exact',
      identityProvenance: {
        source: 'entity_resolver',
        entityId: createEntityId('entity-winner'),
        exactnessTier: 'alias_exact',
        calibratedScore: 0.85,
        resolverRank: 2,
        canonicalLabel: 'entity-winner',
        evidenceRefs: ['alias:entity-winner'],
        sourceSignals: {
          canonicalExactMatch: 0,
          canonicalNormalizedMatch: 0,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          editDistanceScore: 0,
        },
      },
      fusedCandidate: {
        entityId: createEntityId('entity-winner'),
        canonicalLabel: 'entity-winner',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'test',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: [],
        },
      },
    };

    const input = buildSearchDecisionInput({
      plan: makePlan(),
      resolveResult,
      identityResolveResult,
      rankedResults: [makeRankedTop('entity-winner')],
      effectiveRoute: 'hybrid',
      executionContext: {
        winnerDualLaneArtifact,
      },
    });

    expect(input.evidenceSummary?.identityEvidence?.lanePresence).toBe('entity_only');
    expect(input.evidenceSummary?.identityEvidence?.exactnessTier).toBe('alias_exact');
    expect(hasIdentityEvidence(input.evidenceSummary)).toBe(true);
    expect(hasExactMatchCandidate(input.evidenceSummary)).toBe(true);
  });

  it('does not mint identity evidence from a dual-lane artifact that is misaligned with the fused winner', () => {
    const winnerDualLaneArtifact: DualLaneArtifact = {
      entityId: createEntityId('entity-other'),
      canonicalLabel: 'entity-other',
      lanePresence: 'entity_only',
      agreement: {
        corroborated: false,
        disagreement: true,
        entityOnly: true,
        generalOnly: false,
      },
      exactnessTier: 'alias_exact',
      identityProvenance: {
        source: 'entity_resolver',
        entityId: createEntityId('entity-other'),
        exactnessTier: 'alias_exact',
        calibratedScore: 0.85,
        resolverRank: 1,
        canonicalLabel: 'entity-other',
        evidenceRefs: ['alias:entity-other'],
        sourceSignals: {
          canonicalExactMatch: 0,
          canonicalNormalizedMatch: 0,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          editDistanceScore: 0,
        },
      },
      fusedCandidate: {
        entityId: createEntityId('entity-other'),
        canonicalLabel: 'entity-other',
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'test',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: [],
        },
      },
    };

    const input = buildSearchDecisionInput({
      plan: makePlan(),
      resolveResult: makeResolveResult('entity-winner'),
      identityResolveResult: makeIdentityResolveResult(
        'entity-other',
        ['entity-other'],
        ['exact'],
      ),
      rankedResults: [makeRankedTop('entity-winner')],
      effectiveRoute: 'hybrid',
      executionContext: {
        winnerDualLaneArtifact,
      },
    });

    expect(input.evidenceSummary?.identityEvidence?.winnerIdentityArtifactPresent).toBe(false);
    expect(input.evidenceSummary?.identityEvidence?.lanePresence).toBeUndefined();
    expect(input.evidenceSummary?.identityEvidence?.exactnessTier).toBe('none');
    expect(hasIdentityEvidence(input.evidenceSummary)).toBe(false);
    expect(hasExactMatchCandidate(input.evidenceSummary)).toBe(false);
  });
});
