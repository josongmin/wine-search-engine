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

  // -------------------------------------------------------------------------
  // New wine-domain attribute fields (SOTA++ additions)
  // -------------------------------------------------------------------------

  /** Vintage year (e.g. 2018). */
  readonly vintageYear?: number | undefined;

  /** Acidity level in [0, 1]. */
  readonly acidity?: number | undefined;

  /** Tannin level in [0, 1]. */
  readonly tannin?: number | undefined;

  /** Finish length in [0, 1]. */
  readonly finishLength?: number | undefined;

  /** Wine type (e.g. "red", "white", "sparkling", "rosé", "orange", "dessert", "fortified"). */
  readonly wineType?: string | undefined;

  /** Primary grape variety (e.g. "Cabernet Sauvignon"). */
  readonly grapePrimary?: string | undefined;

  /** Country of origin (e.g. "France"). */
  readonly country?: string | undefined;

  /** Appellation (e.g. "Napa Valley"). */
  readonly appellation?: string | undefined;

  /** Producer prestige score in [0, 1]. */
  readonly producerPrestige?: number | undefined;

  /** Critic score normalised from 0-100 scale to [0, 1]. */
  readonly criticScoreNormalized?: number | undefined;

  /** Actual price in USD. */
  readonly priceUsd?: number | undefined;

  // -------------------------------------------------------------------------
  // SOTA++ taxonomy fields — Wine catalog master data layer
  // -------------------------------------------------------------------------

  /** Flavor descriptor vocabulary (e.g. ["blackcurrant", "tobacco", "graphite"]). */
  readonly flavorProfiles?: readonly string[] | undefined;

  /** Official wine classification tier (e.g. "Premier Grand Cru Classé", "Grand Cru", "Barolo DOCG"). */
  readonly classification?: string | undefined;

  /** Alcohol by volume percentage (e.g. 13.5). */
  readonly alcoholPct?: number | undefined;

  /** First year the wine enters its optimal drinking window (inclusive). */
  readonly drinkingWindowStart?: number | undefined;

  /** Last year the wine is in its optimal drinking window (inclusive). */
  readonly drinkingWindowEnd?: number | undefined;

  /** Model version that produced the cached drinking-window fields, when known. */
  readonly drinkingWindowModelVersion?: string | undefined;

  /** Oak aging regime (e.g. "new French oak 18 months", "unoaked stainless"). */
  readonly oakTreatment?: string | undefined;

  /** Certifications (e.g. ["biodynamic", "organic", "natural"]). */
  readonly certifications?: readonly string[] | undefined;

  /** Primary soil type of the vineyard (e.g. "gravel", "limestone", "schist"). */
  readonly soilType?: string | undefined;

  /** Producer archetype (e.g. "château", "domaine", "estate", "winery", "négociant"). */
  readonly producerType?: string | undefined;
}
