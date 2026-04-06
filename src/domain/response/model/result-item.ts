import type { EntityId, EvidenceItem } from '../../shared/types/index.js';

/**
 * Drinking window prediction block (Epic 15).
 * Indicates when a wine is best to drink.
 */
export interface DrinkingWindowBlock {
  readonly drinkingWindowStart: number;   // Year when wine becomes drinkable
  readonly drinkingWindowEnd: number;     // Year when wine is past peak
  readonly currentlyDrinkable: boolean;   // true if current year is within window
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion?: string | undefined;
}

/**
 * Compact summary of a wine entity returned in search results.
 */
export interface EntitySummary {
  /** Branded entity identifier. */
  readonly entityId: EntityId;

  /** Canonical display label (e.g. "Opus One 2018"). */
  readonly canonicalLabel: string;

  /** Entity type discriminator (e.g. "wine", "producer", "region"). */
  readonly type: string;

  /** Producer / winery name, when applicable. */
  readonly producer?: string | undefined;

  /** Region of origin. */
  readonly region?: string | undefined;

  /** Appellation when distinct from region (browse / eval signals). */
  readonly appellation?: string | undefined;

  /** Producer prestige from the index (0–1 or 0–100 scale from source). */
  readonly producerPrestige?: number | undefined;

  /** Vintage year, when applicable. */
  readonly vintage?: number | undefined;

  /** Grape varieties used. */
  readonly grapes?: readonly string[] | undefined;

  /** Human-readable price band (e.g. "$20-$30"). */
  readonly priceRange?: string | undefined;
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
    readonly preferenceAlignment: number;
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
   */
  readonly uncertaintyConfidence: number;

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
 * why it was selected. If evidence is absent the response builder
 * must attach a reason code.
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
