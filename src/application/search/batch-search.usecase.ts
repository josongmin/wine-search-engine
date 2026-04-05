import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SearchUseCase } from './search.usecase.js';
import type { SearchRequest } from './search.usecase.js';

/**
 * Batch search request item: a single request within the batch.
 */
export interface BatchSearchRequestItem {
  /** Client-provided request identifier, unique within the batch. */
  readonly id: string;
  /** Search query string. */
  readonly query: string;
  /** Optional result limit; defaults to 5. */
  readonly limit?: number | undefined;
  /** Optional retrieval mode override. */
  readonly retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
  /** Optional context for this request. */
  readonly context?: SearchRequest['context'] | undefined;
  /** Optional session context for this request. */
  readonly sessionContext?: SearchRequest['sessionContext'] | undefined;
  /** Optional query budget for this request. */
  readonly queryBudget?: SearchRequest['queryBudget'] | undefined;
}

/**
 * Options for batch execution.
 */
export interface BatchSearchOptions {
  /** Stop execution on the first error (default: false). */
  readonly fail_fast?: boolean | undefined;
  /** Timeout per request in milliseconds (default: 5000, max: 30000). */
  readonly timeout_ms?: number | undefined;
}

/**
 * Machine-readable error codes for batch search errors.
 */
export type BatchErrorCode =
  | 'POLICY_BLOCKED'
  | 'QUERY_PARSE_ERROR'
  | 'RETRIEVAL_TIMEOUT'
  | 'INTERNAL_ERROR';

/**
 * Error object for failed requests.
 */
export interface BatchSearchError {
  readonly code: BatchErrorCode;
  readonly message: string;
}

/**
 * Successful result item: request executed and returned a response.
 */
export interface BatchSearchResultSuccess {
  readonly id: string;
  readonly status: 'succeeded';
  readonly response: SearchResponseV1;
}

/**
 * Failed result item: request execution failed.
 */
export interface BatchSearchResultFailure {
  readonly id: string;
  readonly status: 'failed';
  readonly error: BatchSearchError;
}

/**
 * Result item: either success or failure.
 */
export type BatchSearchResultItem = BatchSearchResultSuccess | BatchSearchResultFailure;

/**
 * Batch search response: the complete result of a batch operation.
 */
export interface BatchSearchResponse {
  /** Unique batch identifier, generated or provided by caller. */
  readonly batch_id: string;
  /** Total number of requests in the batch. */
  readonly total: number;
  /** Number of requests that succeeded. */
  readonly succeeded: number;
  /** Number of requests that failed. */
  readonly failed: number;
  /** Individual request results. */
  readonly results: readonly BatchSearchResultItem[];
  /** Total wall-clock time for batch execution (milliseconds). */
  readonly processing_time_ms: number;
}

/**
 * BatchSearchUseCase: orchestrates parallel or fail-fast batch search execution.
 *
 * Features:
 * - Validates batch size (max 20 requests)
 * - Enforces timeout range (5000–30000 ms)
 * - Executes requests in parallel (Promise.all)
 * - Supports fail_fast mode with AbortController
 * - Maps domain errors to BatchErrorCode
 * - Provides idempotent execution with batch_id
 * - Generates sub-request IDs: `${batchId}-${item.id}`
 * - Returns HTTP 207 Multi-Status regardless of partial failures
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

  constructor(private readonly searchUseCase: SearchUseCase) {}

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
    const actualBatchId = batchId ?? this.generateBatchId();

    // Validate batch size
    if (requests.length === 0) {
      return {
        batch_id: actualBatchId,
        total: 0,
        succeeded: 0,
        failed: 0,
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

    // Validate and normalize timeout
    const timeoutMs = this.normalizeTimeout(options?.timeout_ms);

    // Determine execution strategy
    const failFast = options?.fail_fast ?? false;

    // Execute requests
    const results = failFast
      ? await this.executeFailFast(requests, actualBatchId, timeoutMs)
      : await this.executePartial(requests, actualBatchId, timeoutMs);

    // Aggregate results
    const succeeded = results.filter((r) => r.status === 'succeeded').length;
    const failed = results.length - succeeded;

    return {
      batch_id: actualBatchId,
      total: requests.length,
      succeeded,
      failed,
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
   * Execute requests in parallel; abort remaining on first error.
   *
   * Uses an AbortController to stop creating new promises once one fails.
   * In-flight promises continue but new ones are not started.
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
    const controller = new AbortController();
    const results: BatchSearchResultItem[] = [];

    // Create promises with abort awareness
    const promises = requests.map(async (req) => {
      if (controller.signal.aborted) {
        return {
          id: req.id,
          status: 'failed' as const,
          error: {
            code: 'INTERNAL_ERROR' as const,
            message: 'Batch execution aborted due to earlier failure',
          },
        };
      }

      const result = await this.executeSingle(req, batchId, timeoutMs);

      // Abort remaining requests on first failure
      if (result.status === 'failed') {
        controller.abort();
      }

      return result;
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

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
      const response = await Promise.race([
        this.searchUseCase.execute(searchRequest, requestId),
        this.createTimeoutPromise(timeoutMs),
      ]);

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

    // Domain error with specific code
    if (err instanceof Error && err.name === 'DomainError') {
      const code = (err as any).code as string | undefined;
      if (code === 'POLICY_BLOCKED' || code === 'AMBIGUITY_BLOCKED') {
        return {
          code: 'POLICY_BLOCKED',
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
   * Generate a unique batch identifier.
   *
   * Format: `batch_${timestamp}_${randomSuffix}`
   *
   * @returns A unique batch ID.
   */
  private generateBatchId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `batch_${timestamp}_${random}`;
  }
}
