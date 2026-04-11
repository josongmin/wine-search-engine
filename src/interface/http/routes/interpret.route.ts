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
import { abortSignalFromFastifyRequest } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';

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

      const interpretOptions = {
        abortSignal: abortSignalFromFastifyRequest(request),
        debugRequest: request.debugRequest,
      };

      if (wantsHumanResponse(request.headers.accept)) {
        const result = await deps.interpretUseCase.execute(
          {
            ...interpretRequest,
            buildV2: true,
            requestId,
          },
          interpretOptions,
        );
        void reply.header('Content-Type', MEDIA_TYPE_HUMAN);

        sendContractResponse(request, reply, HTTP_STATUS_OK, InterpretResponseV2Schema, result.v2Explain);
        return;
      }

      const plan = await deps.interpretUseCase.execute(
        {
          ...interpretRequest,
          requestId,
        },
        interpretOptions,
      );
      sendRouteContractResponse(request, reply, InterpretRouteContract, HTTP_STATUS_OK, plan);
    },
  });
}
