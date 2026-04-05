import type { FastifyInstance } from 'fastify';
import type { InterpretRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { InterpretRouteContract } from './route-contracts.js';
import { toInterpretRequest } from './search-request-mappers.js';

/**
 * POST /v1/search/interpret — returns QueryPlanV1 only (no execution).
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

      const plan = await deps.interpretUseCase.execute(interpretRequest);

      sendRouteContractResponse(request, reply, InterpretRouteContract, 200, plan);
    },
  });
}
