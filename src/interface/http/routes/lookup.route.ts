import type { FastifyInstance } from 'fastify';
import type { SearchRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { LookupRouteContract } from './route-contracts.js';
import { toLookupRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';

/**
 * POST /v1/search/lookup — entity-only (exact match) search.
 *
 * Designed for lookups like "샤또마고 2016" where the caller wants a single
 * authoritative wine result, not a ranked discovery list. Routing is always
 * forced to 'entity' — the retrieval_mode field is intentionally absent from
 * the request schema.
 *
 * "A vs B" queries are rejected with 400: this endpoint resolves one entity,
 * not a comparison. Use POST /v1/search for multi-entity queries.
 *
 * No content-negotiation / human projection: this endpoint is machine-facing.
 */
export function registerLookupRoute(
  app: FastifyInstance,
  deps: SearchRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/lookup',
    contract: LookupRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, LookupRouteContract);
      const searchRequest = toLookupRequest(parsed);
      const requestId = getRequestId(request);
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      const response = await raceWithRequestAbort(
        deps.searchUseCase.execute(searchRequest, requestId, {
          abortSignal,
        }),
        abortSignal,
        'Lookup request aborted',
      );

      // Decomposition detector runs before route-dispatch and may return a
      // ComparisonSearchResponse even with retrieval_mode:'entity'. Lookup
      // callers explicitly want a single entity — reject comparison results.
      if (response.queryType === 'comparison') {
        throw new DomainError(
          'INVALID_REQUEST',
          'lookup does not support comparison queries — use POST /v1/search for "A vs B" queries',
        );
      }

      sendRouteContractResponse(request, reply, LookupRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
