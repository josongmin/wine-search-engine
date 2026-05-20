import type { FastifyInstance } from 'fastify';
import type { SearchRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendContractResponse,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { SearchRouteContract } from './route-contracts.js';
import { toSearchRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { MEDIA_TYPE_HUMAN, wantsHumanResponse } from '../content-negotiation.js';
import { projectToHumanResponse } from './search-human-projection.js';
import { SearchResponseV2HumanSchema } from '../schemas/search-response-v2.schema.js';
import { abortSignalFromFastifyRequest } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import { createStageTimer } from '../../../domain/shared/stage-timer.js';

/**
 * POST /v1/search — main search endpoint.
 *
 * Content negotiation (RFC 7231 §5.3.2):
 *   Accept: application/json                        → engine response (default)
 *   Accept: application/vnd.cuvee.human+json        → human-oriented summary
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
      const requestId = getRequestId(request);
      const stageTimer = createStageTimer();

      const response = await deps.searchUseCase.execute(searchRequest, requestId, {
        abortSignal: abortSignalFromFastifyRequest(request),
        debugRequest: request.debugRequest,
        stageTimer,
      });

      // RFC 7234 §4.1: Vary must list headers that influence representation selection.
      void reply.header('Vary', 'Accept');

      if (wantsHumanResponse(request.headers.accept)) {
        const humanResponse = projectToHumanResponse(response, requestId);
        void reply.header('Content-Type', MEDIA_TYPE_HUMAN);

        sendContractResponse(request, reply, HTTP_STATUS_OK, SearchResponseV2HumanSchema, humanResponse);
        return;
      }

      sendRouteContractResponse(request, reply, SearchRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
