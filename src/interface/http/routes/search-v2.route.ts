import type { FastifyInstance } from 'fastify';
import type { SearchRouteDeps } from './route-deps.js';
import type { InterpretRouteDeps } from './route-deps.js';
import type { HybridRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  HybridV2RouteContract,
  InterpretV2RouteContract,
  SearchV2RouteContract,
} from './route-contracts.js';
import { toSearchRequest, toHybridSearchRequest, toInterpretRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { ResultItem } from '../../../domain/response/model/result-item.js';
import type { SearchExecutorResult } from '../../../application/search/port/search-executor.port.js';
import {
  SearchResponseV2HumanSchema,
  InterpretResponseV2Schema,
} from '../schemas/search-response-v2.schema.js';
import type {
  ResultItemV2Human,
  SearchResponseV2Human,
  SearchResponseV2HumanComparison,
  SearchResponseV2HumanSearch,
} from '../schemas/search-response-v2.schema.js';

// ---------------------------------------------------------------------------
// V1 → V2 projection helpers
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
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const range = maxScore - minScore;
  if (range === 0) return items.map(() => 1.0);
  return scores.map((s) => (s - minScore) / range);
}

function projectResultItemToV2Human(
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

function projectV1SearchToV2HumanSearch(
  v1Response: SearchResponseV1,
  queryId: string,
): SearchResponseV2HumanSearch {
  const confidences = normaliseConfidences(v1Response.results);
  const results = v1Response.results.map((item, index) =>
    projectResultItemToV2Human(item, index + 1, confidences[index] ?? 1.0),
  );

  // totalCandidates is the pre-ranking candidate pool size. The V1 response
  // does not carry this value directly. The best available approximation is the
  // count of retained results plus evaluated-but-rejected candidates
  // (counterfactuals). This understates the true pre-ranking pool (candidates
  // eliminated before scoring are not reflected here) but is semantically
  // correct for what the V1 contract exposes.
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

function projectComparisonToV2Human(
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
        ? projectResultItemToV2Human(entity.topResult, 1, 1.0)
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

function projectSearchExecutorResultToV2Human(
  response: SearchExecutorResult,
  queryId: string,
): SearchResponseV2Human {
  return response.queryType === 'search'
    ? projectV1SearchToV2HumanSearch(response, queryId)
    : projectComparisonToV2Human(response, queryId);
}

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------

export type SearchV2RouteDeps = SearchRouteDeps & HybridRouteDeps & InterpretRouteDeps;

/**
 * POST /v2/search — V2 human-readable search.
 * Calls existing search use case; projects result to SearchResponseV2Human.
 */
export function registerSearchV2Route(
  app: FastifyInstance,
  deps: SearchV2RouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/search',
    contract: SearchV2RouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, SearchV2RouteContract);
      const searchRequest = toSearchRequest(parsed);

      const v1Response = await deps.searchUseCase.execute(
        searchRequest,
        getRequestId(request),
      );

      const queryId = getRequestId(request);
      const humanResponse = projectSearchExecutorResultToV2Human(v1Response, queryId);

      // Use sendContractResponse directly (not sendRouteContractResponse) to validate
      // the camelCase V2 payload against the camelCase V2 schema before Fastify's
      // preSerialization hook converts keys to snake_case for the wire format.
      sendContractResponse(request, reply, 200, SearchResponseV2HumanSchema, humanResponse);
    },
  });
}

/**
 * POST /v2/search/hybrid — V2 human-readable hybrid search.
 * Calls existing hybrid use case; projects result to SearchResponseV2Human.
 */
export function registerHybridV2Route(
  app: FastifyInstance,
  deps: SearchV2RouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/search/hybrid',
    contract: HybridV2RouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, HybridV2RouteContract);
      const hybridRequest = toHybridSearchRequest(parsed);

      const v1Response = await deps.hybridUseCase.execute(
        hybridRequest,
        getRequestId(request),
      );

      const queryId = getRequestId(request);
      const humanResponse = projectSearchExecutorResultToV2Human(v1Response, queryId);

      sendContractResponse(request, reply, 200, SearchResponseV2HumanSchema, humanResponse);
    },
  });
}

/**
 * POST /v2/search/interpret — V2 interpret/explain endpoint.
 * Calls interpret use case with buildV2: true; uses the canonical V2 explain
 * built by InterpretUseCase (which uses RetrievalProfileService.getChannelMix
 * for authoritative channel detection, rather than a manual heuristic).
 */
export function registerInterpretV2Route(
  app: FastifyInstance,
  deps: SearchV2RouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/search/interpret',
    contract: InterpretV2RouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, InterpretV2RouteContract);
      const interpretRequest = toInterpretRequest(parsed);

      const result = await deps.interpretUseCase.execute({
        ...interpretRequest,
        buildV2: true,
        requestId: getRequestId(request),
      });
      // NOTE: result.compiled (CompiledWineQuery) is available here but not currently used.
      // E1-U4 intent: callers can use compiled.execution.effectiveRoute for route-gating decisions.
      // If explain-mode or route-conditional response shaping is needed, read compiled here.
      const v2Response = result.v2Explain;

      sendContractResponse(request, reply, 200, InterpretResponseV2Schema, v2Response);
    },
  });
}
