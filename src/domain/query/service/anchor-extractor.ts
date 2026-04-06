import type { EntityId } from '../../shared/types/index.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import type { NormalizedQueryViews } from '../model/query-views.js';
import { RelativeQueryExtractor } from './relative-query-extractor.js';

/**
 * Result returned by an {@link AliasMatcher} lookup.
 */
export interface AliasMatchResult {
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly entityIds: readonly EntityId[];
  /** Match confidence in [0, 1]. This is an alias-match confidence, NOT a calibrated C. */
  readonly matchConfidence: number;
  /** Strategy label for noisy lookup provenance. */
  readonly lookupStrategy?: string | undefined;
}

/**
 * Adapter interface for alias-based entity matching.
 *
 * The query domain depends on this abstraction rather than on the alias
 * domain directly, preserving domain boundaries.
 */
export interface AliasMatcher {
  /**
   * Finds all alias matches for the given normalized query string.
   * @param normalizedQuery - The lowercased, accent-stripped query.
   * @returns Zero or more alias match results, ordered by confidence descending.
   */
  findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]>;
}

/**
 * Korean mixed-query marker patterns.
 *
 * These particles and keywords signal that the query contains both an entity
 * reference and constraints/preferences, requiring mixed-query handling.
 */
const KOREAN_MIXED_QUERY_MARKERS: readonly RegExp[] = [
  /같은/,      // "like" (similarity)
  /비슷한/,    // "similar to"
  /말고/,      // "not / instead of" (exclusion)
  /대신/,      // "instead of"
  /보다/,      // "compared to / more than"
] as const;

/** Latin-script comparison markers. */
const COMPARISON_MARKERS: readonly RegExp[] = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\bcompared?\s+to\b/i,
] as const;

/**
 * Extracts anchor candidates from a normalized query string.
 *
 * Combines alias-based matching with heuristic pattern detection for
 * Korean mixed-query markers ("같은", "비슷한", "말고", "대신", "vs", "보다").
 */
/** Combined result of {@link AnchorExtractor.extractWithRelative}. */
export interface AnchorExtractionWithRelative {
  /** Anchor candidates from alias matching, ordered by confidence descending. */
  readonly anchors: readonly AnchorCandidate[];
  /** Structured relative/similarity query, or null if none detected. */
  readonly relativeQuery: AnchorConditionedQuery | null;
}

export class AnchorExtractor {
  private readonly relativeQueryExtractor = new RelativeQueryExtractor();

  constructor(private readonly aliasMatcher: AliasMatcher) {}

  /**
   * Extracts anchor candidates from the normalized query.
   *
   * @param normalizedQuery - Lowercased, accent-stripped query string.
   * @returns Anchor candidates ordered by confidence descending.
   */
  async extract(
    normalizedQuery: string,
    queryViews?: NormalizedQueryViews,
  ): Promise<readonly AnchorCandidate[]> {
    const lookupQueries = queryViews?.lookupVariants ?? [normalizedQuery];
    const aliasMatches = await this.lookupAliasMatches(lookupQueries);

    const candidates: AnchorCandidate[] = aliasMatches.map((match) => ({
      surfaceForm: match.surfaceForm,
      normalizedForm: match.normalizedForm,
      candidateEntityIds: match.entityIds,
      lookupVariants: match.lookupVariants,
      ...(match.lookupStrategy !== undefined
        ? { lookupStrategies: match.lookupStrategy.split('+') }
        : {}),
      confidence: match.matchConfidence,
      source: 'alias' as const,
    }));

    // Sort by confidence descending for deterministic ordering.
    candidates.sort((a, b) => b.confidence - a.confidence);

    return candidates;
  }

  /**
   * Extracts anchor candidates AND a relative/similarity query expression in
   * a single pass.
   *
   * The existing {@link extract} method is unchanged; this method augments its
   * output with structured relative-query information from
   * {@link RelativeQueryExtractor}.
   *
   * @param normalizedQuery - Lowercased, accent-stripped query string.
   * @param queryViews - Optional multi-view lookup variants.
   * @returns An object with `anchors` and `relativeQuery` fields.
   */
  async extractWithRelative(
    normalizedQuery: string,
    queryViews?: NormalizedQueryViews,
  ): Promise<AnchorExtractionWithRelative> {
    const [anchors, relativeQuery] = await Promise.all([
      this.extract(normalizedQuery, queryViews),
      Promise.resolve(this.relativeQueryExtractor.extract(normalizedQuery)),
    ]);

    return { anchors, relativeQuery };
  }

  private async lookupAliasMatches(
    lookupQueries: readonly string[],
  ): Promise<readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[]> {
    const merged = new Map<
      string,
      {
        readonly match: AliasMatchResult;
        readonly confidence: number;
        readonly priority: number;
        readonly lookupVariants: Set<string>;
        readonly lookupStrategies: Set<string>;
      }
    >();

    for (const [priority, lookupQuery] of lookupQueries.entries()) {
      if (lookupQuery.trim().length === 0) {
        continue;
      }

      const aliasMatches = await this.aliasMatcher.findMatches(lookupQuery);
      for (const match of aliasMatches) {
        const key = `${match.surfaceForm}\u0000${match.normalizedForm}\u0000${match.entityIds.map(String).join(',')}`;
        const existing = merged.get(key);

        if (
          existing === undefined ||
          match.matchConfidence > existing.confidence ||
          (match.matchConfidence === existing.confidence && priority < existing.priority)
        ) {
          merged.set(key, {
            match,
            confidence: match.matchConfidence,
            priority,
            lookupVariants: existing?.lookupVariants ?? new Set<string>(),
            lookupStrategies: existing?.lookupStrategies ?? new Set<string>(),
          });
        }

        merged.get(key)?.lookupVariants.add(lookupQuery);
        if (match.lookupStrategy !== undefined) {
          merged.get(key)?.lookupStrategies.add(match.lookupStrategy);
        }
      }
    }

    return [...merged.values()]
      .sort((left, right) => {
        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }
        return left.priority - right.priority;
      })
      .map(({ match, lookupVariants, lookupStrategies }) => ({
        ...match,
        lookupVariants: [...lookupVariants],
        ...(lookupStrategies.size > 0
          ? { lookupStrategy: [...lookupStrategies].sort().join('+') }
          : {}),
      }));
  }

  /**
   * Checks whether the query contains Korean mixed-query markers.
   *
   * These markers (같은, 비슷한, 말고, 대신, 보다) indicate that the user
   * references an entity while also expressing constraints or preferences.
   *
   * @param normalizedQuery - The normalized query to check.
   * @returns `true` if any Korean mixed-query marker is present.
   */
  hasKoreanMixedQueryMarkers(normalizedQuery: string): boolean {
    return KOREAN_MIXED_QUERY_MARKERS.some((re) => re.test(normalizedQuery));
  }

  /**
   * Checks whether the query contains comparison markers (e.g. "vs", "compared to").
   *
   * @param normalizedQuery - The normalized query to check.
   * @returns `true` if any comparison marker is present.
   */
  hasComparisonMarkers(normalizedQuery: string): boolean {
    return COMPARISON_MARKERS.some((re) => re.test(normalizedQuery));
  }
}
