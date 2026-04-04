import type { EntityId } from '../../shared/types/index.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';

/**
 * A single hit from the sparse (BM25 / lexical) retrieval pass.
 */
export interface SparseHit {
  /** Entity identifier. */
  readonly entityId: EntityId;

  /** Raw BM25 or equivalent score. */
  readonly score: number;

  /** 1-based rank within the sparse result list. */
  readonly rank: number;

  /** Index fields that contributed to the match. */
  readonly matchedFields: readonly string[];
}

/**
 * A single hit from the dense (embedding / ANN) retrieval pass.
 */
export interface DenseHit {
  /** Entity identifier. */
  readonly entityId: EntityId;

  /** Raw score from the ANN index. */
  readonly score: number;

  /** 1-based rank within the dense result list. */
  readonly rank: number;

  /** Cosine or dot-product similarity in [0, 1]. */
  readonly similarity: number;
}

/**
 * Port (driven side) for interacting with the search index infrastructure.
 *
 * Implementations may target Vespa, Elasticsearch, Meilisearch, or any
 * hybrid index that supports both sparse and dense retrieval.
 */
export interface SearchIndexPort {
  /**
   * Execute a sparse (BM25 / lexical) search.
   *
   * @param queries - One or more query strings to match against text fields.
   * @param filters - Optional filter expressions to narrow the candidate set.
   * @param limit - Maximum number of hits to return (default: implementation-defined).
   * @returns Sparse hits sorted by descending score.
   */
  sparseSearch(
    queries: readonly string[],
    filters?: readonly string[],
    limit?: number,
  ): Promise<readonly SparseHit[]>;

  /**
   * Execute a dense (embedding / ANN) search.
   *
   * @param embedding - Query embedding vector.
   * @param filters - Optional filter expressions to narrow the candidate set.
   * @param limit - Maximum number of hits to return.
   * @returns Dense hits sorted by descending similarity.
   */
  denseSearch(
    embedding: readonly number[],
    filters?: readonly string[],
    limit?: number,
  ): Promise<readonly DenseHit[]>;

  /**
   * Retrieve a single document by entity ID.
   *
   * @param entityId - The entity to fetch.
   * @returns The document, or `null` if not found.
   */
  getDocument(entityId: EntityId): Promise<RetrievalDocument | null>;

  /**
   * Insert or update a single document in the index.
   *
   * @param doc - The document to upsert.
   */
  upsertDocument(doc: RetrievalDocument): Promise<void>;

  /**
   * Insert or update multiple documents in the index.
   *
   * @param docs - The documents to upsert.
   */
  bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void>;
}
