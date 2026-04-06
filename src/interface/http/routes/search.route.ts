import type { FastifyInstance } from 'fastify';
import type { SearchRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { SearchRouteContract } from './route-contracts.js';
import { toSearchRequest } from './search-request-mappers.js';

/**
 * POST /v1/search — main search endpoint.
 * Handles both regular search and "A vs B" comparison queries.
 *
 * Epic 14: Decomposition detection is handled inside SearchUseCase.execute().
 * If the query matches an "A vs B" pattern, it delegates to DecomposedSearchUseCase
 * and returns a ComparisonSearchResponse.
 */
export function registerSearchRoute(
  app: FastifyInstance,
  deps: SearchRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search',
    contract: SearchRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, SearchRouteContract);
      const searchRequest = toSearchRequest(parsed);

      const response = await deps.searchUseCase.execute(searchRequest, request.requestId);

      sendRouteContractResponse(request, reply, SearchRouteContract, 200, response);
    },
  });
}
