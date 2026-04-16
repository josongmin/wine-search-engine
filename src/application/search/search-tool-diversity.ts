import type { SearchExecutorPort, SearchExecutorResult } from './port/search-executor.port.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';
import { WINE_TYPE_DETECTION_PATTERNS, type WineTypeValue } from '../../domain/query/model/wine-type-patterns.js';
import type { CorpusCardinalityCache } from '../../domain/retrieval/service/corpus-cardinality-cache.js';
import { CORPUS_LIMITED_THRESHOLD } from '../../domain/retrieval/service/corpus-cardinality-cache.js';

export const SEARCH_TOOL_DIVERSITY_MIN_LIMIT = 5;
export const SEARCH_TOOL_DIVERSITY_WINE_TYPES = ['white', 'sparkling', 'red'] as const satisfies readonly WineTypeValue[];
export const SEARCH_TOOL_DIVERSITY_LIMIT_PER_TYPE = 3;
export const SEARCH_TOOL_WANTS_DIVERSITY_RE = /(?:^|[^\p{L}\p{N}])(?:diverse|different|다른|다르게|각각|variety)(?=$|[^\p{L}\p{N}])/iu;

export function queryMentionsWineType(query: string): boolean {
  return WINE_TYPE_DETECTION_PATTERNS.some((pattern) => pattern.test(query));
}

export function shouldRunTypedWineDiversityDiscovery(input: {
  readonly query: string;
  readonly wantsDiversity: boolean;
  readonly wineType?: WineTypeValue | undefined;
}): boolean {
  if (!input.wantsDiversity) return false;
  if (input.wineType !== undefined) return false;
  if (queryMentionsWineType(input.query)) return false;
  return true;
}

export function withWineTypeFilter(
  filters: readonly NormalizedConstraint[],
  wineType: WineTypeValue,
  mappingVersion = 'search_tool_diversity_v1',
): readonly NormalizedConstraint[] {
  return [
    ...filters.filter((filter) => filter.attribute !== 'wine_type'),
    {
      attribute: 'wine_type',
      operator: '=',
      value: wineType,
      source_phrase: wineType,
      confidence: 1.0,
      mapping_version: mappingVersion,
    } satisfies NormalizedConstraint,
  ];
}

function buildDiversityAxes(result: SearchResponseV1['results'][number]): readonly string[] {
  const axes = new Set<string>();
  const wineType = result.entity.wineType?.trim().toLowerCase();
  if (wineType !== undefined && wineType.length > 0) axes.add(`wine_type:${wineType}`);
  const producer = result.entity.producer?.trim().toLowerCase();
  if (producer !== undefined && producer.length > 0) axes.add(`producer:${producer}`);
  const region = result.entity.region?.trim().toLowerCase();
  if (region !== undefined && region.length > 0) axes.add(`region:${region}`);
  for (const grape of result.entity.grapes ?? []) {
    const normalized = grape.trim().toLowerCase();
    if (normalized.length > 0) axes.add(`grape:${normalized}`);
  }
  return [...axes];
}

function mergeDiverseSearchResults(
  responses: readonly SearchResponseV1[],
  limit: number,
): readonly SearchResponseV1['results'][number][] {
  const byId = new Map<string, SearchResponseV1['results'][number]>();
  for (const response of responses) {
    for (const result of response.results) {
      const existing = byId.get(result.entity.entityId);
      if (
        existing === undefined
        || (typeof result.relevanceScore === 'number'
          && typeof existing.relevanceScore === 'number'
          && result.relevanceScore > existing.relevanceScore)
      ) {
        byId.set(result.entity.entityId, result);
      }
    }
  }

  const candidates = [...byId.values()].sort((left, right) => right.relevanceScore - left.relevanceScore);
  if (candidates.length <= limit) {
    return candidates;
  }

  const selected: SearchResponseV1['results'][number][] = [];
  const selectedIds = new Set<string>();
  const coveredAxes = new Set<string>();

  while (selected.length < limit) {
    let bestCandidate: SearchResponseV1['results'][number] | undefined;
    let bestNoveltyScore = -1;
    let bestRelevanceScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      if (selectedIds.has(candidate.entity.entityId)) continue;
      const noveltyScore = buildDiversityAxes(candidate)
        .reduce((score, axis) => score + (coveredAxes.has(axis) ? 0 : 1), 0);
      const relevanceScore = candidate.relevanceScore;
      if (
        noveltyScore > bestNoveltyScore
        || (noveltyScore === bestNoveltyScore && relevanceScore > bestRelevanceScore)
      ) {
        bestCandidate = candidate;
        bestNoveltyScore = noveltyScore;
        bestRelevanceScore = relevanceScore;
      }
    }

    if (bestCandidate === undefined) break;
    selected.push(bestCandidate);
    selectedIds.add(bestCandidate.entity.entityId);
    for (const axis of buildDiversityAxes(bestCandidate)) {
      coveredAxes.add(axis);
    }
  }

  return selected;
}

function getTopResultRelevanceScore(response: SearchResponseV1): number {
  const topResult = response.results[0];
  if (topResult === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  return Number.isFinite(topResult.relevanceScore)
    ? topResult.relevanceScore
    : Number.NEGATIVE_INFINITY;
}

function mergeUniqueStrings(
  values: ReadonlyArray<readonly string[] | undefined>,
): readonly string[] | undefined {
  const merged = values.flatMap((value) => value ?? []);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function mergeCounterfactuals(
  responses: readonly SearchResponseV1[],
): SearchResponseV1['counterfactuals'] {
  const merged = responses.flatMap((response) => response.counterfactuals ?? []);
  if (merged.length === 0) {
    return undefined;
  }

  const byKey = new Map<string, typeof merged[number]>();
  for (const counterfactual of merged) {
    const key = [
      counterfactual.entityId,
      counterfactual.rejectionType,
      counterfactual.rejectedReason,
      counterfactual.evidenceRef ?? '',
    ].join('::');
    byKey.set(key, counterfactual);
  }
  return [...byKey.values()];
}

export function mergeSearchResponsesForDiversityDiscovery(
  responses: readonly SearchResponseV1[],
  requestId: string,
  limit: number,
): SearchResponseV1 {
  const primary = [...responses]
    .sort((left, right) => getTopResultRelevanceScore(right) - getTopResultRelevanceScore(left))[0]
    ?? responses[0]!;
  const mergedDegradationReasons = mergeUniqueStrings(
    responses.map((response) => response.meta.degradationReasons ?? response.engineDecision.degradationReasons),
  );
  const degraded = responses.some(
    (response) =>
      response.meta.executionMode === 'degraded'
      || response.engineDecision.executionMode === 'degraded'
      || (response.meta.degradationReasons?.length ?? 0) > 0
      || (response.engineDecision.degradationReasons?.length ?? 0) > 0,
  );
  const mergedCounterfactuals = mergeCounterfactuals(responses);
  const mergedDebugRefs = mergeUniqueStrings(responses.map((response) => response.meta.debugRefs));
  let maxQueryTimeMs = 0;
  for (const response of responses) {
    if (response.meta.queryTimeMs > maxQueryTimeMs) {
      maxQueryTimeMs = response.meta.queryTimeMs;
    }
  }

  return {
    ...primary,
    engineDecision: {
      ...primary.engineDecision,
      ...(degraded ? { executionMode: 'degraded' as const } : {}),
      ...(mergedDegradationReasons !== undefined ? { degradationReasons: mergedDegradationReasons } : {}),
      ...(primary.engineDecision.runtimeCorrelationRef !== undefined || requestId.length > 0
        ? { runtimeCorrelationRef: requestId }
        : {}),
    },
    results: mergeDiverseSearchResults(responses, limit),
    ...(mergedCounterfactuals !== undefined ? { counterfactuals: mergedCounterfactuals } : {}),
    meta: {
      ...primary.meta,
      requestId,
      runtimeCorrelationRef: requestId,
      queryTimeMs: maxQueryTimeMs,
      ...(degraded ? { executionMode: 'degraded' as const } : {}),
      ...(mergedDegradationReasons !== undefined ? { degradationReasons: mergedDegradationReasons } : {}),
      ...(mergedDebugRefs !== undefined ? { debugRefs: mergedDebugRefs } : {}),
    },
  };
}

export async function executeSearchWithTypedWineDiversityDiscovery(input: {
  readonly searchUseCase: SearchExecutorPort;
  readonly requestId: string;
  readonly fallbackRequest: SearchRequest;
  readonly effectiveLimit: number;
  readonly shouldRun: boolean;
  readonly buildTypedRequest: (wineType: WineTypeValue) => SearchRequest;
  readonly abortSignal?: AbortSignal | undefined;
  /** When provided, wine types with fewer than CORPUS_LIMITED_THRESHOLD entities are skipped. */
  readonly corpusCardinality?: CorpusCardinalityCache | undefined;
}): Promise<SearchExecutorResult> {
  if (!input.shouldRun) {
    return input.searchUseCase.execute(
      input.fallbackRequest,
      input.requestId,
      { ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}) },
    );
  }

  // Filter out wine types whose corpus is too small for meaningful diversity discovery.
  const eligibleTypes = input.corpusCardinality
    ? SEARCH_TOOL_DIVERSITY_WINE_TYPES.filter(
        (wt) => (input.corpusCardinality!.getTypeCount(wt) ?? 0) >= CORPUS_LIMITED_THRESHOLD,
      )
    : SEARCH_TOOL_DIVERSITY_WINE_TYPES;

  if (eligibleTypes.length === 0) {
    // All types below threshold — fall back to untyped search
    return input.searchUseCase.execute(
      input.fallbackRequest,
      input.requestId,
      { ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}) },
    );
  }

  const typedResponses = await Promise.all(
    eligibleTypes.map((wineType) =>
      input.searchUseCase.execute(
        input.buildTypedRequest(wineType),
        `${input.requestId}:diversity:${wineType}`,
        { ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}) },
      ),
    ),
  );

  const successfulTypedResponses = typedResponses.filter(
    (typed): typed is SearchResponseV1 => typed.queryType === 'search',
  );
  if (successfulTypedResponses.length > 0) {
    return mergeSearchResponsesForDiversityDiscovery(
      successfulTypedResponses,
      input.requestId,
      input.effectiveLimit,
    );
  }

  return input.searchUseCase.execute(
    input.fallbackRequest,
    input.requestId,
    { ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}) },
  );
}
