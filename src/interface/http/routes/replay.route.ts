import type { FastifyInstance } from 'fastify';
import type { ReplayRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { ReplayRouteContract } from './route-contracts.js';
import { toReplayRequest } from './search-request-mappers.js';

/**
 * POST /v1/search/replay — replay search with pinned decision snapshot.
 *
 * On SNAPSHOT_MISMATCH: the error handler returns 409 with the RFC-014 error contract.
 */
export function registerReplayRoute(
  app: FastifyInstance,
  deps: ReplayRouteDeps,
): void {
  app.post('/v1/search/replay', async (request, reply) => {
    const parsed = parseContractBody(request, ReplayRouteContract);
    const replayRequest = toReplayRequest(parsed);
    const response = await deps.replayUseCase.execute(replayRequest, request.requestId);

    sendRouteContractResponse(request, reply, ReplayRouteContract, 200, response);
  });
}
