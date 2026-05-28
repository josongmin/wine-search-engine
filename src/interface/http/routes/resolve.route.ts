import type { FastifyInstance } from 'fastify';
import type { ResolveRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { ResolveRouteContract } from './route-contracts.js';
import { toResolveRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';

/**
 * POST /v1/entity/resolve — entity resolution only.
 */
export function registerResolveRoute(
  app: FastifyInstance,
  deps: ResolveRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/entity/resolve',
    contract: ResolveRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, ResolveRouteContract);
      const resolveRequest = toResolveRequest(parsed, getRequestId(request));
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      const result = await raceWithRequestAbort(
        deps.resolveUseCase.execute(resolveRequest, {
          abortSignal,
          debugRequest: request.debugRequest,
        }),
        abortSignal,
        'Resolve request aborted',
      );

      sendRouteContractResponse(request, reply, ResolveRouteContract, HTTP_STATUS_OK, result);
    },
  });
}
