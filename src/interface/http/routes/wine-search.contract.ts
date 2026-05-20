/**
 * Route contract for POST /v1/wine-search — Plan-then-Execute wine search.
 *
 * This contract is the static authority for the route's request/response
 * shape and its enumerated error statuses. It is consumed by:
 *  - the route handler (`wine-search.route.ts`), via
 *    `registerContractRoute(...)` + `parseContractBody` + `sendRouteContractResponse`,
 *  - the OpenAPI bridge (`http-route-contract-openapi.ts`) — registered via
 *    `DeclaredHttpRouteContractCatalog` so the OpenAPI document and the
 *    `verify:http-contracts` parity test see this endpoint.
 *
 * Mirrors the pattern of `agent.contract.ts`; the response envelope is a
 * breaking redesign documented in `wine-search.schema.ts`.
 */

import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '../constants.js';
import {
  WineSearchRequestSchema,
  WineSearchResponseSchema,
} from '../schemas/wine-search.schema.js';

export const WineSearchRouteContract = {
  operationId: 'wineSearch.execute',
  body: WineSearchRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: WineSearchResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;
