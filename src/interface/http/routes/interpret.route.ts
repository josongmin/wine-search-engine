import type { FastifyInstance } from 'fastify';
import type { InterpretRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendContractResponse,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { InterpretRouteContract } from './route-contracts.js';
import { toInterpretRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { MEDIA_TYPE_HUMAN, wantsHumanResponse } from '../content-negotiation.js';
import { InterpretResponseV2Schema } from '../schemas/search-response-v2.schema.js';

/**
 * POST /v1/search/interpret — query interpretation / explain.
 *
 * Content negotiation (RFC 7231 §5.3.2):
 *   Accept: application/json                        → V1 QueryPlan (default)
 *   Accept: application/vnd.cuvee.human+json        → V2 explain format
 */
export function registerInterpretRoute(
  app: FastifyInstance,
  deps: InterpretRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/interpret',
    contract: InterpretRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, InterpretRouteContract);
      const interpretRequest = toInterpretRequest(parsed);
      const requestId = getRequestId(request);

      void reply.header('Vary', 'Accept');

      if (wantsHumanResponse(request.headers.accept)) {
        const result = await deps.interpretUseCase.execute({
          ...interpretRequest,
          buildV2: true,
          requestId,
        });
        void reply.header('Content-Type', MEDIA_TYPE_HUMAN);

        sendContractResponse(request, reply, 200, InterpretResponseV2Schema, result.v2Explain);
        return;
      }

      const plan = await deps.interpretUseCase.execute({
        ...interpretRequest,
        requestId,
      });
      sendRouteContractResponse(request, reply, InterpretRouteContract, 200, plan);
    },
  });
}
