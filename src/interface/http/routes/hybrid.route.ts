import type { FastifyInstance } from 'fastify';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import type { HybridRouteDeps } from './route-deps.js';
import { HybridRouteContract } from './route-contracts.js';
import { toHybridSearchRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';

/**
 * POST /v1/search/hybrid — force hybrid search route.
 * Compare-style queries still reuse the shared decomposition path and may
 * therefore return a ComparisonSearchResponse.
 */
export function registerHybridRoute(
  app: FastifyInstance,
  deps: HybridRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/hybrid',
    contract: HybridRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, HybridRouteContract);
      const hybridRequest = toHybridSearchRequest(parsed);

      const response = await deps.hybridUseCase.execute(hybridRequest, getRequestId(request));

      sendRouteContractResponse(request, reply, HybridRouteContract, 200, response);
    },
  });
}
