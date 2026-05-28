import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ReplayRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { ReplayRouteContract } from './route-contracts.js';
import { toReplayRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { buildSearchErrorResponse } from '../errors/error-response.js';
import { HTTP_STATUS_FORBIDDEN, HTTP_STATUS_OK } from '../constants.js';

/**
 * Returns true when the request is allowed to invoke replay.
 *
 * Auth model:
 *  - When `HTTP_DEBUG_SECRET` is configured (production / staging): require
 *    a valid `X-Debug-Key` header (validated by `registerHttpDebugMode`,
 *    which sets `request.debugRequest = true` after a constant-time HMAC
 *    compare).
 *  - When the secret is NOT configured (dev/test/local): allow
 *    unauthenticated replay so test fixtures and local development work
 *    without ceremony. Production deployments must always set the secret.
 */
function hasReplayAuthorization(request: FastifyRequest): boolean {
  const secret = process.env['HTTP_DEBUG_SECRET']?.trim();
  if (secret === undefined || secret.length === 0) {
    return true;
  }
  return request.debugRequest;
}

/**
 * POST /v1/search/replay — replay search with pinned decision snapshot.
 *
 * Replay is an operator/diagnostic endpoint that exposes historical decision
 * state. We require X-Debug-Key (validated by registerHttpDebugMode) before
 * accepting requests so a public deployment cannot be used to enumerate prior
 * snapshot IDs or replay arbitrary historical decisions.
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
      if (!hasReplayAuthorization(request)) {
        const requestId = getRequestId(request);
        sendRouteContractResponse(
          request,
          reply,
          ReplayRouteContract,
          HTTP_STATUS_FORBIDDEN,
          buildSearchErrorResponse(
            requestId,
            'REPLAY_FORBIDDEN',
            'Replay endpoint requires X-Debug-Key authorization.',
            null,
            false,
          ),
        );
        return;
      }

      const parsed = parseContractBody(request, ReplayRouteContract);
      const replayRequest = toReplayRequest(parsed);
      const abortSignal = abortSignalFromFastifyRequest(request, reply);
      const response = await raceWithRequestAbort(
        deps.replayUseCase.execute(replayRequest, getRequestId(request), {
          abortSignal,
        }),
        abortSignal,
        'Replay request aborted',
      );

      sendRouteContractResponse(request, reply, ReplayRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
