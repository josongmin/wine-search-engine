import type { EntityId } from '../../shared/types/index.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';

/**
 * Summary fields from an index hit, used for cross-encoder passages and display.
 * Populated when the backend returns document summaries alongside scores.
 *
 * Includes wine attributes for Epic 15 (drinking window prediction).
 */
export interface RetrievalHitSummary {
  readonly canonicalLabel?: string;
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly grapePrimary?: string;
  readonly style?: string | undefined;
  readonly priceBand?: string | undefined;
  readonly pairing?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;

  // Epic 15: Wine attributes for dynamic prediction
  readonly vintageYear?: number | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly finishLength?: number | undefined;
  readonly wineType?: string | undefined;
  readonly criticScoreNormalized?: number | undefined;
  /** Producer prestige score from the index (scale varies; browse uses it for ranking only). */
  readonly producerPrestige?: number | undefined;
  readonly country?: string | undefined;
  readonly appellation?: string | undefined;
  readonly classification?: string | undefined;
  readonly alcoholPct?: number | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;
  readonly priceUsd?: number | undefined;
  readonly certifications?: readonly string[] | undefined;
  readonly soilType?: string | undefined;
  readonly producerType?: string | undefined;
}

export const RETRIEVAL_HIT_SUMMARY_KEYS = [
  'canonicalLabel',
  'producer',
  'region',
  'searchTextEn',
  'grapePrimary',
  'style',
  'priceBand',
  'pairing',
  'occasion',
  'vintageYear',
  'body',
  'tannin',
  'acidity',
  'sweetness',
  'finishLength',
  'wineType',
  'criticScoreNormalized',
  'producerPrestige',
  'country',
  'appellation',
  'classification',
  'alcoholPct',
  'drinkingWindowStart',
  'drinkingWindowEnd',
  'drinkingWindowModelVersion',
  'priceUsd',
  'certifications',
  'soilType',
  'producerType',
] as const satisfies readonly (keyof RetrievalHitSummary)[];

export type RetrievalHitSummaryKey = (typeof RETRIEVAL_HIT_SUMMARY_KEYS)[number];

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

  /** Optional document summary for reranking / UX. */
  readonly summary?: RetrievalHitSummary;
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

  /** Optional document summary for reranking / UX. */
  readonly summary?: RetrievalHitSummary;
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
