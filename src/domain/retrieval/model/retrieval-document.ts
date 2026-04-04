import type { EntityId } from '../../shared/types/index.js';

/**
 * Projection schema for a document stored in the search index (RFC-012 S11).
 *
 * This represents the complete set of fields that the retrieval layer
 * indexes and queries. It is the contract between the ingestion pipeline
 * and the search infrastructure.
 */
export interface RetrievalDocument {
  /** Unique entity identifier. */
  readonly entityId: EntityId;

  /** Entity type discriminator (e.g. "wine", "producer"). */
  readonly entityType: string;

  /** Canonical display label (e.g. "Opus One 2018"). */
  readonly canonicalLabel: string;

  /** Identity-safe aliases — high-precision matches only. */
  readonly aliasesIdentitySafe: readonly string[];

  /** Noisy-recall aliases — broader recall, lower precision. */
  readonly aliasesNoisyRecall: readonly string[];

  /** Producer / winery name. */
  readonly producer: string;

  /** Region of origin. */
  readonly region: string;

  /** Grape varieties used. */
  readonly grapes: readonly string[];

  /** Full-text search field in Korean. */
  readonly searchTextKo: string;

  /** Full-text search field in English. */
  readonly searchTextEn: string;

  /** Natural-language summary used for semantic embedding. */
  readonly semanticSummary: string;

  /** Body score (e.g. 1-5 scale). */
  readonly body: number;

  /** Sweetness score (e.g. 1-5 scale). */
  readonly sweetness: number;

  /** Wine style descriptor (e.g. "bold red", "crisp white"). */
  readonly style: string;

  /** Price band label (e.g. "$20-$30", "premium"). */
  readonly priceBand: string;

  /** Food pairing suggestions. */
  readonly pairing: readonly string[];

  /** Occasion tags (e.g. "celebration", "casual dinner"). */
  readonly occasion: readonly string[];

  /** Whether the wine is currently available for purchase. */
  readonly availability: boolean;

  /** Popularity score in [0, 1]. */
  readonly popularityScore: number;

  /** Pre-computed embedding vector (dense retrieval). */
  readonly embedding?: readonly number[] | undefined;
}
