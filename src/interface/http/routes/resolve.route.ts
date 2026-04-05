import type { FastifyInstance } from 'fastify';
import type { ResolveRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { ResolveRouteContract } from './route-contracts.js';
import { toResolveRequest } from './search-request-mappers.js';

/**
 * POST /v1/entity/resolve — entity resolution only.
 */
export function registerResolveRoute(
  app: FastifyInstance,
  deps: ResolveRouteDeps,
): void {
  app.post('/v1/entity/resolve', async (request, reply) => {
    const parsed = parseContractBody(request, ResolveRouteContract);
    const resolveRequest = toResolveRequest(parsed, request.requestId);

    const result = await deps.resolveUseCase.execute(resolveRequest);

    sendRouteContractResponse(request, reply, ResolveRouteContract, 200, result);
  });
}
