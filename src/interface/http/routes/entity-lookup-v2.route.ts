/**
 * `POST /v2/entity-lookup` — dedicated entity-lookup V2 surface (T-ELV2-01).
 *
 * This route is intentionally NOT part of the path-authoritative primitive
 * search family. It owns a dedicated request/response contract (entity
 * resolution task, not discovery search) and delegates to the
 * {@link EntityLookupV2UseCasePort} sibling stack.
 */

import type { FastifyInstance } from 'fastify';
import type { EntityLookupV2RouteDeps } from './route-deps.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { EntityLookupV2RouteContract } from './route-contracts.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import { createStageTimer } from '../../../domain/shared/stage-timer.js';
import type { EntityLookupV2Command } from '../../../application/search/entity-lookup-v2/entity-lookup-v2.dto.js';

export function registerEntityLookupV2Route(app: FastifyInstance, deps: EntityLookupV2RouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup',
    contract: EntityLookupV2RouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, EntityLookupV2RouteContract);
      const requestId = getRequestId(request);
      const stageTimer = createStageTimer();
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      const command: EntityLookupV2Command = {
        query: parsed.query,
        ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
        maxCandidates: parsed.max_candidates,
        mode: parsed.mode,
        requestId,
      };

      const result = await raceWithRequestAbort(
        deps.entityLookupV2UseCase.execute(command, {
          abortSignal,
          debugRequest: request.debugRequest,
          stageTimer,
          requestId,
        }),
        abortSignal,
        'Entity lookup V2 aborted',
      );

      sendRouteContractResponse(request, reply, EntityLookupV2RouteContract, HTTP_STATUS_OK, result);
    },
  });
}
