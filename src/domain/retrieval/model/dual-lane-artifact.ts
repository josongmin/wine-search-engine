import type { AliasType } from '../../alias/model/alias.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { EntityCandidateSource } from '../../resolver/model/entity-candidate-generator-input.js';
import type {
  ResolvedCandidate,
  ResolverCandidate,
} from '../../resolver/model/resolved-candidate.js';
import type { CanonicalEntityId, EvidenceItem } from '../../shared/types/index.js';
import type { HybridCandidate } from './hybrid-candidate.js';

export type DualLanePresence =
  | 'corroborated'
  | 'entity_only'
  | 'general_only';

export type IdentityExactnessTier =
  | 'exact'
  | 'alias_exact'
  | 'alias_fuzzy'
  | 'none';

export interface IdentityAliasMatchProvenance {
  readonly aliasValue: string;
  readonly aliasType: AliasType;
  readonly matchScore: number;
}

export interface IdentityProvenanceSignalSnapshot {
  readonly canonicalExactMatch: number;
  readonly canonicalNormalizedMatch: number;
  readonly aliasExactMatch: number;
  readonly aliasFuzzyMatch: number;
  readonly editDistanceScore: number;
}

export interface IdentityLaneProvenance {
  readonly source: 'entity_resolver';
  readonly entityId: CanonicalEntityId;
  readonly exactnessTier: IdentityExactnessTier;
  readonly calibratedScore: number;
  readonly resolverRank: number;
  readonly canonicalLabel: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceSignals: IdentityProvenanceSignalSnapshot;
  readonly strongestAliasMatch?: IdentityAliasMatchProvenance | undefined;
  readonly candidateSources?: readonly EntityCandidateSource[] | undefined;
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
}

export interface EntityLaneCandidateArtifact {
  readonly entityId: CanonicalEntityId;
  readonly candidate: HybridCandidate;
  readonly resolvedCandidate: ResolvedCandidate;
  readonly rawCandidate?: ResolverCandidate | undefined;
  readonly identityProvenance: IdentityLaneProvenance;
  readonly evidenceItems: readonly EvidenceItem[];
}

export interface GeneralLaneCandidateArtifact {
  readonly entityId: CanonicalEntityId;
  readonly candidate: HybridCandidate;
  readonly rank: number;
}

interface DualLaneAgreement {
  readonly corroborated: boolean;
  readonly disagreement: boolean;
  readonly entityOnly: boolean;
  readonly generalOnly: boolean;
}

export interface DualLaneArtifact {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel: string;
  readonly lanePresence: DualLanePresence;
  readonly identityProvenance?: IdentityLaneProvenance | undefined;
  readonly entityLane?: EntityLaneCandidateArtifact | undefined;
  readonly generalLane?: GeneralLaneCandidateArtifact | undefined;
  readonly fusedCandidate: HybridCandidate;
}

export function buildDualLaneAgreement(
  lanePresence: DualLanePresence,
): DualLaneAgreement {
  return {
    corroborated: lanePresence === 'corroborated',
    disagreement: lanePresence !== 'corroborated',
    entityOnly: lanePresence === 'entity_only',
    generalOnly: lanePresence === 'general_only',
  };
}
