import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { EntitySummary } from '../../response/model/result-item.js';
import type { ConstraintBundle } from '../../shared/types/index.js';

/**
 * Comparison candidate — enriched with structured attribute data for side-by-side comparison.
 *
 * Unlike {@link HybridCandidate}, which is optimized for retrieval/ranking,
 * ComparisonCandidate exposes all comparison-relevant attributes in a structured form.
 */
export interface ComparisonCandidate {
  /** Compact entity summary (for UI rendering). */
  readonly entity: EntitySummary;

  /** Structured attribute data for comparison axes (e.g. body, tannin, region, price). */
  readonly attributes: Readonly<Record<string, string | number>>;

  /**
   * List of comparison axes this candidate participates in.
   * Example: ["body", "tannin", "price_usd", "region"].
   * Used by UI to render side-by-side tables with only relevant columns.
   */
  readonly comparisonAxes: readonly string[];
}

/**
 * Epic 10: Compare Retriever — Specialized retrieval for comparison queries.
 *
 * Implements anchor-based comparison retrieval:
 * Given a reference wine (anchor), retrieve candidate wines that share
 * key comparison axes (body, tannin, region, price, style) and are
 * suitable for direct side-by-side comparison.
 *
 * Compare differs from mixed queries: rather than finding "similar wines",
 * comparison prioritizes **attribute parallelism** — wines that make sense
 * to compare on specific dimensions (e.g. "other full-bodied Napa Cabs under $150").
 *
 * RFC-017 §8.3: Comparison queries emphasize attribute alignment over
 * pure embedding similarity.
 */
export class CompareRetriever {
  /**
   * Compare mode: retrieve wines that share comparison axes with anchor.
   *
   * Example: Given "Opus One 2018" as anchor:
   * - Extract anchor attributes: body=0.9, tannin=0.8, region="Napa Valley", type="Cabernet", price=$180
   * - Identify comparison axes: ["body", "tannin", "region", "price"]
   * - Retrieve wines that match these axes: other Napa Cabs with high body/tannin, similar price band
   * - Exclude exact duplicates / near-identical wines (same producer + vintage within 2 years)
   * - Return sorted by "comparison fitness" (how well they align on the axes)
   *
   * @param anchor - The reference wine to compare against.
   * @param constraints - Optional constraints to refine the comparison set.
   * @param limit - Maximum candidates to retrieve (e.g. 8-12 for UI comparison table).
   * @returns Comparison candidates sorted by attribute alignment with anchor.
   * @throws {Error} If anchor lacks sufficient attribute data for comparison.
   */
  async compareToAnchor(
    _anchor: HybridCandidate,
    _constraints: ConstraintBundle,
    _limit: number,
  ): Promise<readonly ComparisonCandidate[]> {
    // Placeholder: real implementation will:
    // 1. Extract anchor attributes (body, tannin, region, price, style, grapes).
    // 2. Identify "comparison axes" — which attributes are most informative for this anchor.
    // 3. Query index for wines that match these axes:
    //    - Same region (or adjacent region)
    //    - Similar body/tannin profile (within ±1 point on 0-1 scale)
    //    - Similar price band (±20% of anchor price)
    //    - Same or complementary wine type (e.g. red+red, not red+white)
    // 4. Apply hard constraints (filter unsuitable wines).
    // 5. Score by: attribute alignment (Euclidean distance on axes) + popularity.
    // 6. Exclude anchor itself and near-duplicates (>0.95 embedding similarity, same producer+year).
    // 7. Return top-limit candidates.
    // 8. Enrich with comparisonAxes list for UI rendering.
    // 9. Populate attributes record with all comparison-relevant data.

    // For now, return empty.
    return [];
  }
}
