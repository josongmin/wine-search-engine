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
import { clamp01 } from '../../../domain/shared/utils/clamp.js';
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
 * Per-result confidence = the calibrated `relevanceScore` directly.
 *
 * `relevanceScore` is sourced from `RankedResult.finalScore` which is bounded
 * to [0, 1] by ScoreAggregator (Math.max(0, Math.min(MAX_SCORE=1.0, ...)))
 * and remains in [0, 1] after rerank blending (linear combination of two
 * [0, 1] values with weights summing to 1).
 *
 * The previous min-max rescaling was a UX bug: it produced literal 0.0 for the
 * lowest item even when its underlying relevanceScore was high (top=0.95 /
 * bottom=0.93). The 0.5 floor variant only made the lie less extreme (50% vs
 * 0%) — both decoupled displayed confidence from actual relevance.
 *
 * Clamp is defensive against upstream corruption; should be a no-op.
 */
function normaliseConfidences(items: readonly ResultItem[]): readonly number[] {
  // clamp01 already handles non-finite → 0; the explicit isFinite check is
  // retained as documentation and to short-circuit the warning emission.
  return items.map((i) => clamp01(i.relevanceScore));
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
    ...(item.entity.closure !== undefined ? { closure: item.entity.closure } : {}),
    ...(item.entity.country !== undefined ? { country: item.entity.country } : {}),
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

function projectResultItemWithIntrinsicConfidence(
  item: ResultItem,
  rank: number,
): ResultItemV2Human {
  return projectResultItemToHuman(item, rank, clamp01(item.relevanceScore));
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

  // Resolve refs ONCE then check explicitly for non-empty string. The previous
  // pattern `(a ?? b ? { x: a ?? b } : {})` evaluated `??` then truthiness:
  // an empty string `""` satisfied `??` but was falsy → property silently dropped,
  // breaking trace correlation joins for clients that store empty strings.
  const authorityTraceRef =
    v1Response.engineDecision.authorityTraceRef ?? v1Response.meta.authorityTraceRef;
  const runtimeCorrelationRef =
    v1Response.engineDecision.runtimeCorrelationRef ?? v1Response.meta.runtimeCorrelationRef;
  return {
    queryId,
    queryType: 'search',
    results,
    totalCandidates,
    ...(typeof authorityTraceRef === 'string' && authorityTraceRef.length > 0
      ? { authorityTraceRef }
      : {}),
    ...(typeof runtimeCorrelationRef === 'string' && runtimeCorrelationRef.length > 0
      ? { runtimeCorrelationRef }
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
    comparisonMode?: 'entity' | 'concept';
    canonicalConcept?: string;
    conceptEntityType?: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type';
    conceptAggregate?: {
      canonicalConcept: string;
      conceptEntityType: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type';
      representativeResult: ResultItemV2Human | null;
      prototypeAxis: ResultItemV2Human[];
      aggregateResultCount: number;
    };
    resolutionStatus: 'resolved' | 'ambiguous' | 'failed';
    resultCount: number;
    topResult: ResultItemV2Human | null;
  } => ({
    subQuery: entity.subQuery,
    ...(entity.comparisonMode !== undefined ? { comparisonMode: entity.comparisonMode } : {}),
    ...(entity.canonicalConcept !== undefined ? { canonicalConcept: entity.canonicalConcept } : {}),
    ...(entity.conceptEntityType !== undefined ? { conceptEntityType: entity.conceptEntityType } : {}),
    ...(entity.conceptAggregate !== undefined
      ? {
          conceptAggregate: {
            canonicalConcept: entity.conceptAggregate.canonicalConcept,
            conceptEntityType: entity.conceptAggregate.conceptEntityType,
            representativeResult:
              entity.conceptAggregate.representativeResult !== null
                ? projectResultItemWithIntrinsicConfidence(entity.conceptAggregate.representativeResult, 1)
                : null,
            prototypeAxis: entity.conceptAggregate.prototypeAxis.map((item, index) =>
              projectResultItemWithIntrinsicConfidence(item, index + 1)),
            aggregateResultCount: entity.conceptAggregate.aggregateResultCount,
          },
        }
      : {}),
    resolutionStatus: entity.resolutionStatus,
    resultCount: entity.resultCount,
    topResult:
      entity.topResult !== null
        ? projectResultItemWithIntrinsicConfidence(entity.topResult, 1)
        : null,
  });

  // ComparisonSearchResponse.entities is a tuple [Entity, Entity] — TypeScript
  // guarantees both indexes at compile time. The runtime tuple shape is also
  // enforced by the response schema (z.tuple) so no extra defense needed here.
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
    ...(typeof comparison.authorityTraceRef === 'string' && comparison.authorityTraceRef.length > 0
      ? { authorityTraceRef: comparison.authorityTraceRef }
      : {}),
    ...(typeof comparison.runtimeCorrelationRef === 'string' && comparison.runtimeCorrelationRef.length > 0
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
