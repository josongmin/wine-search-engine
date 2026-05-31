import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { AliasType } from '../../alias/model/alias.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import type { NormalizedQueryViews } from '../model/query-views.js';
import { parseSpans } from '../../attribute/service/span-parser.js';
import {
  isDirectEntityResolution,
  resolveEntity,
} from '../../attribute/service/entity-resolver.js';
import { RelativeQueryExtractor } from './relative-query-extractor.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';
import { buildAliasSurfaceLookupPlan } from './alias-lookup-plan.js';
import { isExactLikeLookupStrategy } from './lookup-strategy-taxonomy.js';
import { pickHigherTrustAliasType } from '../../alias/service/conflict-resolver.js';
import { extractRuleBasedConstraints } from './rule-based-constraint-extractor.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';

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
  /**
   * Domain alias type (RFC-003 §4) of the underlying alias record.
   *
   * SSoT for provenance — every matcher (PG-backed, snapshot, search-index,
   * in-memory) MUST populate this from the `alias_type` column / fixture
   * field so the resolver scorer can apply type-specific caps without
   * parsing `lookupStrategy` strings.
   *
   * Optional only to keep call-site migration incremental; downstream
   * consumers MUST treat `undefined` as legacy/unknown and fall back to
   * strategy-based inference.
   */
  readonly aliasType?: AliasType | undefined;
}

export type AliasLookupScope = 'surface' | 'span';
export type AliasRecallMode = 'surface_only';

export interface AliasLookupOptions {
  readonly scope?: AliasLookupScope;
  readonly recallMode?: AliasRecallMode | undefined;
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
  findMatches(
    normalizedQuery: string,
    options?: AliasLookupOptions,
  ): Promise<readonly AliasMatchResult[]>;
  /**
   * Optional bulk lookup for request-scoped batches of normalized queries.
   *
   * Hot-path alias substrates should implement this to avoid repeated
   * downstream I/O when the planner expands a single user query into multiple
   * lookup variants/spans.
   */
  findMatchesBatch?(
    normalizedQueries: readonly string[],
    options?: AliasLookupOptions,
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

/**
 * Phrase-level idiom / temporal anti-patterns that locally use comparison
 * particles ("같은", "처럼", "보다") in a non-anchor sense. When the marker
 * surface is dominated by one of these, marker detection must NOT flag the
 * query as a mixed/comparison query.
 *
 * Bumps nlu.anchor-extraction maturity 3 → 4. The list intentionally targets
 * temporal connectives and idiomatic similes — the highest-frequency
 * false-positive class surfaced in the maturity-3 audit (e.g. "어제와 같은
 * 와인" matched "같은" with no entity adjacency).
 */
const KOREAN_MARKER_IDIOM_ANTIPATTERNS: readonly RegExp[] = [
  // Temporal "X와/과 같은" — "same as yesterday/today/...".
  /(?:어제|오늘|내일|모레|아까|방금|지금|예전|작년|올해|평소|평상시)(?:와|과)\s*같은/u,
  // "X처럼" attached to non-entity descriptive nouns commonly mined as
  // false positives in the audit (e.g. "가솔린처럼"). 처럼 is currently NOT in
  // KOREAN_MIXED_QUERY_MARKERS, but the comparison-marker surface guards
  // against the same idiom for symmetry / future-proofing.
  /(?:가솔린|물|불|꿀|기름)처럼/u,
] as const;

/**
 * Strip idiomatic / temporal occurrences of comparison particles from the
 * query so that downstream marker regex tests only see "real" comparison
 * surfaces. This keeps the SSoT marker list intact while eliminating the
 * dominant false-positive class without coupling to entity span detection.
 */
function stripKoreanMarkerIdioms(normalizedQuery: string): string {
  let stripped = normalizedQuery;
  for (const re of KOREAN_MARKER_IDIOM_ANTIPATTERNS) {
    stripped = stripped.replace(new RegExp(re.source, 'gu'), ' ');
  }
  return stripped;
}

/** Latin-script comparison markers. */
const COMPARISON_MARKERS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})vs\.?(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})versus(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})compared?\s+to(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:비교|비교하면|차이|어느|뭐가)(?=$|[^\p{L}\p{N}])/u,
  /(?:와|과|랑|하고|이랑)\s+.+?\s+(?:중|비교|비교해|비교해줘|비교하면|뭐가|어떤|차이|어느)(?:$|[^\p{L}\p{N}])/u,
] as const;

/**
 * Keep this aligned with planner exact-anchor semantics.
 *
 * Span expansion is a recall path. Once the base query views already admit a
 * single exact-like entity hypothesis above the exact-anchor bar, span-level
 * fallbacks must not inject weaker producer-family collisions into the anchor
 * set.
 */
const EXACT_LIKE_SPAN_SHORT_CIRCUIT_CONFIDENCE = 0.85;

function normalizeLookupStrategyPart(part: string): string {
  return part.startsWith('index_') ? part.slice('index_'.length) : part;
}

function trimDeduped(values: Iterable<string>): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function normalizeConstraintSurface(value: string): string {
  return buildAliasSurfaceLookupPlan(value).views.punctuationStripped;
}

function tokenizeConstraintSurface(value: string): readonly string[] {
  return normalizeConstraintSurface(value)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function spanContains(
  container: { startChar: number; endChar: number },
  candidate: { startChar: number; endChar: number },
): boolean {
  return (
    container.startChar <= candidate.startChar
    && container.endChar >= candidate.endChar
    && (container.startChar !== candidate.startChar || container.endChar !== candidate.endChar)
  );
}

export function splitLookupStrategies(strategy: string | undefined): readonly string[] {
  if (strategy === undefined) {
    return [];
  }
  return [...new Set(
    strategy
      .split('+')
      .map((part) => normalizeLookupStrategyPart(part.trim()))
      .filter((part) => part.length > 0),
  )];
}

interface LookupQuerySet {
  readonly baseQueries: readonly string[];
  readonly spanQueries: readonly LookupQueryPlan[];
}

interface ScopedLookupQuery {
  readonly query: string;
  readonly scope: AliasLookupScope;
  readonly recallMode?: AliasRecallMode | undefined;
}

interface LookupQueryPlan {
  readonly query: string;
  readonly recallMode?: AliasRecallMode | undefined;
}

export function hasKoreanMixedQueryMarkers(normalizedQuery: string): boolean {
  const filtered = stripKoreanMarkerIdioms(normalizedQuery);
  return KOREAN_MIXED_QUERY_MARKERS.some((re) => re.test(filtered));
}

export function hasComparisonMarkers(normalizedQuery: string): boolean {
  const filtered = stripKoreanMarkerIdioms(normalizedQuery);
  return COMPARISON_MARKERS.some((re) => re.test(filtered));
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
    const extraBaseQueries = new Set<string>();

    for (const anchorSurface of relativeQuery?.relativeExpressions.map((expr) => expr.anchorSurfaceForm) ?? []) {
      const trimmed = anchorSurface.trim();
      if (trimmed.length > 0) {
        extraBaseQueries.add(trimmed);
      }
    }

    const anchors = await this.extractFromLookupQueries(
      this.buildLookupQueries(normalizedQuery, queryViews, extraBaseQueries),
    );

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
    extraBaseQueries: Iterable<string> = [],
  ): LookupQuerySet {
    const baseQueries: string[] = [];
    const spanQueries: LookupQueryPlan[] = [];
    const seenBase = new Set<string>();
    const seenSpanRecallMode = new Map<string, AliasRecallMode | undefined>();
    const add = (target: string[], seen: Set<string>, value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      target.push(trimmed);
    };
    const addSpanQuery = (value: string, recallMode?: AliasRecallMode): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return;
      }
      const existingRecallMode = seenSpanRecallMode.get(trimmed);
      const nextRecallMode = existingRecallMode === 'surface_only' || recallMode === 'surface_only'
        ? 'surface_only'
        : undefined;
      if (existingRecallMode !== undefined || seenSpanRecallMode.has(trimmed)) {
        if (existingRecallMode !== nextRecallMode) {
          seenSpanRecallMode.set(trimmed, nextRecallMode);
          const existingIndex = spanQueries.findIndex((entry) => entry.query === trimmed);
          if (existingIndex >= 0) {
            spanQueries[existingIndex] = {
              query: trimmed,
              ...(nextRecallMode !== undefined ? { recallMode: nextRecallMode } : {}),
            };
          }
        }
        return;
      }
      seenSpanRecallMode.set(trimmed, nextRecallMode);
      spanQueries.push({
        query: trimmed,
        ...(nextRecallMode !== undefined ? { recallMode: nextRecallMode } : {}),
      });
    };

    const lookupPlan = buildAliasSurfaceLookupPlan(normalizedQuery, queryViews);
    const primaryQueries = lookupPlan.tokenList;
    for (const query of primaryQueries) {
      add(baseQueries, seenBase, query);
    }
    for (const query of extraBaseQueries) {
      add(baseQueries, seenBase, query);
    }

    // Exact substrate keeps the aggressive whole-surface variants (compact,
    // transliterated compact, phonetic) because those are exact-owner rails.
    // Span expansion is different: synthetic compact full-surface variants do
    // not add new span structure, but they can open broad-recall indexes on
    // the first cold request. Restrict span seeds to human-readable variants.
    const spanSeedQueries = trimDeduped([
      ...lookupPlan.views.semanticVariants,
      ...extraBaseQueries,
    ]);
    for (const query of spanSeedQueries) {
      const parsedSpans = parseSpans(query);
      const surfaceOnlyAtomicSpans = this.collectSurfaceOnlyAtomicSpans(parsedSpans);
      const deterministicConstraintTokens = tokenizeConstraintSurface(query).length > 1
        ? this.collectDeterministicConstraintTokens(query)
        : new Set<string>();
      for (const span of parsedSpans) {
        const spanTokens = tokenizeConstraintSurface(span.text);
        if (
          deterministicConstraintTokens.size > 0
          && spanTokens.length > 0
          && spanTokens.every((token) => deterministicConstraintTokens.has(token))
        ) {
          continue;
        }
        addSpanQuery(
          span.text,
          span.tokenCount === 1 && surfaceOnlyAtomicSpans.has(span.text)
            ? 'surface_only'
            : undefined,
        );
      }
    }

    return { baseQueries, spanQueries };
  }

  private collectDeterministicConstraintTokens(normalizedQuery: string): ReadonlySet<string> {
    const coveredTokens = new Set<string>();
    const deterministicConstraints = extractRuleBasedConstraints(normalizedQuery);
    for (const constraint of [
      ...deterministicConstraints.hard,
      ...deterministicConstraints.soft,
      ...deterministicConstraints.inferred,
    ]) {
      for (const token of tokenizeConstraintSurface(constraint.source_phrase)) {
        coveredTokens.add(token);
      }
    }
    for (const span of parseSpans(normalizedQuery)) {
      const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
      if (!isDirectEntityResolution(resolved)) {
        continue;
      }
      for (const token of tokenizeConstraintSurface(resolved.matchedSurface)) {
        coveredTokens.add(token);
      }
    }
    return coveredTokens;
  }

  private collectSurfaceOnlyAtomicSpans(
    spans: readonly {
      text: string;
      startChar: number;
      endChar: number;
      tokenCount: number;
    }[],
  ): ReadonlySet<string> {
    const surfaceOnly = new Set<string>();
    for (const span of spans) {
      if (span.tokenCount !== 1) {
        continue;
      }
      if (this.isAtomicSpanShieldedByDeterministicConstraint(span, spans)) {
        surfaceOnly.add(span.text);
      }
    }
    return surfaceOnly;
  }

  private isAtomicSpanShieldedByDeterministicConstraint(
    targetSpan: {
      text: string;
      startChar: number;
      endChar: number;
      tokenCount: number;
    },
    spans: readonly {
      text: string;
      startChar: number;
      endChar: number;
      tokenCount: number;
    }[],
  ): boolean {
    for (const span of spans) {
      if (
        span.tokenCount <= targetSpan.tokenCount
        || !spanContains(span, targetSpan)
      ) {
        continue;
      }
      if (this.longerSpanCarriesDeterministicConstraintToken(span.text, targetSpan.text)) {
        return true;
      }
    }
    return false;
  }

  private longerSpanCarriesDeterministicConstraintToken(
    longerSpanText: string,
    atomicSpanText: string,
  ): boolean {
    const atomicTokens = tokenizeConstraintSurface(atomicSpanText);
    if (atomicTokens.length !== 1) {
      return false;
    }
    const atomicToken = atomicTokens[0]!;
    const longerResolved = resolveEntity(longerSpanText, { preferEntityOverStyle: true });
    if (
      isDirectEntityResolution(longerResolved)
      && tokenizeConstraintSurface(longerResolved.matchedSurface).includes(atomicToken)
    ) {
      return true;
    }

    const deterministicConstraints = extractRuleBasedConstraints(longerSpanText);
    for (const constraint of [
      ...deterministicConstraints.hard,
      ...deterministicConstraints.soft,
      ...deterministicConstraints.inferred,
    ]) {
      if (tokenizeConstraintSurface(constraint.source_phrase).includes(atomicToken)) {
        return true;
      }
    }
    return false;
  }

  private async extractFromLookupQueries(
    lookupQueries: LookupQuerySet,
  ): Promise<readonly AnchorCandidate[]> {
    const aliasMatches = await this.lookupAliasMatchesWithSpanFallback(lookupQueries);

    const candidates: AnchorCandidate[] = aliasMatches.map((match) => ({
      surfaceForm: match.surfaceForm,
      normalizedForm: match.normalizedForm,
      candidateEntityIds: match.entityIds,
      lookupVariants: match.lookupVariants,
      ...(match.lookupStrategy !== undefined
        ? { lookupStrategies: splitLookupStrategies(match.lookupStrategy) }
        : {}),
      ...(match.aliasType !== undefined ? { aliasType: match.aliasType } : {}),
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

  private async lookupAliasMatchesWithSpanFallback(
    lookupQueries: LookupQuerySet,
  ): Promise<readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[]> {
    const baseQueries = lookupQueries.baseQueries.map((query) => ({
      query,
      scope: 'surface' as const,
    }));
    const baseMatches = await this.lookupAliasMatches(
      baseQueries,
    );
    if (
      lookupQueries.spanQueries.length === 0 ||
      this.shouldShortCircuitSpanExpansion(baseMatches)
    ) {
      return baseMatches;
    }

    const spanMatches = await this.lookupAliasMatches(
      lookupQueries.spanQueries.map((queryPlan) => ({
        query: queryPlan.query,
        scope: 'span' as const,
        ...(queryPlan.recallMode !== undefined ? { recallMode: queryPlan.recallMode } : {}),
      })),
    );
    return this.mergeLookupMatches(baseMatches, spanMatches);
  }

  private shouldShortCircuitSpanExpansion(
    matches: readonly AliasMatchResult[],
  ): boolean {
    const exactLikeMatches = matches.filter((match) => this.hasExactLikeStrategy(match.lookupStrategy));
    if (exactLikeMatches.length === 0) {
      return false;
    }

    const exactEntityIds = new Set(
      exactLikeMatches.flatMap((match) => match.entityIds.map(String)),
    );
    if (exactEntityIds.size !== 1) {
      return false;
    }

    return exactLikeMatches.some(
      (match) => match.matchConfidence >= EXACT_LIKE_SPAN_SHORT_CIRCUIT_CONFIDENCE,
    );
  }

  private hasExactLikeStrategy(strategy: string | undefined): boolean {
    return splitLookupStrategies(strategy)
      .some((part) => isExactLikeLookupStrategy(part));
  }

  private async lookupAliasMatches(
    lookupQueries: readonly ScopedLookupQuery[],
  ): Promise<readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[]> {
    const normalizedLookupQueries = lookupQueries
      .map(({ query, scope, recallMode }) => ({
        query: query.trim(),
        scope,
        ...(recallMode !== undefined ? { recallMode } : {}),
      }))
      .filter(({ query }) => query.length > 0);
    const effectiveBatchMatches = await this.lookupAliasMatchesBatch(normalizedLookupQueries);
    const merged = new Map<
      string,
      {
        match: AliasMatchResult;
        confidence: number;
        priority: number;
        readonly lookupVariants: Set<string>;
        readonly lookupStrategies: Set<string>;
        aliasType: AliasType | undefined;
      }
    >();

    for (const [priority, lookupQuery] of normalizedLookupQueries.entries()) {
      const trimmedLookupQuery = lookupQuery.query;
      if (trimmedLookupQuery.length === 0) {
        continue;
      }

      const lookupKey = this.createScopedLookupKey(lookupQuery);
      const aliasMatches = effectiveBatchMatches.get(lookupKey)
        ?? await this.aliasMatcher.findMatches(trimmedLookupQuery, {
          scope: lookupQuery.scope,
          ...(lookupQuery.recallMode !== undefined ? { recallMode: lookupQuery.recallMode } : {}),
        });
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
            aliasType: pickHigherTrustAliasType(existing?.aliasType, match.aliasType),
          });
        } else {
          // Even when this row is not the new leader, fold its provenance:
          // higher-trust alias_type wins. A sibling curated match arriving
          // after a derived one must lift the merged type back to canonical,
          // otherwise the resolver scorer's derived-initialism cap fires on
          // an anchor that already has canonical evidence.
          existing.aliasType = pickHigherTrustAliasType(existing.aliasType, match.aliasType);
        }

        merged.get(key)?.lookupVariants.add(trimmedLookupQuery);
        if (match.lookupStrategy !== undefined) {
          merged.get(key)?.lookupStrategies.add(match.lookupStrategy);
        }
      }

      if (this.shouldShortCircuitOrderedLookup(this.materializeMergedMatches(merged))) {
        return this.materializeMergedMatches(merged);
      }
    }

    return this.materializeMergedMatches(merged);
  }

  private async lookupAliasMatchesBatch(
    lookupQueries: readonly ScopedLookupQuery[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const groupedQueries = new Map<string, {
      scope: AliasLookupScope;
      recallMode?: AliasRecallMode | undefined;
      queries: string[];
    }>();
    for (const lookupQuery of lookupQueries) {
      const trimmed = lookupQuery.query.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const groupKey = this.createBatchGroupKey(lookupQuery);
      const existing = groupedQueries.get(groupKey);
      if (existing !== undefined) {
        existing.queries.push(trimmed);
        continue;
      }
      groupedQueries.set(groupKey, {
        scope: lookupQuery.scope,
        ...(lookupQuery.recallMode !== undefined ? { recallMode: lookupQuery.recallMode } : {}),
        queries: [trimmed],
      });
    }

    const scopedMatches = new Map<string, readonly AliasMatchResult[]>();
    for (const group of groupedQueries.values()) {
      const queries = group.queries;
      if (queries.length === 0) {
        continue;
      }
      const batch = this.aliasMatcher.findMatchesBatch !== undefined
        ? await this.aliasMatcher.findMatchesBatch(queries, {
          scope: group.scope,
          ...(group.recallMode !== undefined ? { recallMode: group.recallMode } : {}),
        })
        : undefined;
      if (batch === undefined) {
        continue;
      }
      for (const query of queries) {
        scopedMatches.set(
          this.createScopedLookupKey({
            query,
            scope: group.scope,
            ...(group.recallMode !== undefined ? { recallMode: group.recallMode } : {}),
          }),
          batch.get(query) ?? [],
        );
      }
    }

    return scopedMatches;
  }

  private createBatchGroupKey(lookupQuery: ScopedLookupQuery): string {
    return `${lookupQuery.scope}\u0000${lookupQuery.recallMode ?? 'default'}`;
  }

  private createScopedLookupKey(lookupQuery: ScopedLookupQuery): string {
    return `${lookupQuery.scope}\u0000${lookupQuery.recallMode ?? 'default'}\u0000${lookupQuery.query.trim()}`;
  }

  private mergeLookupMatches(
    primary: readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[],
    secondary: readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[],
  ): readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[] {
    const merged = new Map<
      string,
      {
        match: AliasMatchResult;
        confidence: number;
        priority: number;
        readonly lookupVariants: Set<string>;
        readonly lookupStrategies: Set<string>;
        aliasType: AliasType | undefined;
      }
    >();

    const addMatches = (
      matches: readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[],
      priority: number,
    ): void => {
      for (const match of matches) {
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
            aliasType: pickHigherTrustAliasType(existing?.aliasType, match.aliasType),
          });
        } else {
          existing.aliasType = pickHigherTrustAliasType(existing.aliasType, match.aliasType);
        }

        const mergedEntry = merged.get(key);
        if (mergedEntry !== undefined) {
          for (const lookupVariant of match.lookupVariants) {
            mergedEntry.lookupVariants.add(lookupVariant);
          }
        }
        for (const strategy of splitLookupStrategies(match.lookupStrategy)) {
          mergedEntry?.lookupStrategies.add(strategy);
        }
      }
    };

    addMatches(primary, 0);
    addMatches(secondary, 1);

    return this.materializeMergedMatches(merged);
  }

  private shouldShortCircuitOrderedLookup(
    matches: readonly AliasMatchResult[],
  ): boolean {
    const exactLikeMatches = matches.filter((match) => this.hasExactLikeStrategy(match.lookupStrategy));
    if (exactLikeMatches.length === 0) {
      return false;
    }

    const exactEntityIds = new Set(
      exactLikeMatches.flatMap((match) => match.entityIds.map(String)),
    );
    if (exactEntityIds.size !== 1) {
      return false;
    }

    return exactLikeMatches.some(
      (match) => match.matchConfidence >= EXACT_LIKE_SPAN_SHORT_CIRCUIT_CONFIDENCE,
    );
  }

  private materializeMergedMatches(
    merged: Map<
      string,
      {
        match: AliasMatchResult;
        confidence: number;
        priority: number;
        readonly lookupVariants: Set<string>;
        readonly lookupStrategies: Set<string>;
        aliasType: AliasType | undefined;
      }
    >,
  ): readonly (AliasMatchResult & { readonly lookupVariants: readonly string[] })[] {
    return [...merged.values()]
      .sort((left, right) => {
        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }
        return left.priority - right.priority;
      })
      .map(({ match, lookupVariants, lookupStrategies, aliasType }) => ({
        ...match,
        lookupVariants: [...lookupVariants],
        ...(lookupStrategies.size > 0
          ? { lookupStrategy: [...lookupStrategies].sort().join('+') }
          : {}),
        ...(aliasType !== undefined ? { aliasType } : {}),
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
    } catch (err) {
      // Degradation is intentional: callers treat an empty result map as
      // "no fuzzy matches" and the query still completes. But the failure
      // must be observable rather than silently swallowed.
      bootstrapLogger.warn(
        { err },
        '[AnchorExtractor] fuzzy term batch lookup failed; returning empty',
      );
      globalSilentSkipCounter.increment('anchor_fuzzy_term_batch_lookup_failure');
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
