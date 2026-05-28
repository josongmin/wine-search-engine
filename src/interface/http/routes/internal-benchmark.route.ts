import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import type { HttpRouteContract } from './route-contracts.js';
import type { SearchRouteDeps } from './route-deps.js';
import { toSearchRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { buildSearchErrorResponse, sendSearchErrorResponse } from '../errors/error-response.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '../constants.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { createStageTimer } from '../../../domain/shared/stage-timer.js';
import { SearchRequestSchema } from '../schemas/search-request.schema.js';
import {
  ErrorResponseSchema,
  SearchResponseSchema,
} from '../schemas/search-response.schema.js';
import { ComparisonSearchResponseSchema } from '../schemas/search-response.schema.js';

const InternalBenchmarkSearchRouteContract = {
  operationId: 'benchmark.search.execute',
  body: SearchRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: z.union([SearchResponseSchema, ComparisonSearchResponseSchema]),
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} satisfies HttpRouteContract;

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
    contract: InternalBenchmarkSearchRouteContract,
    handler: async (request, reply) => {
      if (!request.debugRequest) {
        denyBenchmarkLane(request, reply);
        return;
      }

      const parsed = parseContractBody(request, InternalBenchmarkSearchRouteContract);
      const searchRequest = toSearchRequest(parsed);
      const requestId = getRequestId(request);
      const stageTimer = createStageTimer();
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      const response = await raceWithRequestAbort(
        deps.searchUseCase.execute(searchRequest, requestId, {
          abortSignal,
          debugRequest: true,
          executionPrincipal: 'benchmark_trusted',
          stageTimer,
        }),
        abortSignal,
        'Benchmark search request aborted',
      );

      sendRouteContractResponse(
        request,
        reply,
        InternalBenchmarkSearchRouteContract,
        HTTP_STATUS_OK,
        response,
      );
    },
  });
}
