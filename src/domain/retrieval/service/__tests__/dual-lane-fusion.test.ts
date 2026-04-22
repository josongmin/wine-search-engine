import { describe, expect, it } from 'vitest';
import { createCanonicalEntityId } from '../../../shared/types/index.js';
import type { EntityLaneCandidateArtifact } from '../../model/dual-lane-artifact.js';
import type { HybridCandidate } from '../../model/hybrid-candidate.js';
import { fuseDualLaneArtifacts } from '../dual-lane-fusion.js';

const ENTITY_A = createCanonicalEntityId('wine-a');
const ENTITY_B = createCanonicalEntityId('wine-b');
const ENTITY_C = createCanonicalEntityId('wine-c');

function makeGeneralCandidate(
  entityId: string,
  overrides: Partial<HybridCandidate> = {},
): HybridCandidate {
  return {
    entityId: createCanonicalEntityId(entityId),
    canonicalLabel: `${entityId} general`,
    fusionRrfTotal: 0.25,
    sparseRank: 1,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'fusion',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['sparse_bm25'],
    },
    ...overrides,
  };
}

function makeEntityArtifact(
  entityId: string,
  overrides: Partial<EntityLaneCandidateArtifact> = {},
): EntityLaneCandidateArtifact {
  return {
    entityId: createCanonicalEntityId(entityId),
    candidate: {
      entityId: createCanonicalEntityId(entityId),
      canonicalLabel: `${entityId} entity`,
      matchedConstraints: ['producer'],
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
      laneCorroborated: false,
      laneDisagreement: true,
    },
    resolvedCandidate: {
      entityId: createCanonicalEntityId(entityId),
      canonicalLabel: `${entityId} entity`,
      calibratedScore: 0.97,
      rank: 1,
      evidenceRefs: [`resolver:${entityId}`],
    },
    identityProvenance: {
      source: 'entity_resolver',
      entityId: createCanonicalEntityId(entityId),
      exactnessTier: 'exact',
      calibratedScore: 0.97,
      resolverRank: 1,
      canonicalLabel: `${entityId} entity`,
      evidenceRefs: [`resolver:${entityId}`],
      sourceSignals: {
        canonicalExactMatch: 1,
        canonicalNormalizedMatch: 1,
        aliasExactMatch: 1,
        aliasFuzzyMatch: 0,
        editDistanceScore: 0,
      },
    },
    evidenceItems: [],
    ...overrides,
  };
}

describe('fuseDualLaneArtifacts', () => {
  it('deduplicates by entityId and emits corroborated artifacts when both lanes agree', () => {
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact(String(ENTITY_A))],
      generalLaneCandidates: [makeGeneralCandidate(String(ENTITY_A))],
    });

    expect(result.laneArtifacts).toHaveLength(1);
    expect(result.fusedCandidates).toHaveLength(1);
    expect(result.laneArtifacts[0]).toMatchObject({
      entityId: ENTITY_A,
      lanePresence: 'corroborated',
      exactnessTier: 'exact',
      agreement: {
        corroborated: true,
        disagreement: false,
        entityOnly: false,
        generalOnly: false,
      },
    });
    expect(result.fusedCandidates[0]?.lanePresence).toBe('corroborated');
    expect(result.fusedCandidates[0]?.laneCorroborated).toBe(true);
    expect(result.fusedCandidates[0]?.entityPosteriorScore).toBe(0.97);
    expect(result.fusedCandidates[0]?.identityExactnessTier).toBe('exact');
    expect(result.fusedCandidates[0]?.retrievalTrace.candidateSources).toEqual([
      'sparse_bm25',
      'entity_resolver',
    ]);
  });

  it('preserves general-lane order and appends entity-only artifacts by resolver rank', () => {
    const entityB = makeEntityArtifact(String(ENTITY_B));
    const entityC = makeEntityArtifact(String(ENTITY_C));
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [
        {
          ...entityB,
          resolvedCandidate: {
            ...entityB.resolvedCandidate,
            rank: 2,
          },
          identityProvenance: {
            ...entityB.identityProvenance,
            resolverRank: 2,
          },
        },
        {
          ...entityC,
          resolvedCandidate: {
            ...entityC.resolvedCandidate,
            rank: 1,
          },
          identityProvenance: {
            ...entityC.identityProvenance,
            resolverRank: 1,
          },
        },
      ],
      generalLaneCandidates: [makeGeneralCandidate(String(ENTITY_A))],
    });

    expect(result.fusedCandidates.map((candidate) => candidate.entityId)).toEqual([
      ENTITY_A,
      ENTITY_C,
      ENTITY_B,
    ]);
    expect(result.laneArtifacts[0]?.lanePresence).toBe('general_only');
    expect(result.laneArtifacts[1]?.lanePresence).toBe('entity_only');
    expect(result.laneArtifacts[2]?.lanePresence).toBe('entity_only');
  });

  it('marks general-only candidates with none exactness and disagreement', () => {
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [],
      generalLaneCandidates: [makeGeneralCandidate(String(ENTITY_A))],
    });

    expect(result.laneArtifacts[0]).toMatchObject({
      lanePresence: 'general_only',
      exactnessTier: 'none',
      agreement: {
        corroborated: false,
        disagreement: true,
        entityOnly: false,
        generalOnly: true,
      },
    });
    expect(result.fusedCandidates[0]?.identityExactnessTier).toBe('none');
    expect(result.fusedCandidates[0]?.laneDisagreement).toBe(true);
  });
});
