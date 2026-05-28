import type { FastifyInstance } from 'fastify';
import type { BatchSearchRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { BatchSearchRouteContract } from './route-contracts.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import { HTTP_STATUS_OK } from '../constants.js';
import type { BatchSearchResponse } from '../../../application/search/batch-search.dto.js';

function normalizeBatchResponse(
  response: Omit<BatchSearchResponse, 'batch_status' | 'has_failures'>
    & Partial<Pick<BatchSearchResponse, 'batch_status' | 'has_failures'>>,
): BatchSearchResponse {
  const succeeded = response.succeeded;
  const failed = response.failed;
  const not_executed = response.not_executed;
  const anyFailures = failed > 0 || not_executed > 0;
  const batch_status = response.batch_status
    ?? (!anyFailures ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial_failure');
  const has_failures = response.has_failures ?? anyFailures;

  return {
    ...response,
    batch_status,
    has_failures,
  };
}

/**
 * POST /v1/batch-search — batch search endpoint.
 *
 * Executes multiple search requests in a single call with optional fail-fast support.
 *
 * Request:
 * ```json
 * {
 *   "requests": [
 *     { "id": "1", "query": "Cabernet 2015" },
 *     { "id": "2", "query": "White Burgundy", "limit": 10 }
 *   ],
 *   "options": { "fail_fast": false, "timeout_ms": 5000 },
 *   "batch_id": "my-batch-123"  // optional
 * }
 * ```
 *
 * Response (HTTP 200 OK; inspect batch_status for outcome):
 * ```json
 * {
 *   "batch_id": "my-batch-123",
 *   "total": 2,
 *   "succeeded": 1,
 *   "failed": 1,
 *   "batch_status": "partial_failure",
 *   "has_failures": true,
 *   "results": [
 *     {
 *       "id": "1",
 *       "status": "succeeded",
 *       "response": { ... SearchResponseV1 ... }
 *     },
 *     {
 *       "id": "2",
 *       "status": "failed",
 *       "error": {
 *         "code": "RETRIEVAL_TIMEOUT",
 *         "message": "Request exceeded timeout"
 *       }
 *     }
 *   ],
 *   "processing_time_ms": 5023
 * }
 * ```
 *
 * Error codes:
 * - POLICY_BLOCKED: Query blocked by policy
 * - QUERY_PARSE_ERROR: Query validation failed
 * - QUERY_PARSE_ERROR: Comparison-style queries are not supported in batch items
 * - RETRIEVAL_TIMEOUT: Request exceeded timeout
 * - REQUEST_ABORTED: Client cancelled the HTTP request or cooperative abort
 * - INTERNAL_ERROR: Unexpected server error
 *
 * HTTP status codes:
 * - 200 OK: Batch executed; inspect batch_status/results for outcome
 * - 400 Bad Request: Validation error in batch request structure
 * - 415 Unsupported Media Type: Wrong Content-Type header
 * - 429 Too Many Requests: Rate limit exceeded
 * - 500 Internal Server Error: Unhandled server error
 */
export function registerBatchSearchRoute(
  app: FastifyInstance,
  deps: BatchSearchRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/batch-search',
    contract: BatchSearchRouteContract,
    handler: async (request, reply) => {
      const body = parseContractBody(request, BatchSearchRouteContract);
      const abortSignal = abortSignalFromFastifyRequest(request, reply);

      // Use the HTTP requestId as the batch_id when the client did not
      // supply one, so per-item subqueries (`${batch_id}-${item.id}`) can
      // be correlated back to the originating HTTP request in logs/traces.
      const effectiveBatchId = body.batch_id ?? getRequestId(request);

      const response = await raceWithRequestAbort(
        deps.batchSearchUseCase.execute(
          body.requests,
          body.options,
          effectiveBatchId,
          { abortSignal },
        ),
        abortSignal,
        'Batch search request aborted',
      );

      // HTTP transport indicates the batch request itself succeeded.
      // Clients should inspect batch_status / has_failures / results[].status
      // to determine item-level outcomes.
      sendRouteContractResponse(
        request,
        reply,
        BatchSearchRouteContract,
        HTTP_STATUS_OK,
        normalizeBatchResponse(response),
      );
    },
  });
}
