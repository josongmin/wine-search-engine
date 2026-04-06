import type { FastifyInstance } from 'fastify';
import type { BatchSearchRouteDeps } from './route-deps.js';
import {
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { BatchSearchRouteContract } from './route-contracts.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import type { BatchSearchResponse } from '../../../application/search/batch-search.usecase.js';
import { getRequestId } from '../request-id.js';

function createValidationErrorResponse(requestId: string, message: string) {
  return ErrorResponseSchema.parse({
    error: {
      request_id: requestId,
      code: 'VALIDATION_ERROR',
      message,
      failure_reason: null,
      retryable: false,
    },
  });
}

function normalizeBatchResponse(
  response: Omit<BatchSearchResponse, 'batch_status' | 'has_failures'>
    & Partial<Pick<BatchSearchResponse, 'batch_status' | 'has_failures'>>,
): BatchSearchResponse {
  const succeeded = response.succeeded;
  const failed = response.failed;
  const batch_status = response.batch_status
    ?? (failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial_failure');
  const has_failures = response.has_failures ?? failed > 0;

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
 * - RETRIEVAL_TIMEOUT: Request exceeded timeout
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
      const parsed = BatchSearchRouteContract.body.safeParse(request.body);
      if (!parsed.success) {
        sendRouteContractResponse(
          request,
          reply,
          BatchSearchRouteContract,
          400,
          createValidationErrorResponse(getRequestId(request), 'Invalid batch search request'),
        );
        return;
      }

      const response = await deps.batchSearchUseCase.execute(
        parsed.data.requests,
        parsed.data.options,
        parsed.data.batch_id,
      );

      // HTTP transport indicates the batch request itself succeeded.
      // Clients should inspect batch_status / has_failures / results[].status
      // to determine item-level outcomes.
      sendRouteContractResponse(
        request,
        reply,
        BatchSearchRouteContract,
        200,
        normalizeBatchResponse(response),
      );
    },
  });
}
