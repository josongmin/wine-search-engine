import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { BATCH_ID_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import type {
  BatchErrorCode,
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
  BatchSearchResultItem,
} from './batch-search.dto.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';

export type {
  BatchErrorCode,
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
  BatchSearchResultFailure,
  BatchSearchResultItem,
  BatchSearchResultSuccess,
} from './batch-search.dto.js';

/**
 * BatchSearchUseCase: orchestrates parallel or fail-fast batch search execution.
 *
 * Features:
 * - Validates batch size (max 20 requests)
 * - Enforces timeout range (5000–30000 ms)
 * - Executes requests in parallel (Promise.all) or sequentially for fail_fast
 * - Supports fail_fast mode without starting later work after first failure
 * - Maps domain errors to BatchErrorCode
 * - Provides idempotent execution with batch_id
 * - Generates sub-request IDs: `${batchId}-${item.id}`
 * - Returns a transport-safe batch summary for HTTP 200 responses
 *
 * RFC compliance:
 * - Error codes align with FailureReason enum (POLICY_BLOCKED, etc.)
 * - Sub-request propagation via requestId
 * - Timeout enforcement using Promise.race()
 * - Proper aggregation: succeeded + failed = total
 */
export class BatchSearchUseCase {
  /** Maximum requests per batch. */
  private static readonly MAX_BATCH_SIZE = 20;

  /** Default timeout per request (milliseconds). */
  private static readonly DEFAULT_TIMEOUT_MS = 5000;

  /** Maximum timeout per request (milliseconds). */
  private static readonly MAX_TIMEOUT_MS = 30000;

  /** Minimum timeout per request (milliseconds). */
  private static readonly MIN_TIMEOUT_MS = 1000;

  constructor(private readonly searchUseCase: SearchExecutorPort) {}

  /**
   * Execute a batch of search requests.
   *
   * @param requests - Array of batch search request items (max 20).
   * @param options - Batch execution options (fail_fast, timeout_ms).
   * @param batchId - Optional batch identifier; generated if not provided.
   * @returns The batch search response with all results.
   * @throws Never throws; errors are captured in the response.
   */
  async execute(
    requests: readonly BatchSearchRequestItem[],
    options?: BatchSearchOptions,
    batchId?: string,
  ): Promise<BatchSearchResponse> {
    const startTime = Date.now();
    const timeoutMs = this.normalizeTimeout(options?.timeout_ms);
    const actualBatchId = batchId ?? this.generateBatchId(requests, {
      failFast: options?.fail_fast ?? false,
      timeoutMs,
    });

    // Validate batch size
    if (requests.length === 0) {
      return {
        batch_id: actualBatchId,
        total: 0,
        succeeded: 0,
        failed: 0,
        batch_status: 'succeeded',
        has_failures: false,
        results: [],
        processing_time_ms: Date.now() - startTime,
      };
    }

    if (requests.length > BatchSearchUseCase.MAX_BATCH_SIZE) {
      return {
        batch_id: actualBatchId,
        total: requests.length,
        succeeded: 0,
        failed: requests.length,
        batch_status: 'failed',
        has_failures: true,
        results: requests.map((req) => ({
          id: req.id,
          status: 'failed',
          error: {
            code: 'INTERNAL_ERROR' as const,
            message: `Batch size ${requests.length} exceeds maximum of ${BatchSearchUseCase.MAX_BATCH_SIZE}`,
          },
        })),
        processing_time_ms: Date.now() - startTime,
      };
    }

    // Determine execution strategy
    const failFast = options?.fail_fast ?? false;

    // Execute requests
    const results = failFast
      ? await this.executeFailFast(requests, actualBatchId, timeoutMs)
      : await this.executePartial(requests, actualBatchId, timeoutMs);

    // Aggregate results
    const succeeded = results.filter((r) => r.status === 'succeeded').length;
    const failed = results.length - succeeded;
    const batchStatus =
      failed === 0
        ? 'succeeded'
        : succeeded === 0
          ? 'failed'
          : 'partial_failure';

    return {
      batch_id: actualBatchId,
      total: requests.length,
      succeeded,
      failed,
      batch_status: batchStatus,
      has_failures: failed > 0,
      results,
      processing_time_ms: Date.now() - startTime,
    };
  }

  /**
   * Execute all requests in parallel; continue on errors.
   *
   * Each request is executed independently. If one fails, others continue.
   *
   * @param requests - Array of batch search request items.
   * @param batchId - Batch identifier for sub-request ID generation.
   * @param timeoutMs - Timeout per request in milliseconds.
   * @returns Array of result items (same length as requests).
   */
  private async executePartial(
    requests: readonly BatchSearchRequestItem[],
    batchId: string,
    timeoutMs: number,
  ): Promise<readonly BatchSearchResultItem[]> {
    const promises = requests.map((req) =>
      this.executeSingle(req, batchId, timeoutMs),
    );

    const results = await Promise.all(promises);
    return results;
  }

  /**
   * Execute requests sequentially; stop starting later work on first failure.
   *
   * Remaining requests are surfaced as aborted failures so the transport
   * contract preserves batch cardinality.
   *
   * @param requests - Array of batch search request items.
   * @param batchId - Batch identifier for sub-request ID generation.
   * @param timeoutMs - Timeout per request in milliseconds.
   * @returns Array of result items (may be shorter than requests if aborted).
   */
  private async executeFailFast(
    requests: readonly BatchSearchRequestItem[],
    batchId: string,
    timeoutMs: number,
  ): Promise<readonly BatchSearchResultItem[]> {
    const results: BatchSearchResultItem[] = [];
    for (const [index, req] of requests.entries()) {
      const result = await this.executeSingle(req, batchId, timeoutMs);
      results.push(result);

      if (result.status === 'failed') {
        for (const remainingReq of requests.slice(index + 1)) {
          results.push({
            id: remainingReq.id,
            status: 'failed',
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Batch execution aborted due to earlier failure',
            },
          });
        }
        break;
      }
    }

    return results;
  }

  /**
   * Execute a single request with timeout enforcement.
   *
   * Wraps SearchUseCase.execute() with:
   * - Timeout via Promise.race()
   * - Error mapping to BatchErrorCode
   * - Sub-request ID generation: `${batchId}-${req.id}`
   * - Proper error handling and logging
   *
   * @param req - The individual batch request item.
   * @param batchId - The batch identifier.
   * @param timeoutMs - Timeout in milliseconds.
   * @returns Result item (success or failure).
   */
  private async executeSingle(
    req: BatchSearchRequestItem,
    batchId: string,
    timeoutMs: number,
  ): Promise<BatchSearchResultItem> {
    const requestId = `${batchId}-${req.id}`;

    try {
      // Build SearchRequest from batch item
      const searchRequest: SearchRequest = {
        query: req.query,
        context: req.context,
        sessionContext: req.sessionContext,
        queryBudget: req.queryBudget,
        options: {
          mode: req.retrieval_mode ?? 'auto',
          explain: false,
          clarification: true,
        },
      };

      // Execute with timeout
      const rawResponse = await Promise.race([
        this.searchUseCase.execute(searchRequest, requestId),
        this.createTimeoutPromise(timeoutMs),
      ]);

      // Batch items are always standard search queries, not comparisons
      if (rawResponse.queryType !== 'search') {
        return {
          id: req.id,
          status: 'failed',
          error: { code: 'INTERNAL_ERROR', message: 'Batch item returned comparison response' },
        };
      }
      const response = rawResponse;

      // G-15: Search responses can legitimately complete with a failed decision
      // (for example no match). Only treat explicit policy/admission blocks as
      // batch item failures; otherwise preserve the successful transport response.
      const reason = response.engineDecision.failure_reason;
      if (reason === POLICY_BLOCKED_CODE || reason === 'AMBIGUITY_BLOCKED') {
        return {
          id: req.id,
          status: 'failed',
          error: {
            code: POLICY_BLOCKED_CODE,
            message: reason,
          },
        };
      }

      return {
        id: req.id,
        status: 'succeeded',
        response,
      };
    } catch (err) {
      const { code, message } = this.mapError(err);
      return {
        id: req.id,
        status: 'failed',
        error: { code, message },
      };
    }
  }

  /**
   * Map domain errors to BatchErrorCode.
   *
   * Handles:
   * - Timeout errors (from Promise.race)
   * - Policy/blocking errors (DomainError with specific codes)
   * - Query parsing errors (validation failures)
   * - Generic internal errors
   *
   * @param err - The error to map.
   * @returns Code and message suitable for BatchSearchError.
   */
  private mapError(err: unknown): { code: BatchErrorCode; message: string } {
    // Timeout error (thrown by createTimeoutPromise)
    if (err instanceof Error && err.message === 'RETRIEVAL_TIMEOUT') {
      return {
        code: 'RETRIEVAL_TIMEOUT',
        message: 'Request exceeded timeout',
      };
    }

    if (err instanceof DomainError) {
      const code = err.code;
      if (code === POLICY_BLOCKED_CODE || code === 'AMBIGUITY_BLOCKED') {
        return {
          code: POLICY_BLOCKED_CODE,
          message: err.message || 'Request blocked by policy',
        };
      }
    }
    if (err instanceof Error && 'code' in err) {
      const withCode = err as Error & { readonly code?: unknown };
      const code = typeof withCode.code === 'string' ? withCode.code : undefined;
      if (code === POLICY_BLOCKED_CODE || code === 'AMBIGUITY_BLOCKED') {
        return {
          code: POLICY_BLOCKED_CODE,
          message: err.message || 'Request blocked by policy',
        };
      }
    }

    // Zod validation error (query parse error)
    if (err instanceof Error && err.name === 'ZodError') {
      return {
        code: 'QUERY_PARSE_ERROR',
        message: err.message || 'Invalid query format',
      };
    }

    // Generic internal error
    if (err instanceof Error) {
      return {
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error',
      };
    }

    return {
      code: 'INTERNAL_ERROR',
      message: 'Unknown error occurred',
    };
  }

  /**
   * Create a promise that rejects after the specified timeout.
   *
   * Used with Promise.race() to enforce per-request timeouts.
   *
   * @param timeoutMs - Timeout in milliseconds.
   * @returns A promise that rejects with RETRIEVAL_TIMEOUT.
   */
  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_resolve, reject) => {
      setTimeout(() => {
        const err = new Error('RETRIEVAL_TIMEOUT');
        reject(err);
      }, timeoutMs);
    });
  }

  /**
   * Normalize and validate the timeout option.
   *
   * - Default: 5000 ms
   * - Range: 1000–30000 ms
   * - Out-of-range values are clamped
   *
   * @param timeoutMs - The timeout option (may be undefined).
   * @returns Validated timeout in milliseconds.
   */
  private normalizeTimeout(timeoutMs?: number): number {
    const actual = timeoutMs ?? BatchSearchUseCase.DEFAULT_TIMEOUT_MS;
    return Math.max(
      BatchSearchUseCase.MIN_TIMEOUT_MS,
      Math.min(actual, BatchSearchUseCase.MAX_TIMEOUT_MS),
    );
  }

  /**
   * Deterministic batch id from ordered request items (id + trimmed query per row).
   * Schema: `batch:<version>:<sha256 hex>`
   */
  private generateBatchId(
    requests: readonly BatchSearchRequestItem[],
    options: {
      readonly failFast: boolean;
      readonly timeoutMs: number;
    },
  ): string {
    const digest = deterministicHash({
      requests: requests.map((request) => ({
        id: request.id,
        query: request.query.trim(),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.retrieval_mode !== undefined ? { retrieval_mode: request.retrieval_mode } : {}),
        ...(request.context !== undefined ? { context: request.context } : {}),
        ...(request.sessionContext !== undefined ? { sessionContext: request.sessionContext } : {}),
        ...(request.queryBudget !== undefined ? { queryBudget: request.queryBudget } : {}),
      })),
      options,
    });
    return `batch:${BATCH_ID_SCHEMA_VERSION}:${digest}`;
  }
}
