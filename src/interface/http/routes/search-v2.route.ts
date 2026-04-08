import type { FastifyInstance } from 'fastify';
import type { SearchRouteDeps, InterpretRouteDeps, HybridRouteDeps } from './route-deps.js';
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
import { projectToHumanResponse } from './search-human-projection.js';
import {
  SearchResponseV2HumanSchema,
  InterpretResponseV2Schema,
} from '../schemas/search-response-v2.schema.js';
import { abortSignalFromFastifyRequest } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';

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
        { abortSignal: abortSignalFromFastifyRequest(request) },
      );

      const queryId = getRequestId(request);
      const humanResponse = projectToHumanResponse(v1Response, queryId);

      // Use sendContractResponse directly (not sendRouteContractResponse) to validate
      // the camelCase V2 payload against the camelCase V2 schema before Fastify's
      // preSerialization hook converts keys to snake_case for the wire format.
      sendContractResponse(request, reply, HTTP_STATUS_OK, SearchResponseV2HumanSchema, humanResponse);
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
        { abortSignal: abortSignalFromFastifyRequest(request) },
      );

      const queryId = getRequestId(request);
      const humanResponse = projectToHumanResponse(v1Response, queryId);

      sendContractResponse(request, reply, HTTP_STATUS_OK, SearchResponseV2HumanSchema, humanResponse);
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

      const result = await deps.interpretUseCase.execute(
        {
          ...interpretRequest,
          buildV2: true,
          requestId: getRequestId(request),
        },
        { abortSignal: abortSignalFromFastifyRequest(request) },
      );
      // NOTE: result.compiled (CompiledWineQuery) is available here but not currently used.
      // E1-U4 intent: callers can use compiled.execution.effectiveRoute for route-gating decisions.
      // If explain-mode or route-conditional response shaping is needed, read compiled here.
      const v2Response = result.v2Explain;

      sendContractResponse(request, reply, HTTP_STATUS_OK, InterpretResponseV2Schema, v2Response);
    },
  });
}
