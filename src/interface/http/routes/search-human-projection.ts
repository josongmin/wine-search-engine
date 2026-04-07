/**
 * V1 → Human projection helpers.
 *
 * Projects the internal {@link SearchResponseV1} engine format to the
 * human-oriented {@link SearchResponseV2Human} representation, suitable
 * for browser/mobile clients.
 *
 * These helpers are consumed by route handlers when the client sends
 * `Accept: application/vnd.cuvee.human+json`.
 */

import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { ResultItem } from '../../../domain/response/model/result-item.js';
import type { SearchExecutorResult } from '../../../application/search/port/search-executor.port.js';
import type {
  ResultItemV2Human,
  SearchResponseV2Human,
  SearchResponseV2HumanComparison,
  SearchResponseV2HumanSearch,
} from '../schemas/search-response-v2.schema.js';

// ---------------------------------------------------------------------------
// Confidence normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise per-result confidence scores via min-max over relevanceScore values.
 * - Single result → 1.0.
 * - Multiple results → highest relevanceScore = 1.0, lowest = 0.0.
 * - Ties → equal confidence.
 */
function normaliseConfidences(items: readonly ResultItem[]): readonly number[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [1.0];
  const scores = items.map((i) => i.relevanceScore);
  let maxScore = -Infinity;
  let minScore = Infinity;
  for (const s of scores) {
    if (s > maxScore) maxScore = s;
    if (s < minScore) minScore = s;
  }
  const range = maxScore - minScore;
  if (range === 0) return items.map(() => 1.0);
  return scores.map((s) => (s - minScore) / range);
}

// ---------------------------------------------------------------------------
// Per-item projection
// ---------------------------------------------------------------------------

function projectResultItemToHuman(
  item: ResultItem,
  rank: number,
  confidence: number,
): ResultItemV2Human {
  const evidenceSummary =
    item.humanReadableEvidenceSummary ??
    item.evidenceItems[0]?.provenance ??
    'No evidence summary available';

  return {
    entityId: item.entity.entityId,
    canonicalLabel: item.entity.canonicalLabel,
    rank,
    ...(item.entity.producer !== undefined ? { producer: item.entity.producer } : {}),
    ...(item.entity.region !== undefined ? { region: item.entity.region } : {}),
    ...(item.entity.vintage !== undefined ? { vintage: item.entity.vintage } : {}),
    ...(item.entity.grapes !== undefined && item.entity.grapes.length > 0
      ? { grapePrimary: item.entity.grapes[0] }
      : {}),
    ...(item.drinkingWindow !== undefined
      ? {
          drinkingWindow: {
            start: item.drinkingWindow.drinkingWindowStart,
            end: item.drinkingWindow.drinkingWindowEnd,
          },
        }
      : {}),
    evidenceSummary,
    confidence,
    version: '2',
    responseType: 'human',
  };
}

// ---------------------------------------------------------------------------
// Full response projection
// ---------------------------------------------------------------------------

function projectSearchToHuman(
  v1Response: SearchResponseV1,
  queryId: string,
): SearchResponseV2HumanSearch {
  const confidences = normaliseConfidences(v1Response.results);
  const results = v1Response.results.map((item, index) =>
    projectResultItemToHuman(item, index + 1, confidences[index] ?? 1.0),
  );

  const totalCandidates =
    v1Response.results.length + (v1Response.counterfactuals?.length ?? 0);

  return {
    queryId,
    queryType: 'search',
    results,
    totalCandidates,
    ...(v1Response.engineDecision.authorityTraceRef ?? v1Response.meta.authorityTraceRef
      ? {
          authorityTraceRef:
            v1Response.engineDecision.authorityTraceRef ?? v1Response.meta.authorityTraceRef,
        }
      : {}),
    ...(v1Response.engineDecision.runtimeCorrelationRef ?? v1Response.meta.runtimeCorrelationRef
      ? {
          runtimeCorrelationRef:
            v1Response.engineDecision.runtimeCorrelationRef
            ?? v1Response.meta.runtimeCorrelationRef,
        }
      : {}),
    version: '2',
    responseType: 'human',
  };
}

function projectComparisonToHuman(
  comparison: ComparisonSearchResponse,
  queryId: string,
): SearchResponseV2Human {
  const projectSide = (
    entity: ComparisonSearchResponse['entities'][number],
  ): {
    subQuery: string;
    resolutionStatus: 'resolved' | 'ambiguous' | 'failed';
    resultCount: number;
    topResult: ResultItemV2Human | null;
  } => ({
    subQuery: entity.subQuery,
    resolutionStatus: entity.resolutionStatus,
    resultCount: entity.resultCount,
    topResult:
      entity.topResult !== null
        ? projectResultItemToHuman(entity.topResult, 1, 1.0)
        : null,
  });

  const entities: SearchResponseV2HumanComparison['entities'] = [
    projectSide(comparison.entities[0]),
    projectSide(comparison.entities[1]),
  ];

  return {
    queryId,
    queryType: 'comparison',
    originalQuery: comparison.originalQuery,
    comparisonIntent: comparison.comparisonIntent,
    overallStatus: comparison.overallStatus,
    entities,
    totalCandidates: entities[0].resultCount + entities[1].resultCount,
    ...(comparison.authorityTraceRef !== undefined
      ? { authorityTraceRef: comparison.authorityTraceRef }
      : {}),
    ...(comparison.runtimeCorrelationRef !== undefined
      ? { runtimeCorrelationRef: comparison.runtimeCorrelationRef }
      : {}),
    version: '2',
    responseType: 'human',
  };
}

/**
 * Projects a search executor result (V1 or Comparison) to a human-oriented response.
 */
export function projectToHumanResponse(
  response: SearchExecutorResult,
  queryId: string,
): SearchResponseV2Human {
  return response.queryType === 'search'
    ? projectSearchToHuman(response, queryId)
    : projectComparisonToHuman(response, queryId);
}
