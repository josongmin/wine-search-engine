/**
 * Primitive search & lookup route handlers — T-IR-01.
 *
 * Path-authoritative selectors: the URL determines which retrieval lane runs.
 * The request body is identical across all four primitives (see
 * {@link PrimitiveSearchRequestSchema}) — no body field can override the lane
 * (architecture-decision §2.2 — primitive selector is path, never body).
 *
 *   POST /v1/search/hybrid    → full RRF fusion (dense + sparse)
 *   POST /v1/search/semantic  → dense-only / embedding similarity
 *   POST /v1/search/lexical   → sparse-only / BM25
 *   POST /v1/lookup/wine      → canonical wine entity resolution
 *
 * The first three return discovery-shaped responses (ranked list, possible
 * comparison decomposition). The fourth (`lookup/wine`) is an *exact*
 * entity surface; comparison queries are rejected with 400 since lookup
 * resolves one wine, not a comparison.
 */

import type { FastifyInstance } from 'fastify';
import type { SearchRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendContractResponse,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  HybridSearchRouteContract,
  LexicalSearchRouteContract,
  LookupWineRouteContract,
  SemanticSearchRouteContract,
} from './route-contracts.js';
import {
  toHybridSearchRequest,
  toLexicalSearchRequest,
  toLookupWineRequest,
  toSemanticSearchRequest,
} from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { MEDIA_TYPE_HUMAN, wantsHumanResponse } from '../content-negotiation.js';
import { projectToHumanResponse } from './search-human-projection.js';
import { SearchResponseV2HumanSchema } from '../schemas/search-response-v2.schema.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import { createStageTimer } from '../../../domain/shared/stage-timer.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import type { SearchRequest } from '../../../application/search/search-request.dto.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';

type DiscoveryResponse = SearchResponseV1 | ComparisonSearchResponse;

/**
 * Shared handler factory for the three discovery primitives. The only thing
 * that varies across `hybrid`, `semantic`, `lexical` is which mapper builds
 * the internal {@link SearchRequest} — everything else (abort, timing,
 * content negotiation, response shaping) is identical.
 */
function makeDiscoveryHandler(
  deps: SearchRouteDeps,
  buildRequest: (body: never) => SearchRequest,
  routeContract: typeof HybridSearchRouteContract,
  abortLabel: string,
) {
  return async (request: Parameters<typeof parseContractBody>[0], reply: Parameters<typeof sendContractResponse>[1]): Promise<void> => {
    const parsed = parseContractBody(request, routeContract);
    const searchRequest = buildRequest(parsed as never);
    const requestId = getRequestId(request);
    const stageTimer = createStageTimer();
    const abortSignal = abortSignalFromFastifyRequest(request, reply);

    const response: DiscoveryResponse = await raceWithRequestAbort(
      deps.searchUseCase.execute(searchRequest, requestId, {
        abortSignal,
        debugRequest: request.debugRequest,
        stageTimer,
      }),
      abortSignal,
      abortLabel,
    );

    void reply.header('Vary', 'Accept');

    if (wantsHumanResponse(request.headers.accept)) {
      const humanResponse = projectToHumanResponse(response, requestId);
      void reply.header('Content-Type', MEDIA_TYPE_HUMAN);
      sendContractResponse(request, reply, HTTP_STATUS_OK, SearchResponseV2HumanSchema, humanResponse);
      return;
    }

    sendRouteContractResponse(request, reply, routeContract, HTTP_STATUS_OK, response);
  };
}

export function registerHybridSearchRoute(app: FastifyInstance, deps: SearchRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/hybrid',
    contract: HybridSearchRouteContract,
    handler: makeDiscoveryHandler(deps, toHybridSearchRequest, HybridSearchRouteContract, 'Hybrid search aborted'),
  });
}

export function registerSemanticSearchRoute(app: FastifyInstance, deps: SearchRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/semantic',
    contract: SemanticSearchRouteContract,
    handler: makeDiscoveryHandler(deps, toSemanticSearchRequest, SemanticSearchRouteContract, 'Semantic search aborted'),
  });
}

export function registerLexicalSearchRoute(app: FastifyInstance, deps: SearchRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/search/lexical',
    contract: LexicalSearchRouteContract,
    handler: makeDiscoveryHandler(deps, toLexicalSearchRequest, LexicalSearchRouteContract, 'Lexical search aborted'),
  });
}

export function registerLookupWineRoute(app: FastifyInstance, deps: SearchRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/lookup/wine',
    contract: LookupWineRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, LookupWineRouteContract);
      const searchRequest = toLookupWineRequest(parsed);
      const requestId = getRequestId(request);
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      const response = await raceWithRequestAbort(
        deps.searchUseCase.execute(searchRequest, requestId, { abortSignal }),
        abortSignal,
        'Lookup request aborted',
      );

      // Decomposition runs upstream of route-dispatch and may bubble a
      // comparison response even with `retrieval_mode='entity'`. Lookup is an
      // exact wine-identity surface — reject comparison results explicitly
      // rather than letting the caller infer "this is two wines" from the
      // response shape.
      if (response.queryType === 'comparison') {
        throw new DomainError(
          'INVALID_REQUEST',
          'lookup does not support comparison queries — use POST /v1/search/hybrid for "A vs B" queries',
        );
      }

      sendRouteContractResponse(request, reply, LookupWineRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
