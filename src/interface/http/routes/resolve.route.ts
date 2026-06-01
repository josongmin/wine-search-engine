import type { FastifyInstance } from 'fastify';
import { type z } from 'zod';
import type { ResolveRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { ResolveRouteContract } from './route-contracts.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import type { PrimitiveSearchRequestSchema } from '../schemas/primitive-search.schema.js';
import type { ResolveRequest } from '../../../application/search/resolve-request.dto.js';

type ResolveRouteBody = z.output<typeof PrimitiveSearchRequestSchema>;

function toResolveRequest(
  body: ResolveRouteBody,
  requestId: string,
): ResolveRequest {
  return {
    query: body.query,
    requestId,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
  };
}

/**
 * Retained internal resolve surface for resolver-only tooling/regression
 * coverage. The public exact-entity path is `POST /v1/lookup/wine`.
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
      const parsed = parseContractBody(request, ResolveRouteContract) as ResolveRouteBody;
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
