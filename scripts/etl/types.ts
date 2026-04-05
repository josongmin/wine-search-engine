/**
 * Shared types for the Bronze → Silver → Gold ETL pipeline.
 *
 * These types live outside `src/` because they are ETL-specific intermediate
 * representations — not part of the runtime domain model.
 */

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
}
