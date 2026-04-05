import type { FastifyInstance } from 'fastify';
import type { BatchSearchRouteDeps } from './route-deps.js';
import {
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { BatchSearchRouteContract } from './route-contracts.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';

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
 * Response (HTTP 207 Multi-Status, regardless of partial failures):
 * ```json
 * {
 *   "batch_id": "my-batch-123",
 *   "total": 2,
 *   "succeeded": 1,
 *   "failed": 1,
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
 * - 207 Multi-Status: Batch executed (may contain mixed success/failure)
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
          createValidationErrorResponse(request.requestId, 'Invalid batch search request'),
        );
        return;
      }

      const response = await deps.batchSearchUseCase.execute(
        parsed.data.requests,
        parsed.data.options,
        parsed.data.batch_id,
      );

      // Always return 207 Multi-Status (RFC 7231 §6.3.7)
      // HTTP 207 allows a single response body to convey information about
      // multiple status values. Used here to indicate that:
      // - Batch structure was valid (not 400)
      // - Individual requests may have succeeded or failed (not 200/500)
      // - Client must inspect response.results[].status to determine outcome
      sendRouteContractResponse(request, reply, BatchSearchRouteContract, 207, response);
    },
  });
}
