import type { FastifyInstance } from 'fastify';
import {
  parseContractBody,
  sendContractResponse,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import type { HybridRouteDeps } from './route-deps.js';
import { HybridRouteContract } from './route-contracts.js';
import { toHybridSearchRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { MEDIA_TYPE_HUMAN, wantsHumanResponse } from '../content-negotiation.js';
import { projectToHumanResponse } from './search-human-projection.js';
import { SearchResponseV2HumanSchema } from '../schemas/search-response-v2.schema.js';
import { abortSignalFromFastifyRequest } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';

/**
 * POST /v1/search/hybrid — force hybrid search route.
 *
 * Content negotiation (RFC 7231 §5.3.2):
 *   Accept: application/json                        → engine response (default)
 *   Accept: application/vnd.cuvee.human+json        → human-oriented summary
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
      const requestId = getRequestId(request);

      const response = await deps.hybridUseCase.execute(hybridRequest, requestId, {
        abortSignal: abortSignalFromFastifyRequest(request),
        debugRequest: request.debugRequest,
      });

      void reply.header('Vary', 'Accept');

      if (wantsHumanResponse(request.headers.accept)) {
        const humanResponse = projectToHumanResponse(response, requestId);
        void reply.header('Content-Type', MEDIA_TYPE_HUMAN);

        sendContractResponse(request, reply, HTTP_STATUS_OK, SearchResponseV2HumanSchema, humanResponse);
        return;
      }

      sendRouteContractResponse(request, reply, HybridRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
