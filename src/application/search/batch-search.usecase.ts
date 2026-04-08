import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { BATCH_ID_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import { decodeBatchIdDetailed } from '../../domain/decision/service/id-schema-decoder.js';
import type {
  BatchErrorCode,
  BatchSearchExecutionContext,
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
  BatchSearchResultItem,
} from './batch-search.dto.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';

export type {
  BatchErrorCode,
  BatchSearchExecutionContext,
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
  BatchSearchResultFailure,
  BatchSearchResultItem,
  BatchSearchResultNotExecuted,
  BatchSearchResultSuccess,
} from './batch-search.dto.js';

/**
 * Semaphore-based concurrency limiter.
 *
 * Spawns `limit` concurrent workers; each worker continuously pulls the next
 * available task from a shared index until all tasks are complete. This avoids
 * the barrier-sync stall of chunk-based approaches where one slow task in a
 * batch holds up every subsequent batch from starting.
 *
 * @param tasks - Array of zero-argument async factories (one per task).
 * @param limit - Maximum number of tasks to execute simultaneously.
 * @returns Results array in the same order as `tasks`.
 */
const BATCH_ITEM_NOT_EXECUTED_ABORT_MESSAGE =
  'Batch item was not executed because the batch was cancelled.';

async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
  parentSignal?: AbortSignal,
): Promise<(T | undefined)[]> {
  const results: (T | undefined)[] = Array.from(
    { length: tasks.length },
    (): T | undefined => undefined,
  );
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      if (parentSignal?.aborted) {
        return;
      }
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * BatchSearchUseCase: orchestrates parallel or fail-fast batch search execution.
 *
 * **Parent cancellation** (`BatchSearchExecutionContext.abortSignal`, e.g. HTTP disconnect):
 * - Slots that never start: `not_executed` + `REQUEST_ABORTED`.
 * - In-flight sub-searches: cooperative cancel only — workers stop scheduling new items;
 *   running `SearchExecutorPort.execute` calls end when they honor `abortSignal`.
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

  /** Maximum concurrent searches within a partial (non-fail-fast) batch execution. */
  private static readonly BATCH_CONCURRENCY_LIMIT = 5;

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
    executionContext?: BatchSearchExecutionContext,
  ): Promise<BatchSearchResponse> {
    const startTime = Date.now();
    const timeoutMs = this.normalizeTimeout(options?.timeout_ms);
    const actualBatchId = batchId ?? this.generateBatchId(requests, {
      failFast: options?.fail_fast ?? false,
      timeoutMs,
    });
    const parentSignal = executionContext?.abortSignal;

    // Validate batch size
    if (requests.length === 0) {
      return {
        batch_id: actualBatchId,
        total: 0,
        succeeded: 0,
        failed: 0,
        not_executed: 0,
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
        not_executed: 0,
        batch_status: 'failed',
        has_failures: true,
        results: requests.map((req) => ({
          id: req.id,
          status: 'failed' as const,
          error: {
            code: 'INTERNAL_ERROR' as const,
            message: `Batch size ${requests.length} exceeds maximum of ${BatchSearchUseCase.MAX_BATCH_SIZE}`,
          },
        })),
        processing_time_ms: Date.now() - startTime,
      };
    }

    // Validate duplicate item IDs — duplicate IDs break caller correlation and idempotency
    const seenIds = new Set<string>();
    for (const req of requests) {
      if (seenIds.has(req.id)) {
        return {
          batch_id: actualBatchId,
          total: requests.length,
          succeeded: 0,
          failed: requests.length,
          not_executed: 0,
          batch_status: 'failed',
          has_failures: true,
          results: requests.map((r) => ({
            id: r.id,
            status: 'failed' as const,
            error: {
              code: 'INTERNAL_ERROR' as const,
              message: `Duplicate item id: ${req.id}`,
            },
          })),
          processing_time_ms: Date.now() - startTime,
        };
      }
      seenIds.add(req.id);
    }

    if (parentSignal?.aborted) {
      return {
        batch_id: actualBatchId,
        total: requests.length,
        succeeded: 0,
        failed: 0,
        not_executed: requests.length,
        batch_status: 'failed',
        has_failures: true,
        results: requests.map((req) => ({
          id: req.id,
          status: 'not_executed' as const,
          error: {
            code: 'REQUEST_ABORTED' as const,
            message: BATCH_ITEM_NOT_EXECUTED_ABORT_MESSAGE,
          },
        })),
        processing_time_ms: Date.now() - startTime,
      };
    }

    // Determine execution strategy
    const failFast = options?.fail_fast ?? false;
    const decodedBatchId = decodeBatchIdDetailed(actualBatchId);

    pipelineDebug(
      {
        step: 'batch.search.start',
        batch_id: actualBatchId,
        ...(decodedBatchId.ok
          ? { batch_id_schema_version: decodedBatchId.value.schemaVersion }
          : { invalid_batch_id_reason: decodedBatchId.error.reason }),
        batch_size: requests.length,
        fail_fast: failFast,
        timeout_ms: timeoutMs,
      },
      'pipeline batch search',
    );

    // Execute requests
    const results = failFast
      ? await this.executeFailFast(requests, actualBatchId, timeoutMs, parentSignal)
      : await this.executePartial(requests, actualBatchId, timeoutMs, parentSignal);

    // Aggregate results
    const succeeded = results.filter((r) => r.status === 'succeeded').length;
    const notExecuted = results.filter((r) => r.status === 'not_executed').length;
    const failed = results.length - succeeded - notExecuted;
    const anyFailures = failed > 0 || notExecuted > 0;
    const batchStatus =
      !anyFailures
        ? 'succeeded'
        : succeeded === 0
          ? 'failed'
          : 'partial_failure';

    return {
      batch_id: actualBatchId,
      total: requests.length,
      succeeded,
      failed,
      not_executed: notExecuted,
      batch_status: batchStatus,
      has_failures: anyFailures,
      results,
      processing_time_ms: Date.now() - startTime,
    };
  }

  /**
   * Execute all requests with bounded concurrency; continue on errors.
   *
   * Uses a semaphore/worker-pool pattern instead of chunk-based barrier sync.
   * Up to BATCH_CONCURRENCY_LIMIT workers run simultaneously; each worker
   * picks the next available task as soon as it finishes its current one.
   * This avoids the barrier-sync problem where a single slow request in a
   * chunk blocks all subsequent chunks from starting.
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
    parentSignal?: AbortSignal,
  ): Promise<readonly BatchSearchResultItem[]> {
    const tasks = requests.map(
      (req) => () => this.executeSingle(req, batchId, timeoutMs, parentSignal),
    );
    const raw = await runWithConcurrency(
      tasks,
      BatchSearchUseCase.BATCH_CONCURRENCY_LIMIT,
      parentSignal,
    );
    return raw.map((r, i) =>
      r ?? {
        id: requests[i]!.id,
        status: 'not_executed' as const,
        error: {
          code: 'REQUEST_ABORTED' as const,
          message: BATCH_ITEM_NOT_EXECUTED_ABORT_MESSAGE,
        },
      },
    );
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
    parentSignal?: AbortSignal,
  ): Promise<readonly BatchSearchResultItem[]> {
    const results: BatchSearchResultItem[] = [];
    for (const [index, req] of requests.entries()) {
      if (parentSignal?.aborted) {
        for (const remainingReq of requests.slice(index)) {
          results.push({
            id: remainingReq.id,
            status: 'not_executed',
            error: {
              code: 'REQUEST_ABORTED',
              message: BATCH_ITEM_NOT_EXECUTED_ABORT_MESSAGE,
            },
          });
        }
        break;
      }

      const result = await this.executeSingle(req, batchId, timeoutMs, parentSignal);
      results.push(result);

      if (result.status === 'failed') {
        // Aborted items are surfaced as not_executed so the batch cardinality is
        // preserved and the caller can distinguish which items were skipped vs failed.
        for (const remainingReq of requests.slice(index + 1)) {
          results.push({
            id: remainingReq.id,
            status: 'not_executed',
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
   * - Timer cleanup so the timeout handle is always cancelled after the race
   *   settles (prevents event-loop retention and spurious rejections).
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
    parentSignal?: AbortSignal,
  ): Promise<BatchSearchResultItem> {
    const requestId = `${batchId}-${req.id}`;

    try {
      // Build SearchRequest from batch item
      const searchRequest: SearchRequest = {
        query: req.query,
        ...(req.context !== undefined ? { context: req.context } : {}),
        ...(req.sessionContext !== undefined ? { sessionContext: req.sessionContext } : {}),
        ...(req.queryBudget !== undefined ? { queryBudget: req.queryBudget } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
        options: {
          mode: req.retrieval_mode ?? 'auto',
          explain: req.explain ?? false,
          clarification: true,
        },
      };

      // Execute with timeout; always cancel the timer after the race settles
      // to avoid holding the Node.js event loop open on successful requests.
      const timeoutController = new AbortController();
      const itemAbortSignal =
        parentSignal !== undefined
          ? AbortSignal.any([parentSignal, timeoutController.signal])
          : timeoutController.signal;
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          timeoutController.abort();
          reject(new Error('RETRIEVAL_TIMEOUT'));
        }, timeoutMs);
      });

      let rawResponse;
      try {
        rawResponse = await Promise.race([
          this.searchUseCase.execute(searchRequest, requestId, {
            abortSignal: itemAbortSignal,
          }),
          timeoutPromise,
        ]);
      } finally {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
      }

      // Batch items are defined to return the standard V1 search envelope only.
      // Comparison-style queries are unsupported in this route contract and
      // should surface as a caller-facing query-shape error, not an internal
      // server failure.
      if (rawResponse.queryType !== 'search') {
        return {
          id: req.id,
          status: 'failed',
          error: {
            code: 'QUERY_PARSE_ERROR',
            message: 'Batch search does not support comparison-style queries',
          },
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
    // Timeout error (thrown by the inline timeout promise in executeSingle)
    if (err instanceof Error && err.message === 'RETRIEVAL_TIMEOUT') {
      return {
        code: 'RETRIEVAL_TIMEOUT',
        message: 'Request exceeded timeout',
      };
    }

    if (isAbortError(err)) {
      return {
        code: 'REQUEST_ABORTED',
        message: 'Request was cancelled',
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
