import type { FastifyInstance } from 'fastify';
import { detectDecomposition, isValidDecomposition } from '../../../domain/query/service/decomposition-detector.js';
import type { SearchRouteDeps } from './route-deps.js';
import { throwIfPolicyBlockedSearchResponse } from '../errors/policy-blocked.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
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
  app.post('/v1/search', async (request, reply) => {
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

    // Lift policy-blocked search responses into the shared HTTP error path so
    // all public query endpoints use the same 403 transport semantics.
    throwIfPolicyBlockedSearchResponse(response);

    sendRouteContractResponse(request, reply, SearchRouteContract, 200, response);
  });
}
