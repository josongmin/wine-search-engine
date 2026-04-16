import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import type { NormalizedQueryViews } from '../model/query-views.js';
import { parseSpans } from '../../attribute/service/span-parser.js';
import { RelativeQueryExtractor } from './relative-query-extractor.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';

/**
 * Result returned by an {@link AliasMatcher} lookup.
 */
export interface AliasMatchResult {
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly entityIds: readonly CanonicalEntityId[];
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
  /**
   * Optional bulk lookup for request-scoped batches of normalized queries.
   *
   * Hot-path alias substrates should implement this to avoid repeated
   * downstream I/O when the planner expands a single user query into multiple
   * lookup variants/spans.
   */
  findMatchesBatch?(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>>;
}

/**
 * Korean mixed-query marker patterns.
 *
 * These particles and keywords signal that the query contains both an entity
 * reference and constraints/preferences, requiring mixed-query handling.
 */
const KOREAN_MIXED_QUERY_MARKERS: readonly RegExp[] = [
  /같은/u,      // "like" (similarity)
  /비슷한/u,    // "similar to"
  /말고/u,      // "not / instead of" (exclusion)
  /대신/u,      // "instead of"
  /보다/u,      // "compared to / more than"
] as const;

/** Latin-script comparison markers. */
const COMPARISON_MARKERS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})vs\.?(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})versus(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})compared?\s+to(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:비교|비교하면|차이|어느|뭐가)(?=$|[^\p{L}\p{N}])/u,
  /(?:와|과|랑|하고|이랑)\s+.+?\s+(?:중|비교|비교해|비교해줘|비교하면|뭐가|어떤|차이|어느)(?:$|[^\p{L}\p{N}])/u,
] as const;

export function hasKoreanMixedQueryMarkers(normalizedQuery: string): boolean {
  return KOREAN_MIXED_QUERY_MARKERS.some((re) => re.test(normalizedQuery));
}

export function hasComparisonMarkers(normalizedQuery: string): boolean {
  return COMPARISON_MARKERS.some((re) => re.test(normalizedQuery));
}

/**
 * Extracts anchor candidates from a normalized query string.
 *
 * Combines alias-based matching with heuristic pattern detection for
 * Korean mixed-query markers ("같은", "비슷한", "말고", "대신", "vs", "보다").
 */
/** Combined result of {@link AnchorExtractor.extractWithRelative}. */
interface AnchorExtractionWithRelative {
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
    const lookupQueries = this.buildLookupQueries(normalizedQuery, queryViews);
    return this.extractFromLookupQueries(lookupQueries);
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
    const relativeQuery = this.relativeQueryExtractor.extract(normalizedQuery);
    const lookupQueries = new Set<string>(this.buildLookupQueries(normalizedQuery, queryViews));

    for (const anchorSurface of relativeQuery?.relativeExpressions.map((expr) => expr.anchorSurfaceForm) ?? []) {
      const trimmed = anchorSurface.trim();
      if (trimmed.length > 0) {
        lookupQueries.add(trimmed);
      }
    }

    const anchors = await this.extractFromLookupQueries([...lookupQueries]);

    return { anchors, relativeQuery };
  }

  /**
   * Build lookup queries in priority order.
   *
   * We keep the original normalized views first, then add their token spans so
   * entity anchors survive trailing request words like "추천" or "해줘".
   */
  private buildLookupQueries(
    normalizedQuery: string,
    queryViews?: NormalizedQueryViews,
  ): readonly string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      ordered.push(trimmed);
    };

    const baseQueries = queryViews?.lookupVariants ?? [normalizedQuery];
    for (const query of baseQueries) {
      add(query);
    }

    for (const query of baseQueries) {
      for (const span of parseSpans(query)) {
        add(span.text);
      }
    }

    return ordered;
  }

  private async extractFromLookupQueries(
    lookupQueries: readonly string[],
  ): Promise<readonly AnchorCandidate[]> {
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

    // Sort by confidence descending with NaN-safe + deterministic tiebreaker
    // (canonical id) so equal-confidence candidates resolve identically across
    // processes. (Bugbash R22)
    candidates.sort(
      compareScoreWithTiebreaker<typeof candidates[number]>(
        (c) => c.confidence,
        (c) => c.surfaceForm,
      ),
    );

    return candidates;
  }

  private async lookupAliasMatches(
    lookupQueries: readonly string[],
  ): Promise<readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[]> {
    const normalizedLookupQueries = lookupQueries
      .map((query) => query.trim())
      .filter((query) => query.length > 0);
    const batchMatches = this.aliasMatcher.findMatchesBatch !== undefined
      ? await this.aliasMatcher.findMatchesBatch(normalizedLookupQueries)
      : undefined;
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
      const trimmedLookupQuery = lookupQuery.trim();
      if (trimmedLookupQuery.length === 0) {
        continue;
      }

      const aliasMatches = batchMatches?.get(trimmedLookupQuery)
        ?? await this.aliasMatcher.findMatches(trimmedLookupQuery);
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

        merged.get(key)?.lookupVariants.add(trimmedLookupQuery);
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
   * TA2-T2: Look up alias matches for a fuzzy-corrected term.
   *
   * Used by the Planner's fuzzy-match fallback path to resolve entity IDs
   * for terms that the FuzzyMatcher corrected but that did not match during
   * the original anchor extraction pass.
   *
   * Returns the raw AliasMatchResult array — callers are responsible for
   * converting results to AnchorCandidates with `source: 'planner_heuristic'`.
   *
   * @param term - The fuzzy-corrected surface form to look up.
   * @returns Zero or more alias match results, ordered by confidence descending.
   */
  async lookupForFuzzyTerm(term: string): Promise<readonly AliasMatchResult[]> {
    const matchesByTerm = await this.lookupForFuzzyTerms([term]);
    return matchesByTerm.get(term.trim()) ?? [];
  }

  /**
   * Resolve multiple fuzzy terms in one batch when the underlying matcher
   * supports batch lookup. Falls back to concurrent single lookups otherwise.
   *
   * This is a performance-critical path for fallback entity recovery when exact
   * anchors miss.
   */
  async lookupForFuzzyTerms(
    terms: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const normalizedTerms = Array.from(
      new Set(
        terms
          .map((term) => term.trim())
          .filter((term) => term.length > 0),
      ),
    );
    if (normalizedTerms.length === 0) {
      return new Map();
    }

    try {
      const batch =
        this.aliasMatcher.findMatchesBatch !== undefined
          ? await this.aliasMatcher.findMatchesBatch(normalizedTerms)
          : undefined;
      if (batch !== undefined) {
        const merged = new Map<string, readonly AliasMatchResult[]>();
        for (const term of normalizedTerms) {
          merged.set(term, batch.get(term) ?? []);
        }
        return merged;
      }

      const settled = await Promise.allSettled(
        normalizedTerms.map(async (term) => this.aliasMatcher.findMatches(term)),
      );
      const merged = new Map<string, readonly AliasMatchResult[]>();
      normalizedTerms.forEach((term, index) => {
        const maybeMatches = settled[index];
        merged.set(
          term,
          maybeMatches?.status === 'fulfilled' ? maybeMatches.value : [],
        );
      });
      return merged;
    } catch {
      const merged = new Map<string, readonly AliasMatchResult[]>();
      for (const term of normalizedTerms) {
        merged.set(term, []);
      }
      return merged;
    }
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
    return hasKoreanMixedQueryMarkers(normalizedQuery);
  }

  /**
   * Checks whether the query contains comparison markers (e.g. "vs", "compared to").
   *
   * @param normalizedQuery - The normalized query to check.
   * @returns `true` if any comparison marker is present.
   */
  hasComparisonMarkers(normalizedQuery: string): boolean {
    return hasComparisonMarkers(normalizedQuery);
  }
}
