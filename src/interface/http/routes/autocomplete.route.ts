import type { FastifyInstance } from 'fastify';
import type { AutocompleteRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { AutocompleteRouteContract } from './route-contracts.js';
import { toResolveRequest } from './search-request-mappers.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';

/**
 * POST /v1/entity/autocomplete — entity resolution tuned for typeahead UX.
 */
export function registerAutocompleteRoute(
  app: FastifyInstance,
  deps: AutocompleteRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/entity/autocomplete',
    contract: AutocompleteRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, AutocompleteRouteContract);
      const resolveRequest = toResolveRequest(parsed, getRequestId(request));

      const result = await deps.autocompleteUseCase.execute(resolveRequest, {
        abortSignal: abortSignalFromFastifyRequest(request),
        debugRequest: request.debugRequest,
      });

      sendRouteContractResponse(request, reply, AutocompleteRouteContract, HTTP_STATUS_OK, result);
    },
  });
}
