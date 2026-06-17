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
import { EntityLookupV2OpsInspectRouteContract, EntityLookupV2RouteContract } from './route-contracts.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import { createStageTimer } from '../../../domain/shared/stage-timer.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../../domain/shared/error/policy-blocked.js';
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
        mode: 'default',
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

/**
 * `POST /v2/entity-lookup/ops/inspect` — trusted operator read plane (T-ELV2-07).
 *
 * Returns the full decision spine (admission reason, candidates, channel
 * coverage, calibrated decision) for a single query, always in diagnostic mode.
 * Gated by the X-Debug-Key trusted header (`request.debugRequest`): without it
 * the route returns 403 and never runs the lookup. This is the operator answer
 * to RFC DoD §6 — "operator가 query 하나로 admission/candidates/scores/decision을
 * trusted plane에서 본다".
 */
export function registerEntityLookupV2OpsRoute(app: FastifyInstance, deps: EntityLookupV2RouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/inspect',
    contract: EntityLookupV2OpsInspectRouteContract,
    handler: async (request, reply) => {
      // Trusted gate: only an X-Debug-Key-authenticated request may inspect the
      // internal decision spine. Reject BEFORE parsing/executing anything.
      if (!request.debugRequest) {
        throw new DomainError(POLICY_BLOCKED_CODE, 'entity-lookup ops plane requires a trusted debug key');
      }

      const parsed = parseContractBody(request, EntityLookupV2OpsInspectRouteContract);
      const requestId = getRequestId(request);
      const stageTimer = createStageTimer();
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      const command: EntityLookupV2Command = {
        query: parsed.query,
        ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
        maxCandidates: parsed.max_candidates,
        mode: 'diagnostic',
        requestId,
      };

      const result = await raceWithRequestAbort(
        deps.entityLookupV2UseCase.execute(command, {
          abortSignal,
          debugRequest: true,
          stageTimer,
          requestId,
        }),
        abortSignal,
        'Entity lookup V2 ops inspect aborted',
      );

      sendRouteContractResponse(request, reply, EntityLookupV2OpsInspectRouteContract, HTTP_STATUS_OK, result);
    },
  });
}
