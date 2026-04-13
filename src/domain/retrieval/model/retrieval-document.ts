import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';

/**
 * SPLADE-style learned sparse weights for one document.
 * Mirrors {@link LearnedSparseVector} from the ETL spec (learned-sparse-spec.ts)
 * without creating a cross-layer import.
 */
export interface DocumentSparseVector {
  readonly entries: readonly { readonly token: string; readonly weight: number }[];
  readonly weightSum: number;
  readonly modelId: string;
  readonly schemaVersion: number;
}

/**
 * Summary projection — search hit display + evidence fields.
 * These are the fields returned in Vespa summary and needed for ranking evidence.
 * SSOT for: RetrievalHitSummary seam, response builder, eval display.
 *
 * `entityId` is required: every hit projection must carry a stable entity identity
 * so that consumers (response builder, eval display) can rely on it being present.
 * {@link RetrievalHitSummary} (partial data from a search result) overrides
 * `entityId` back to optional because summaries do not always carry entity identity
 * — that is the responsibility of {@link RetrievalSummaryCarrier}.
 *
 * `canonicalLabel` remains optional for partial projections (e.g. feature-only hits).
 *
 * The `| undefined` on optional fields is consistent with
 * `exactOptionalPropertyTypes` usage in this codebase (some downstream interfaces
 * use the explicit union form; matching it here avoids subtype incompatibility).
 */
export interface RetrievalHitProjection {
  readonly entityId: CanonicalEntityId;
  /** Lineage: upstream source keys (indexed for HTTP / agent exposure). */
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
  readonly canonicalLabel?: string | undefined;
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly vintageYear?: number | undefined;
  readonly searchTextEn?: string | undefined;
  readonly producerPrestige?: number | undefined;
  readonly avgCriticProxyScore?: number | undefined;
}

/**
 * Feature projection — ranking runtime + ML feature fields.
 * These are the fields needed by the ranker but NOT displayed to users.
 * SSOT for: Ranker, signal computers, LTR features.
 *
 * All fields are intentionally optional; {@link RetrievalDocument} overrides
 * `entityId` as required.
 *
 * The `| undefined` on optional fields is consistent with
 * `exactOptionalPropertyTypes` usage in this codebase.
 */
export interface RetrievalFeatureProjection {
  readonly entityId?: CanonicalEntityId | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly grapePrimaryEnc?: number | undefined;
  readonly regionEnc?: number | undefined;
  readonly countryEnc?: number | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;
}

/**
 * Projection schema for a document stored in the search index (RFC-012 S11).
 *
 * Full retrieval document = hit projection + feature projection + payload fields.
 * Only used in indexing/ETL layer. Runtime code should use hit or feature projection.
 *
 * This represents the complete set of fields that the retrieval layer
 * indexes and queries. It is the contract between the ingestion pipeline
 * and the search infrastructure.
 */
export interface RetrievalDocument extends RetrievalHitProjection, RetrievalFeatureProjection {
  /** Unique entity identifier. */
  readonly entityId: CanonicalEntityId;

  /** Entity type discriminator (e.g. "wine", "producer"). */
  readonly entityType: string;

  /**
   * Search snapshot identity that produced this document feed.
   *
   * This is optional for backward compatibility with legacy Vespa documents,
   * but snapshot-native publish paths MUST populate it so readiness can verify
   * the active Vespa document plane against the runtime substrate snapshot.
   */
  readonly searchSnapshotId?: string | undefined;

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

  /**
   * Doc2Query synthetic query expansions (Nogueira et al. 2019).
   *
   * Index-time generated queries that this document COULD answer. Stored
   * in a dedicated Vespa BM25 field (`synthetic_queries`) so the weight
   * can be tuned independently from the natural-text fields and IDF on
   * the original `searchTextEn` is not polluted by synthetic content.
   *
   * Empty / omitted when no Doc2Query pass has been run for this entity.
   */
  readonly syntheticQueries?: readonly string[] | undefined;

  /** Natural-language summary used for semantic embedding. */
  readonly semanticSummary: string;

  /** Body score [0,1] normalised. Absent when not present in the index document. */
  readonly body?: number | undefined;

  /** Sweetness score [0,1] normalised. Absent when not present in the index document. */
  readonly sweetness?: number | undefined;

  /** Wine style descriptor (e.g. "bold red", "crisp white"). */
  readonly style: string;

  /** Price band label (e.g. "$20-$30", "premium"). */
  readonly priceBand: string;

  /** Food pairing suggestions. */
  readonly pairing: readonly string[];

  /** Occasion tags (e.g. "celebration", "casual dinner"). */
  readonly occasion?: readonly string[] | undefined;

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

  /** Broad grape taxonomy group (e.g. "cabernet_family", "pinot_family"). */
  readonly grapeFamily?: string | undefined;

  /** Canonical region lineage from coarse to fine (e.g. ["France", "Bordeaux", "Pauillac"]). */
  readonly regionHierarchy?: readonly string[] | undefined;

  /** Numericized price-band bucket for ranking and filtering. */
  readonly priceBandNumeric?: number | undefined;

  /** SPLADE-style learned sparse weights (T4.2). Absent until the offline model runs. */
  readonly learnedSparseWeights?: DocumentSparseVector | undefined;
}
