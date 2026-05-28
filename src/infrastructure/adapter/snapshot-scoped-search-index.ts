import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';

interface SnapshotScopedSearchIndexDeps {
  readonly inner: SearchIndexPort;
  readonly snapshotId: string;
}

const SEARCH_SNAPSHOT_FILTER_KEY = 'search_snapshot_id:';

export class SnapshotScopedSearchIndex implements SearchIndexPort {
  private readonly inner: SearchIndexPort;
  private readonly snapshotId: string;

  constructor(deps: SnapshotScopedSearchIndexDeps) {
    this.inner = deps.inner;
    this.snapshotId = deps.snapshotId;
  }

  sparseSearch(
    queries: readonly string[],
    filters?: readonly string[],
    limit?: number,
    rankProfile?: string,
    requestId?: string,
  ) {
    return this.inner.sparseSearch(
      queries,
      this.mergeSnapshotFilters(filters),
      limit,
      rankProfile,
      requestId,
    );
  }

  denseSearch(
    embedding: readonly number[],
    filters?: readonly string[],
    limit?: number,
    rankProfile?: string,
    requestId?: string,
  ) {
    return this.inner.denseSearch(
      embedding,
      this.mergeSnapshotFilters(filters),
      limit,
      rankProfile,
      requestId,
    );
  }

  searchLearnedSparse(
    queryWeights: readonly { token: string; weight: number }[],
    filters?: readonly string[],
    limit?: number,
    requestId?: string,
  ) {
    return this.inner.searchLearnedSparse(
      queryWeights,
      this.mergeSnapshotFilters(filters),
      limit,
      requestId,
    );
  }

  getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null> {
    return this.inner.getDocument(entityId);
  }

  getDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>> {
    return this.inner.getDocuments(entityIds);
  }

  getDrinkingWindowDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDrinkingWindowProjection>> {
    if (this.inner.getDrinkingWindowDocuments === undefined) {
      throw new Error(
        'getDrinkingWindowDocuments: inner search index does not implement drinking-window projection',
      );
    }
    return this.inner.getDrinkingWindowDocuments(entityIds);
  }

  upsertDocument(doc: RetrievalDocument): Promise<void> {
    return this.inner.upsertDocument(doc);
  }

  bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void> {
    return this.inner.bulkUpsert(docs);
  }

  private mergeSnapshotFilters(filters: readonly string[] | undefined): readonly string[] {
    const targetToken = `${SEARCH_SNAPSHOT_FILTER_KEY}${this.snapshotId}`;
    const normalizedFilters = filters ?? [];
    const snapshotTokens = normalizedFilters.filter((token) =>
      token.startsWith(SEARCH_SNAPSHOT_FILTER_KEY),
    );
    if (snapshotTokens.some((token) => token !== targetToken)) {
      throw new Error(
        `SnapshotScopedSearchIndex received conflicting search_snapshot_id filter(s): ${snapshotTokens.join(', ')}`,
      );
    }
    if (snapshotTokens.length > 0) {
      return normalizedFilters;
    }
    return [...normalizedFilters, targetToken];
  }
}
