import type { CanonicalEntityId } from '../../../src/domain/shared/types/index.js';
import type { LookupResolverProjectionPort } from '../../../src/application/search/port/search-pipeline-deps.port.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';

interface SearchIndexDocumentLookup {
  getDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>>;
}

export function buildResolverProjectionLookupFromSearchIndex(
  searchIndex: SearchIndexDocumentLookup,
): LookupResolverProjectionPort {
  return {
    getResolverProjections: async (entityIds: readonly CanonicalEntityId[]) => {
      const docs = await searchIndex.getDocuments(entityIds);
      const projections = new Map<CanonicalEntityId, {
        entityId: CanonicalEntityId;
        entityType: string;
        canonicalLabel: string;
        aliasesIdentitySafe: readonly string[];
        identitySafeKeys: readonly string[];
      }>();
      for (const [entityId, doc] of docs) {
        projections.set(entityId, {
          entityId,
          entityType: doc.entityType,
          canonicalLabel: doc.canonicalLabel,
          aliasesIdentitySafe: [],
          identitySafeKeys: [],
        });
      }
      return projections;
    },
  };
}
