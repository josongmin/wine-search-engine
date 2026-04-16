import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import { SearchRouteContract } from './route-contracts.js';
import type { SearchRouteDeps } from './route-deps.js';
import { toSearchRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { buildSearchErrorResponse, sendSearchErrorResponse } from '../errors/error-response.js';
import { HTTP_STATUS_FORBIDDEN, HTTP_STATUS_OK } from '../constants.js';
import { abortSignalFromFastifyRequest } from '../request-abort-signal.js';
import { createStageTimer } from '../../../observability/stage-timer.js';

function denyBenchmarkLane(request: FastifyRequest, reply: FastifyReply): void {
  const body = buildSearchErrorResponse(
    getRequestId(request),
    'FORBIDDEN',
    'Internal benchmark route requires a valid X-Debug-Key.',
    null,
    false,
  );
  sendSearchErrorResponse(request, reply, HTTP_STATUS_FORBIDDEN, body);
}

/**
 * Internal benchmark execution lane.
 *
 * This route is intentionally separated from `/v1/search` so retrieval-quality
 * benchmarks can run on fixture-trusted inputs without being distorted by
 * public-edge prompt-injection defenses. Access requires the same validated
 * X-Debug-Key path that sets `request.debugRequest=true`.
 */
export function registerInternalBenchmarkRoute(
  app: FastifyInstance,
  deps: SearchRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/internal/benchmark/search',
    contract: SearchRouteContract,
    handler: async (request, reply) => {
      if (!request.debugRequest) {
        denyBenchmarkLane(request, reply);
        return;
      }

      const parsed = parseContractBody(request, SearchRouteContract);
      const searchRequest = toSearchRequest(parsed);
      const requestId = getRequestId(request);
      const stageTimer = createStageTimer();

      const response = await deps.searchUseCase.execute(searchRequest, requestId, {
        abortSignal: abortSignalFromFastifyRequest(request),
        debugRequest: true,
        executionPrincipal: 'benchmark_trusted',
        stageTimer,
      });

      sendRouteContractResponse(request, reply, SearchRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
