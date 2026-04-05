import type { EntityId } from '../../shared/types/index.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { AnchorProfile } from '../model/anchor-profile.js';
import type { AnchorEntityData } from '../service/anchor-profiler.js';
import type { SimilarityCandidate } from '../service/similarity-scorer.js';

/**
 * Port for resolving an anchor entity from an entity ID.
 */
export interface AnchorResolverPort {
  resolve(entityId: EntityId): Promise<AnchorEntityData | undefined>;
}

/**
 * Port for retrieving candidates similar to an anchor entity.
 */
export interface SimilarRetrievalPort {
  retrieveSimilar(
    anchorProfile: AnchorProfile,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}

/**
 * Port for retrieving candidate attribute data for constraint evaluation.
 */
export interface CandidateAttributePort {
  loadAttributes(
    entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>>;

  loadSimilarityCandidate(
    entityId: EntityId,
  ): Promise<SimilarityCandidate | undefined>;
}
