import type { FastifyInstance } from 'fastify';
import type { ReplayRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { ReplayRouteContract } from './route-contracts.js';
import { toReplayRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';

/**
 * POST /v1/search/replay — replay search with pinned decision snapshot.
 *
 * On SNAPSHOT_MISMATCH: the error handler returns 409 with the RFC-014 error contract.
 */
export function registerReplayRoute(
  app: FastifyInstance,
  deps: ReplayRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/replay',
    contract: ReplayRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, ReplayRouteContract);
      const replayRequest = toReplayRequest(parsed);
      const response = await deps.replayUseCase.execute(replayRequest, getRequestId(request));

      sendRouteContractResponse(request, reply, ReplayRouteContract, 200, response);
    },
  });
}
