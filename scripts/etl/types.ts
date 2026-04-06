/**
 * Shared types for the Bronze → Silver → Gold ETL pipeline.
 *
 * These types live outside `src/` because they are ETL-specific intermediate
 * representations — not part of the runtime domain model.
 */

import type { LearnedSparseVector } from './learned-sparse-spec.js';

// ---------------------------------------------------------------------------
// Vivino Bronze payload shape (from wine_pdp_snapshot.payload JSONB)
// ---------------------------------------------------------------------------

/** Subset of the Vivino PDP payload that we actually extract. */
export interface VivinoPayload {
  readonly winery?: { readonly name?: string; readonly id?: number };
  readonly vintage?: { readonly year?: number; readonly seo_name?: string };
  readonly style?: {
    readonly body_description?: string;
    readonly acidity_description?: string;
    readonly description?: string;
  };
  readonly statistics?: {
    readonly ratings_average?: number;
    readonly ratings_count?: number;
    readonly labels_count?: number;
  };
  readonly grapes?: readonly { readonly name?: string }[];
  readonly food_pairings?: readonly string[];
  readonly region?: {
    readonly name?: string;
    readonly country?: { readonly name?: string; readonly code?: string };
  };
  readonly taste?: {
    readonly structure?: {
      readonly acidity?: number;
      readonly fizziness?: number;
      readonly intensity?: number;
      readonly sweetness?: number;
      readonly tannin?: number;
    };
    readonly flavor?: readonly {
      readonly group?: string;
      readonly stats?: { readonly count?: number };
    }[];
  };

  // ---------------------------------------------------------------------------
  // Fields present in real Vivino data but previously untyped
  // ---------------------------------------------------------------------------

  /** Alcohol by volume string, e.g. "14%", "13.5%", "14.4% alc". */
  readonly alcohol?: string;

  /**
   * Comma-separated grape varieties from Vivino's varietal field,
   * e.g. "Tempranillo" or "Grenache, Shiraz/Syrah".
   * Used as fallback when payload.grapes[] is absent.
   */
  readonly varietal?: string;

  /** Quality badges, e.g. ["Top 1%", "Best value"]. */
  readonly badges?: readonly string[];

  /**
   * Short tasting note summary, e.g. "red fruit notes (cherry)".
   * Supplements style.description when the latter is absent.
   */
  readonly tasting_notes?: string;

  /**
   * High-level taste profile from Vivino's UI sliders.
   * Useful as fallback when taste.structure is absent.
   */
  readonly taste_profile?: {
    readonly dry_sweet?: string;    // "Dry" | "Off-dry" | "Sweet"
    readonly light_bold?: string;   // "Light" | "Medium" | "Bold"
    readonly soft_acidic?: string;  // "Soft" | "Acidic"
  };

  /** Winery-level average rating (1–5 scale). Maps to producer_prestige. */
  readonly winery_rating?: number;

  /** Total number of wines in the winery's portfolio. */
  readonly winery_wine_count?: number;

  /** Total ratings count for the winery. */
  readonly winery_rating_count?: number;

  /**
   * Winery's primary location label, e.g. "Napa Valley", "Côte de Nuits".
   * Cleaner than the raw region path in BronzeRow.region.
   */
  readonly winery_location?: string;

  /**
   * Structured flavor notes with per-group descriptors and review counts.
   * Each key is a flavor group (e.g. "oaky", "earthy"); value shape varies.
   */
  readonly flavor_notes?: Record<string, unknown>;

  /** Merchant price listings. Used to derive a reliable price_usd. */
  readonly merchant_prices?: readonly {
    readonly price?: number;
    readonly currency?: string;
    readonly merchant?: string;
  }[];

  /** Top-level ratings count (may differ from statistics.ratings_count). */
  readonly rating_count?: number;

  /** Number of text reviews. */
  readonly review_count?: number;

  /** Bottle volume in ml, e.g. 750, 1500. */
  readonly bottle_ml?: number;
}

/** Row from wine_pdp_snapshot table (Bronze tier). */
export interface BronzeRow {
  readonly id: number;
  readonly external_id: string;
  readonly display_name: string;
  readonly producer: string | null;
  readonly vintage_year: number | null;
  readonly region: string | null;
  readonly country: string | null;
  readonly wine_style: string | null;
  readonly rating: number | null;
  readonly price: number | null;
  readonly currency: string | null;
  readonly scraped_at: string | null;
  readonly source_url: string | null;
  readonly payload: VivinoPayload | null;
}

// ---------------------------------------------------------------------------
// Silver wine record (normalized intermediate form)
// ---------------------------------------------------------------------------

export type WineType =
  | 'red'
  | 'white'
  | 'rosé'
  | 'sparkling'
  | 'dessert'
  | 'fortified';

export type PriceBand = 'value' | 'mid' | 'premium' | 'luxury';

/**
 * Silver record: the normalized intermediate between raw Vivino data and the
 * final {@link RetrievalDocument} that gets indexed in Vespa.
 *
 * All numeric sensory scores are in [0, 1].
 * All strings are trimmed and non-empty (or the field is omitted).
 */
export interface SilverWineRecord {
  /** Deterministic ID: hash of "vivino:{external_id}". */
  readonly sourceId: string;
  /** Vivino external_id for provenance. */
  readonly externalId: string;
  /** Normalized canonical label (RFC-002: never raw display_name). */
  readonly canonicalLabel: string;
  /** Producer / winery name. */
  readonly producer: string;
  /** Vintage year (null if NV). */
  readonly vintageYear: number | null;
  /** Country of origin. */
  readonly country: string;
  /** Region name. */
  readonly region: string;
  /** Appellation (more specific than region, if available). */
  readonly appellation: string | null;
  /** Wine type enum. */
  readonly wineType: WineType;
  /** Primary grape variety. */
  readonly grapePrimary: string | null;
  /** All grape varieties. */
  readonly grapes: readonly string[];
  /** Body in [0, 1], normalized from Vivino 1-5. */
  readonly body: number;
  /** Sweetness in [0, 1]. */
  readonly sweetness: number;
  /** Acidity in [0, 1]. */
  readonly acidity: number;
  /** Tannin in [0, 1]. */
  readonly tannin: number;
  /** Food pairing tags. */
  readonly pairingTags: readonly string[];
  /** Flavor group tags (e.g. "black-fruit", "oak"). */
  readonly flavorProfiles: readonly string[];
  /** English tasting notes for full-text search + semantic embedding. */
  readonly searchTextEn: string;
  /** Vivino average rating (original 1-5 scale). */
  readonly ratingAvg: number | null;
  /** Vivino ratings count (raw). */
  readonly ratingsCount: number;
  /** Price in USD (simplified: non-USD assumed 1:1 for now). */
  readonly priceUsd: number | null;
  /** Price band derived from priceUsd. */
  readonly priceBand: PriceBand;
  /** Popularity score in [0, 1], log-normalized across corpus. */
  readonly popularityScore: number;
  /** Scraped timestamp for temporal ordering. */
  readonly scrapedAt: string | null;

  // ---------------------------------------------------------------------------
  // SOTA++ fields extracted from previously-unused Vivino payload fields
  // ---------------------------------------------------------------------------

  /** Alcohol by volume in %, e.g. 14.0. Null when absent in payload. */
  readonly alcoholPct: number | null;

  /**
   * Winery-level prestige proxy in [0, 1], derived from payload.winery_rating
   * (original 1–5 scale, divided by 5). Null when absent.
   */
  readonly producerPrestige: number | null;

  /**
   * True when Vivino's "Top 1%" badge is present.
   * Used to boost popularity_score and producer_prestige during indexing.
   */
  readonly isTopRated: boolean;
}

// ---------------------------------------------------------------------------
// Alias types (RFC-003 compliant)
// ---------------------------------------------------------------------------

export type AliasType = 'translation' | 'phonetic' | 'catalog_noise_alias';

/** A single alias proposal with lineage tracking (RFC-003). */
export interface ProposedAlias {
  readonly value: string;
  readonly type: AliasType;
  /** Generation source for audit trail, e.g. "rule:accent_fold_v1". */
  readonly source: string;
  /** RFC-003 confidence prior seed in [0, 1]. */
  readonly confidencePrior: number;
  /** Whether human review is needed before projection. */
  readonly needsReview: boolean;
}

/**
 * Bundle of alias proposals for a single entity.
 *
 * `proposed` is the SSOT (typed alias list).
 * The projection arrays are derived flattened copies for Vespa indexing.
 */
export interface AliasBundle {
  readonly proposed: readonly ProposedAlias[];
  /** High-precision aliases for identity-safe matching. */
  readonly identitySafeProjection: readonly string[];
  /** Broader recall aliases (may include noisy aliases). */
  readonly noisyRecallProjection: readonly string[];
}

// ---------------------------------------------------------------------------
// Silver + Aliases combined (output of alias enrichment step)
// ---------------------------------------------------------------------------

export interface EnrichedSilverRecord extends SilverWineRecord {
  readonly aliases: AliasBundle;
}

// ---------------------------------------------------------------------------
// Indexable wine record (projection family alignment — T7.3)
// ---------------------------------------------------------------------------

/**
 * IndexableWineRecord: the explicit intermediate representation between the
 * Silver record and the Vespa feed.
 *
 * Fields are grouped by ownership per the retrieval projection families
 * defined in {@link RetrievalHitProjection} and {@link RetrievalFeatureProjection}
 * (src/domain/retrieval/model/retrieval-document.ts).
 *
 * This type makes the ETL → Vespa field mapping auditable and testable
 * without touching the runtime query/HTTP surface.
 */
export interface IndexableWineRecord {
  // -------------------------------------------------------------------------
  // RetrievalHitProjection fields — hit display + evidence fields
  // -------------------------------------------------------------------------

  /** Required: unique entity identifier (non-empty). */
  readonly entityId: string;
  /** Required: canonical display label (non-empty). */
  readonly canonicalLabel: string;
  /** Producer / winery name. */
  readonly producer?: string | undefined;
  /** Region of origin. */
  readonly region?: string | undefined;
  /** Appellation (more specific than region, if available). */
  readonly appellation?: string | undefined;
  /** Primary grape variety. */
  readonly grapePrimary?: string | undefined;
  /** Vintage year (e.g. 2018). */
  readonly vintageYear?: number | undefined;
  /** English full-text search field. */
  readonly searchTextEn?: string | undefined;
  /** Producer prestige score in [0, 1]. */
  readonly producerPrestige?: number | undefined;
  /** Critic score normalised to [0, 1]. */
  readonly avgCriticProxyScore?: number | undefined;

  // -------------------------------------------------------------------------
  // RetrievalFeatureProjection fields — ranker / ML feature fields
  // -------------------------------------------------------------------------

  /** Body score in [0, 1]. */
  readonly body?: number | undefined;
  /** Tannin level in [0, 1]. */
  readonly tannin?: number | undefined;
  /** Acidity level in [0, 1]. */
  readonly acidity?: number | undefined;
  /** Sweetness level in [0, 1]. */
  readonly sweetness?: number | undefined;
  /** Critic score normalised to [0, 1] (feature copy). */
  readonly criticScoreNormalized?: number | undefined;
  /** Encoded grape primary (LTR feature). */
  readonly grapePrimaryEnc?: number | undefined;
  /** Encoded region (LTR feature). */
  readonly regionEnc?: number | undefined;
  /** Encoded country (LTR feature). */
  readonly countryEnc?: number | undefined;
  /** First year of optimal drinking window. */
  readonly drinkingWindowStart?: number | undefined;
  /** Last year of optimal drinking window. */
  readonly drinkingWindowEnd?: number | undefined;
  /** Model version that produced the drinking-window estimate. */
  readonly drinkingWindowModelVersion?: string | undefined;

  // -------------------------------------------------------------------------
  // Payload fields — stored in the index but not in either projection
  // -------------------------------------------------------------------------

  /** Entity type discriminator. */
  readonly entityType: string;
  /** Identity-safe aliases for high-precision matching. */
  readonly aliasesIdentitySafe: readonly string[];
  /** Noisy-recall aliases for broader recall. */
  readonly aliasesNoisyRecall: readonly string[];
  /** All grape varieties. */
  readonly grapes: readonly string[];
  /** Korean full-text search field. */
  readonly searchTextKo: string;
  /** Natural-language summary for semantic embedding. */
  readonly semanticSummary: string;
  /** Wine style descriptor (e.g. "bold red"). */
  readonly style: string;
  /** Price band label (e.g. "premium"). */
  readonly priceBand: string;
  /** Food pairing suggestions. */
  readonly pairing: readonly string[];
  /** Occasion tags. */
  readonly occasion: readonly string[];
  /** Whether the wine is available for purchase. */
  readonly availability: boolean;
  /** Popularity score in [0, 1]. */
  readonly popularityScore: number;
  /** Wine type (e.g. "red", "white"). */
  readonly wineType?: string | undefined;
  /** Country of origin. */
  readonly country?: string | undefined;
  /** Actual price in USD. */
  readonly priceUsd?: number | undefined;
  /** Flavor descriptor vocabulary. */
  readonly flavorProfiles?: readonly string[] | undefined;
  /** Alcohol by volume percentage. */
  readonly alcoholPct?: number | undefined;
  /** Certifications (e.g. ["organic", "biodynamic"]). */
  readonly certifications?: readonly string[] | undefined;
  /** SPLADE-style learned sparse weights. Embedding is generated separately. */
  readonly learnedSparseWeights?: LearnedSparseVector | undefined;
  /** Legal classification or tier designation (e.g. "Premier Cru", "Grand Cru"). */
  readonly classification?: string | undefined;
  /** Vineyard soil type (e.g. "clay", "limestone"). */
  readonly soilType?: string | undefined;
  /** Producer archetype (e.g. "family_estate", "negociant"). */
  readonly producerType?: string | undefined;
  /** Finish length in [0, 1] normalized ordinal. */
  readonly finishLength?: number | undefined;
  /** Oak aging regime (e.g. "new French oak 18 months", "unoaked stainless"). */
  readonly oakTreatment?: string | undefined;
}

// ---------------------------------------------------------------------------
// Quality gate report
// ---------------------------------------------------------------------------

export interface SilverQualityReport {
  readonly totalBronzeRows: number;
  readonly afterDedup: number;
  readonly afterTransform: number;
  readonly fieldCoverage: Record<string, number>;
  readonly distributionChecks: {
    readonly bodyMean: number;
    readonly bodyStdDev: number;
    readonly priceCoverage: number;
    readonly tastingNotesCoverage: number;
    readonly aliasMeanCount: number;
  };
  readonly blockers: readonly string[];
  /** Non-fatal quality notes (e.g. uniform body scores from sparse Bronze metadata). */
  readonly warnings: readonly string[];
  readonly passed: boolean;
}

// ---------------------------------------------------------------------------
// Golden query types (Epic 2)
// ---------------------------------------------------------------------------

export type Scenario = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'no_match';

export type GoldenQueryClass =
  | 'exact_entity'
  | 'ambiguous_short_form'
  | 'semantic_preference'
  | 'pure_constraint'
  | 'exploration'
  | 'similar_compare'
  | 'catalog_browse'
  | 'noisy_recall'
  | 'no_match';

export type AnnotationTier = 'bronze' | 'silver' | 'gate';

export interface RelevanceJudgment {
  readonly entity_id: string;
  readonly grade: 0 | 1 | 2 | 3;
}

export interface LeakageKeys {
  readonly entity_id: string;
  readonly query_template_id: string;
  readonly generation_run_id: string;
  readonly alias_cluster_id: string;
}

/**
 * Retrieval mode — represents the retrieval strategy for a query.
 * Used for Epic 11 (Eval Extension - Mode Slicing).
 *
 * See: src/domain/query/model/retrieval-mode.ts for full definitions.
 */
export type RetrievalMode =
  | 'entity_lookup'
  | 'entity_resolution'
  | 'attribute_search'
  | 'constraint_filter'
  | 'producer_browse'
  | 'region_browse'
  | 'compare_candidates'
  | 'recommendation'
  | 'similar_items'
  | 'no_match_detection';

export interface GoldenQuery {
  readonly qid: string;
  readonly query: string;
  readonly query_class: GoldenQueryClass;
  readonly scenario: Scenario;
  readonly language: 'en' | 'ko' | 'mixed';

  readonly retrieval_labels: {
    readonly relevant: readonly RelevanceJudgment[];
  };

  readonly decision_labels: {
    readonly expected_decision_status: 'resolved' | 'ambiguous' | 'failed';
    readonly expected_entity_id?: string;
    readonly ambiguity_expected: boolean;
    readonly requires_abstain: boolean;
  };

  readonly leakage_keys: LeakageKeys;

  readonly annotation_tier: AnnotationTier;
  readonly annotated_by: readonly string[];
  readonly release_gate_eligible: boolean;
  readonly created_at: string;

  /** Optional retrieval mode (inferred from query class). Epic 11. */
  readonly retrieval_mode?: RetrievalMode;
}
