import type { CanonicalEntityId } from '../../shared/types/index.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
  RetrievalHitProjection,
} from '../model/retrieval-document.js';

/**
 * Summary fields from an index hit, used for cross-encoder passages and display.
 * Populated when the backend returns document summaries alongside scores.
 *
 * Extends {@link RetrievalHitProjection} for structural alignment.
 * Overrides `entityId` to optional: summaries carry partial document data and
 * entity identity is provided separately by {@link RetrievalSummaryCarrier}.
 *
 * Includes wine attributes for Epic 15 (drinking window prediction).
 */
export interface RetrievalHitSummary extends Omit<RetrievalHitProjection, 'entityId'> {
  readonly entityId?: CanonicalEntityId | undefined;
  readonly canonicalLabel?: string;
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly searchTextKo?: string;
  readonly semanticSummary?: string;
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
  readonly flavorProfiles?: readonly string[] | undefined;
  readonly soilType?: string | undefined;
  readonly producerType?: string | undefined;
  readonly grapeFamily?: string | undefined;
  readonly regionHierarchy?: readonly string[] | undefined;
  readonly priceBandNumeric?: number | undefined;
  readonly giftSuitabilityScore?: number | undefined;
  readonly beginnerSuitabilityScore?: number | undefined;
}

export const RETRIEVAL_HIT_SUMMARY_KEYS = [
  'canonicalLabel',
  'producer',
  'region',
  'searchTextEn',
  'searchTextKo',
  'semanticSummary',
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
  'flavorProfiles',
  'soilType',
  'producerType',
  'grapeFamily',
  'regionHierarchy',
  'priceBandNumeric',
  'giftSuitabilityScore',
  'beginnerSuitabilityScore',
] as const satisfies readonly (keyof RetrievalHitSummary)[];

export type RetrievalHitSummaryKey = (typeof RETRIEVAL_HIT_SUMMARY_KEYS)[number];

export interface RetrievalSummaryCarrier {
  readonly entityId: CanonicalEntityId;
  readonly summary?: RetrievalHitSummary;
}

/**
 * A single hit from the sparse (BM25 / lexical) retrieval pass.
 */
export interface SparseHit extends RetrievalSummaryCarrier {
  /** Entity identifier. */
  readonly entityId: CanonicalEntityId;

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
export interface DenseHit extends RetrievalSummaryCarrier {
  /** Entity identifier. */
  readonly entityId: CanonicalEntityId;

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
   * @param rankProfile - Optional backend-native rank profile for mode-specific retrieval tuning.
   * @param requestId - Optional request identifier forwarded as `X-Request-Id` to downstream services.
   * @returns Sparse hits sorted by descending score.
   */
  sparseSearch(
    queries: readonly string[],
    filters?: readonly string[],
    limit?: number,
    rankProfile?: string,
    requestId?: string,
  ): Promise<readonly SparseHit[]>;

  /**
   * Execute a dense (embedding / ANN) search.
   *
   * @param embedding - Query embedding vector.
   * @param filters - Optional filter expressions to narrow the candidate set.
   * @param limit - Maximum number of hits to return.
   * @param rankProfile - Optional backend-native rank profile for mode-specific retrieval tuning.
   * @param requestId - Optional request identifier forwarded as `X-Request-Id` to downstream services.
   * @returns Dense hits sorted by descending similarity.
   */
  denseSearch(
    embedding: readonly number[],
    filters?: readonly string[],
    limit?: number,
    rankProfile?: string,
    requestId?: string,
  ): Promise<readonly DenseHit[]>;

  /**
   * Execute a learned-sparse (SPLADE-style) retrieval pass.
   *
   * Queries the `learned_sparse_weights` mapped tensor field in the index
   * using a `dotProduct` operator. Returns results in {@link DenseHit}
   * format so they can be fused alongside dense ANN hits.
   *
   * @param queryWeights - Token → weight pairs produced by the sparse encoder.
   *   When empty, the implementation must return `[]` immediately (no I/O).
   * @param filters - Optional filter expressions to narrow the candidate set.
   * @param limit - Maximum number of hits to return.
   * @param requestId - Optional request identifier forwarded as `X-Request-Id` to downstream services for distributed tracing.
   * @returns Hits sorted by descending learned-sparse score, shaped as DenseHit.
   */
  searchLearnedSparse(
    queryWeights: readonly { token: string; weight: number }[],
    filters?: readonly string[],
    limit?: number,
    requestId?: string,
  ): Promise<readonly DenseHit[]>;

  /**
   * Retrieve a single document by entity ID.
   *
   * @param entityId - The entity to fetch.
   * @returns The document, or `null` if not found.
   */
  getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null>;

  /**
   * Retrieve multiple documents by entity IDs.
   *
   * Returned map contains only found documents; missing IDs are omitted.
   * Implementations MUST prefer backend-native batching over N single fetches.
   *
   * T-E4-01: Elevated to required -- entity route batch hydration depends on this.
   */
  getDocuments(entityIds: readonly CanonicalEntityId[]): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>>;

  /**
   * Batch-fetch the exact fields required by drinkability checks.
   *
   * This narrow projection is keyed by public `entity_id` and must not require
   * full document hydration; agent drinkability is a metadata lookup, not a
   * display/search document reconstruction path.
   */
  getDrinkingWindowDocuments?(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDrinkingWindowProjection>>;

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
