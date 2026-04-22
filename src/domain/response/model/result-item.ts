import type { CanonicalEntityId, EvidenceItem } from '../../shared/types/index.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';

/**
 * Drinking window prediction block (Epic 15).
 * Indicates when a wine is best to drink.
 */
export interface DrinkingWindowBlock {
  readonly drinkingWindowStart: number;   // Year when wine becomes drinkable
  readonly drinkingWindowEnd: number;     // Year when wine is past peak
  readonly peakYear?: number | undefined; // Optional peak maturity year
  readonly currentlyDrinkable: boolean;   // true if current year is within window
  readonly confidence: 'high' | 'medium' | 'low';
  readonly evidenceLevel?: 'learned' | 'deterministic' | undefined;
  readonly blockingEligible?: boolean | undefined;
  readonly modelVersion?: string | undefined;
}

/**
 * Compact summary of a wine entity returned in search results.
 */
export interface EntitySummary {
  /** Branded entity identifier. */
  readonly entityId: CanonicalEntityId;

  /** Canonical display label (e.g. "Opus One 2018"). */
  readonly canonicalLabel: string;

  /** Entity type discriminator (e.g. "wine", "producer", "region"). */
  readonly type: string;

  /** Producer / winery name, when applicable. */
  readonly producer?: string | undefined;

  /** Region of origin. */
  readonly region?: string | undefined;

  /** Bottle closure, when indexed (e.g. screw cap, cork). */
  readonly closure?: string | undefined;

  /** Country of origin. */
  readonly country?: string | undefined;

  /** Appellation when distinct from region (browse / eval signals). */
  readonly appellation?: string | undefined;

  /** Producer prestige from the index (0–1 or 0–100 scale from source). */
  readonly producerPrestige?: number | undefined;

  /** Style descriptor (e.g. "bold", "elegant"). */
  readonly style?: string | undefined;

  /** Catalog wine type (e.g. "red", "white", "sparkling"). */
  readonly wineType?: string | undefined;

  /** Classification tier or legal designation. */
  readonly classification?: string | undefined;

  /** Critic score normalized to [0, 1]. */
  readonly criticScore?: number | undefined;

  /** Alcohol percentage. */
  readonly alcoholPct?: number | undefined;

  /** Certifications (e.g. "organic", "biodynamic"). */
  readonly certifications?: readonly string[] | undefined;

  /** Food pairing tags. */
  readonly pairingTags?: readonly string[] | undefined;

  /** Occasion suggestions. */
  readonly occasion?: readonly string[] | undefined;

  /** Wine body intensity (1–5 ordinal scale). */
  readonly body?: number | undefined;

  /** Tannin structure (1–5 ordinal scale). */
  readonly tannin?: number | undefined;

  /** Acidity level (1–5 ordinal scale). */
  readonly acidity?: number | undefined;

  /** Sweetness (1–5 ordinal scale). */
  readonly sweetness?: number | undefined;

  /** Finish length ([0,1] normalized). */
  readonly finishLength?: number | undefined;

  /** Flavor descriptor tags (e.g. "blackcurrant", "cedar", "tobacco"). */
  readonly flavorProfiles?: readonly string[] | undefined;

  /** LLM-authored semantic summary for display. */
  readonly semanticSummary?: string | undefined;

  /** Catalog availability flag (true = currently in stock). */
  readonly availability?: boolean | undefined;

  /** Vintage year, when applicable. */
  readonly vintage?: number | undefined;

  /** Grape varieties used. */
  readonly grapes?: readonly string[] | undefined;

  /** Human-readable price band (e.g. "$20-$30"). */
  readonly priceRange?: string | undefined;

  /** Gift suitability score in [0, 1]. */
  readonly giftSuitabilityScore?: number | undefined;
  /** Beginner suitability score in [0, 1]. */
  readonly beginnerSuitabilityScore?: number | undefined;

  /**
   * Upstream source record identifiers for lineage (ADR-007). Never use these
   * as public `entity_id`; they are for audit, support, and cross-system joins only.
   */
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
}

/**
 * Breakdown of how a result matched the query.
 */
export interface MatchDetail {
  /** High-level match strategy that produced this result. */
  readonly matchType: 'exact' | 'alias_exact' | 'alias_fuzzy' | 'semantic' | 'hybrid';

  /** Whether an anchor entity was used in the match. */
  readonly anchorUsed?: boolean | undefined;

  /** The alias string that triggered the match, if any. */
  readonly matchedAlias?: string | undefined;

  /** Per-signal score components that contributed to the relevance score. */
  readonly scoreComponents: {
    readonly lexical: number;
    readonly semantic: number;
    readonly attribute: number;
    readonly popularity: number;
    readonly preferenceAlignment?: number | undefined;
  };
}

/**
 * Per-result evaluation of how well constraints were satisfied.
 */
export interface ConstraintEvaluation {
  /** Constraint attribute names that were fully satisfied. */
  readonly matched: readonly string[];

  /** Constraint attribute names that were not satisfied. */
  readonly unmet: readonly string[];

  /** Constraint attribute names that were inferred by the system. */
  readonly inferred: readonly string[];
}

/**
 * Uncertainty metadata attached to a single result.
 */
export interface UncertaintyBlock {
  /**
   * Confidence that this result is the correct answer, in [0, 1].
   * This is a per-result uncertainty score, distinct from decision confidence.
   * Omitted when upstream uncertaintyPenalty is NaN/invalid — never masked
   * with a neutral 0.5 midpoint (T-E6-01).
   */
  readonly uncertaintyConfidence?: number | undefined;

  /** Information the system would need to increase confidence. */
  readonly missingInfo: readonly string[];

  /** Whether an approximation (e.g. fuzzy match, relaxed constraint) was used. */
  readonly approximationUsed: boolean;

  /** Flags for detected ambiguities that affect this result. */
  readonly ambiguityFlags?: readonly string[] | undefined;
}

/**
 * A single item in the search response result list.
 *
 * Every result carries at least one {@link EvidenceItem} explaining
 * why it was selected. Missing evidence is an invariant violation and
 * must be rejected before the response leaves the domain boundary.
 */
export interface ResultItem {
  /** Compact entity summary. */
  readonly entity: EntitySummary;

  /** Fused relevance score used for ordering results. */
  readonly relevanceScore: number;

  /** Details on how the result matched the query. */
  readonly match: MatchDetail;

  /** Constraint satisfaction evaluation. */
  readonly constraints: ConstraintEvaluation;

  /** Uncertainty metadata for this result. */
  readonly uncertainty: UncertaintyBlock;

  /** Evidence chain supporting this result's inclusion and ranking. */
  readonly evidenceItems: readonly EvidenceItem[];

  /** Optional human-readable summary of the evidence for display. */
  readonly humanReadableEvidenceSummary?: string | undefined;

  /** Drinking window prediction (when wine is best to drink). Populated when available. */
  readonly drinkingWindow?: DrinkingWindowBlock | undefined;

  /**
   * Human-readable reasons why this result matched the query,
   * derived from high-strength evidence items with positive contribution (Epic 9).
   * Omitted if no such evidence is present.
   */
  readonly matchReasons?: readonly string[] | undefined;

  /**
   * Constraint fields that were not satisfied by this result (Epic 9).
   * Derived from ConstraintEvaluation.unmet.
   * Omitted if all constraints were met.
   */
  readonly violatedConstraints?: readonly string[] | undefined;
}
