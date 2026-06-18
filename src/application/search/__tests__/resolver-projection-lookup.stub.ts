import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import type { LookupResolverProjectionPort } from '../port/search-pipeline-deps.port.js';

/**
 * Test-only batch document lookup for {@link wrapEntityDocumentBatchLookupAsResolverProjection}.
 * Production hydration uses {@link LookupResolverProjectionPort} directly.
 */
export interface EntityDocumentBatchLookup {
  getDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>>;
}

export function emptyEntityDocumentBatchLookup(): EntityDocumentBatchLookup {
  return {
    getDocuments: async () => new Map(),
  };
}

export function makeEntityDocumentBatchLookup(
  resolve: (id: CanonicalEntityId) => Promise<RetrievalDocument | null>,
): EntityDocumentBatchLookup {
  return {
    getDocuments: async (entityIds) => {
      const projections = new Map<CanonicalEntityId, RetrievalDocument>();
      for (const entityId of entityIds) {
        const doc = await resolve(entityId);
        if (doc != null) {
          projections.set(entityId, doc);
        }
      }
      return projections;
    },
  };
}

export function makeEntityDocumentBatchLookupFromEntries(
  entries: ReadonlyArray<readonly [string, string]>,
): EntityDocumentBatchLookup {
  const labelById = new Map(entries);
  return makeEntityDocumentBatchLookup(async (entityId) => {
    const label = labelById.get(String(entityId));
    if (label == null) {
      return null;
    }
    return {
      entityId,
      entityType: 'wine',
      canonicalLabel: label,
    };
  });
}

export function makeUniformEntityDocumentBatchLookup(
  canonicalLabel: string,
  entityType = 'wine',
): EntityDocumentBatchLookup {
  return {
    getDocuments: async (entityIds) => {
      const docs = new Map<CanonicalEntityId, RetrievalDocument>();
      for (const entityId of entityIds) {
        docs.set(entityId, { entityId, entityType, canonicalLabel });
      }
      return docs;
    },
  };
}

/**
 * Test helper: adapt a batch entity-document lookup port into resolver projection
 * hydration for {@link buildResolverCandidatesFromGenerator}.
 */
export function wrapEntityDocumentBatchLookupAsResolverProjection(
  lookup: EntityDocumentBatchLookup,
): LookupResolverProjectionPort {
  return {
    getResolverProjections: async (entityIds: readonly CanonicalEntityId[]) => {
      const docs = await lookup.getDocuments(entityIds);
      const projections = new Map<CanonicalEntityId, {
        entityId: CanonicalEntityId;
        entityType: string;
        canonicalLabel: string;
        aliasesIdentitySafe: readonly string[];
        identitySafeKeys: readonly string[];
        producer?: string;
        attributeHints?: Readonly<Record<string, unknown>>;
        sourceRecordRefs?: RetrievalDocument['sourceRecordRefs'];
        identityCertificates?: RetrievalDocument['identityCertificates'];
      }>();
      for (const [entityId, doc] of docs) {
        projections.set(entityId, {
          entityId,
          entityType: doc.entityType,
          canonicalLabel: doc.canonicalLabel,
          ...(Array.isArray(doc.aliasesIdentitySafe) ? { aliasesIdentitySafe: doc.aliasesIdentitySafe } : {}),
          ...(Array.isArray(doc.identitySafeKeys) ? { identitySafeKeys: doc.identitySafeKeys } : {}),
          ...(doc.producer !== undefined ? { producer: doc.producer } : {}),
          ...(doc.attributeHints !== undefined ? { attributeHints: doc.attributeHints } : {}),
          ...(doc.sourceRecordRefs !== undefined ? { sourceRecordRefs: doc.sourceRecordRefs } : {}),
          ...(doc.identityCertificates !== undefined
            ? { identityCertificates: doc.identityCertificates }
            : {}),
        });
      }
      return projections;
    },
  };
}
