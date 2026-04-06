import type { FastifyInstance } from 'fastify';
import type { ResolveRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { ResolveRouteContract } from './route-contracts.js';
import { toResolveRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';

/**
 * POST /v1/entity/resolve — entity resolution only.
 */
export function registerResolveRoute(
  app: FastifyInstance,
  deps: ResolveRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/entity/resolve',
    contract: ResolveRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, ResolveRouteContract);
      const resolveRequest = toResolveRequest(parsed, getRequestId(request));

      const result = await deps.resolveUseCase.execute(resolveRequest);

      sendRouteContractResponse(request, reply, ResolveRouteContract, 200, result);
    },
  });
}
