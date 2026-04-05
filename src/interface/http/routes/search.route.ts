import type { FastifyInstance } from 'fastify';
import { detectDecomposition, isValidDecomposition } from '../../../domain/query/service/decomposition-detector.js';
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
      const startTime = Date.now();
      const searchRequest = toSearchRequest(parsed);

      // Epic 14: Check for decomposable "A vs B" queries before routing to SearchUseCase
      const decompositionResult = detectDecomposition(searchRequest.query);
      if (isValidDecomposition(decompositionResult)) {
        const response = await deps.decomposedSearchUseCase.execute(
          decompositionResult.subQueries,
          decompositionResult.comparisonIntent,
          searchRequest.query,
          request.requestId,
          startTime,
        );
        sendRouteContractResponse(request, reply, SearchRouteContract, 200, response);
        return;
      }

      // Regular search
      const response = await deps.searchUseCase.execute(searchRequest, request.requestId);

      sendRouteContractResponse(request, reply, SearchRouteContract, 200, response);
    },
  });
}
