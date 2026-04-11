import type { ResultItem } from '../model/result-item.js';
import type { QueryTargetType } from '../../query/model/query-target-type.js';
import { STYLE_SENSORY_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';

/**
 * Summary statistics for a grouped set of results.
 */
export interface GroupSummary {
  /** Total number of items in the full group (before pagination/filtering). */
  readonly totalInGroup: number;

  /** Number of items actually displayed in this group. */
  readonly displayedCount: number;

  /** Common attributes shared across all items in the group. */
  readonly commonAttributes: Readonly<Record<string, string>>;
}

/**
 * A set of results grouped by entity type and key (producer name, region, etc.).
 *
 * Discriminator: `resultType` determines the semantic meaning of `groupKey` and
 * the type of aggregation applied.
 */
export interface GroupedResult {
  /** Result type discriminator: 'single_entity' (no grouping), or set type. */
  readonly resultType:
    | 'single_entity'
    | 'producer_set'
    | 'region_set'
    | 'style_set'
    | 'wine_set';

  /** Group key when applicable (e.g., producer name, region name, style descriptor). */
  readonly groupKey?: string | undefined;

  /** Ordered items in this result group, highest relevance first. */
  readonly items: readonly ResultItem[];

  /** Optional summary when items are grouped (populated for producer_set, region_set, style_set). */
  readonly summary?: GroupSummary | undefined;
}

/**
 * ResultGrouper service: groups search results by entity type and provides
 * result type classification and summary statistics (Epic 8).
 *
 * Grouping happens at the response layer, not retrieval. The Planner's
 * `targetEntityType` hint guides the grouping strategy.
 *
 * Example transformations:
 * - "안티노리" (Antinori) + targetType='producer' → group all results by producer → GroupedResult with type='producer_set'
 * - "마고 2015" (Margaux 2015) + targetType='wine' → single wine → type='single_entity'
 * - "나파" (Napa) + targetType='region' → group by region → type='region_set'
 * - "묵직한 레드" (full-body red) + targetType='style' → group by style → type='style_set'
 */
export class ResultGrouper {
  /**
   * Groups a list of results based on the inferred target entity type.
   *
   * @param results - The ranked result items to group.
   * @param targetType - The inferred target entity type from the query planner.
   * @returns A grouped result structure with type discriminator and optional summary.
   */
  group(results: readonly ResultItem[], targetType: QueryTargetType): GroupedResult {
    // Single result or no results: return as-is with single_entity type.
    if (results.length <= 1) {
      return {
        resultType: 'single_entity',
        items: results,
      };
    }

    // Dispatch to type-specific grouping logic.
    switch (targetType) {
      case 'producer':
        return this.groupByProducer(results);
      case 'region':
        return this.groupByRegion(results);
      case 'style':
        return this.groupByStyle(results);
      case 'wine':
        return this.groupByWine(results);
      case 'unknown':
      default:
        // No clear grouping strategy: return all as a generic wine_set.
        return this.groupAsWineSet(results);
    }
  }

  /**
   * Groups results by producer. When all results share the same producer,
   * returns a producer_set with summary. Otherwise returns wine_set.
   */
  private groupByProducer(results: readonly ResultItem[]): GroupedResult {
    // Extract producer from each result. Use an explicit non-empty string guard
    // rather than filter(Boolean) — an empty string '' is falsy but is a valid
    // (if degenerate) producer value that would otherwise incorrectly fail the
    // "all results share the same producer" check.
    const producers = results
      .map((r) => r.entity.producer)
      .filter((p): p is string => p != null && p.length > 0);

    // If all results have the same producer, return as producer_set.
    if (producers.length === results.length && new Set(producers).size === 1) {
      const commonProducer = producers[0]!;
      return {
        resultType: 'producer_set',
        groupKey: commonProducer,
        items: results,
        summary: {
          totalInGroup: results.length,
          displayedCount: results.length,
          commonAttributes: {
            producer: commonProducer,
          },
        },
      };
    }

    // Mixed producers: return as generic wine_set.
    return this.groupAsWineSet(results);
  }

  /**
   * Groups results by region. When all results share the same region,
   * returns a region_set with summary. Otherwise returns wine_set.
   */
  private groupByRegion(results: readonly ResultItem[]): GroupedResult {
    // Extract region from each result. Same non-empty guard as groupByProducer —
    // filter(Boolean) would discard empty strings, causing false 'wine_set' fallback.
    const regions = results
      .map((r) => r.entity.region)
      .filter((r): r is string => r != null && r.length > 0);

    // If all results have the same region, return as region_set.
    if (regions.length === results.length && new Set(regions).size === 1) {
      const commonRegion = regions[0]!;
      return {
        resultType: 'region_set',
        groupKey: commonRegion,
        items: results,
        summary: {
          totalInGroup: results.length,
          displayedCount: results.length,
          commonAttributes: {
            region: commonRegion,
          },
        },
      };
    }

    // Mixed regions: return as generic wine_set.
    return this.groupAsWineSet(results);
  }

  /**
   * Groups results by style. Since style is not directly available in EntitySummary,
   * we infer it from constraints.matched and constraints.unmet in the first result.
   * For now, returns wine_set with a style hint in groupKey if detectable.
   */
  private groupByStyle(results: readonly ResultItem[]): GroupedResult {
    // Extract inferred style from constraint evaluation if present.
    const firstResult = results[0];
    let styleHint: string | undefined;

    if (firstResult) {
      // Look for style sensory attributes (body, sweetness, acidity, tannin, style)
      // in matched constraints — SSoT: STYLE_SENSORY_ATTRIBUTES from constraint-attributes.ts.
      const styleMatches = firstResult.constraints.matched.filter((attr) =>
        STYLE_SENSORY_ATTRIBUTES.has(attr),
      );
      if (styleMatches.length > 0) {
        styleHint = styleMatches.join(' + ');
      }
    }

    return {
      resultType: 'style_set',
      ...(styleHint !== undefined && { groupKey: styleHint }),
      items: results,
      summary: {
        totalInGroup: results.length,
        displayedCount: results.length,
        commonAttributes:
          styleHint !== undefined ? { style_preference: styleHint } : {},
      },
    };
  }

  /**
   * Groups results as a wine set (explicit wine targeting).
   * Optionally attempts to diversify by producer/region to avoid redundant results.
   */
  private groupByWine(results: readonly ResultItem[]): GroupedResult {
    return {
      resultType: 'wine_set',
      items: results,
      summary: {
        totalInGroup: results.length,
        displayedCount: results.length,
        commonAttributes: {},
      },
    };
  }

  /**
   * Generic wine set grouping: used when target type is unknown or mixed.
   */
  private groupAsWineSet(results: readonly ResultItem[]): GroupedResult {
    return {
      resultType: 'wine_set',
      items: results,
      summary: {
        totalInGroup: results.length,
        displayedCount: results.length,
        commonAttributes: {},
      },
    };
  }
}
