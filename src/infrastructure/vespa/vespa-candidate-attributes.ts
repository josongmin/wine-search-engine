import type { EntityId } from '../../domain/shared/types/index.js';
import type { CandidateAttributePort } from '../../domain/mixed/service/mixed-solver.js';
import type { SimilarityCandidate } from '../../domain/mixed/service/similarity-scorer.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';

/**
 * Vespa-backed implementation of {@link CandidateAttributePort}.
 *
 * Fetches full {@link RetrievalDocument}s from the Vespa index in parallel
 * and maps them to the attribute contracts expected by the mixed-query domain.
 */
export class VespaCandidateAttributes implements CandidateAttributePort {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  async loadAttributes(
    entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>> {
    if (entityIds.length === 0) {
      return new Map();
    }

    const map = new Map<EntityId, Readonly<Record<string, unknown>>>();

    // Epic-07 T07-2: prefer backend-native batch fetch over N single GETs.
    // Falls back to per-id concurrent fetches when the adapter doesn't
    // implement the optional `getDocuments` contract (e.g. in tests).
    if (this.searchIndex.getDocuments !== undefined) {
      const docs = await this.searchIndex.getDocuments(entityIds);
      for (const [id, doc] of docs) {
        map.set(id, doc as unknown as Record<string, unknown>);
      }
      return map;
    }

    const entries = await Promise.all(
      entityIds.map(async (id) => {
        const doc = await this.searchIndex.getDocument(id);
        return { id, doc };
      }),
    );
    for (const { id, doc } of entries) {
      if (doc !== null) {
        map.set(id, doc as unknown as Record<string, unknown>);
      }
    }
    return map;
  }

  async loadSimilarityCandidate(
    entityId: EntityId,
  ): Promise<SimilarityCandidate | undefined> {
    const doc = await this.searchIndex.getDocument(entityId);
    if (doc === null) return undefined;

    return {
      region: doc.region,
      grapes: doc.grapes,
      body: doc.body,
      sweetness: doc.sweetness,
      style: doc.style,
      ...(doc.embedding !== undefined ? { embedding: doc.embedding } : {}),
    };
  }
}
