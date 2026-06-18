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
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';

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

export interface BatchSearchRunnerDeps {
  readonly searchExecutor: SearchExecutorPort;
}

export interface BatchSearchRunner {
  execute(
    requests: readonly BatchSearchRequestItem[],
    options?: BatchSearchOptions,
    batchId?: string,
    executionContext?: BatchSearchExecutionContext,
  ): Promise<BatchSearchResponse>;
}

/** Maximum concurrent searches within a partial (non-fail-fast) batch execution. */
const BATCH_SEARCH_CONCURRENCY_LIMIT = 5;

/** Default timeout per request (milliseconds). */
const BATCH_SEARCH_DEFAULT_TIMEOUT_MS = 5000;

/** Maximum timeout per request (milliseconds). */
const BATCH_SEARCH_MAX_TIMEOUT_MS = 30000;

/** Minimum timeout per request (milliseconds). */
const BATCH_SEARCH_MIN_TIMEOUT_MS = 1000;

/**
 * Batch search orchestrator (eval/fixture rail — no live HTTP route or Container port).
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
/** Maximum requests per batch (eval/fixture rail — no live HTTP or Container port). */
export const BATCH_SEARCH_MAX_BATCH_SIZE = 20;

/**
 * Execute a batch of search requests.
 *
 * @param requests - Array of batch search request items (max 20).
 * @param options - Batch execution options (fail_fast, timeout_ms).
 * @param batchId - Optional batch identifier; generated if not provided.
 * @returns The batch search response with all results.
 * @throws Never throws; errors are captured in the response.
 */
export async function runBatchSearch(
  deps: BatchSearchRunnerDeps,
  requests: readonly BatchSearchRequestItem[],
  options?: BatchSearchOptions,
  batchId?: string,
  executionContext?: BatchSearchExecutionContext,
): Promise<BatchSearchResponse> {
    const startTime = Date.now();
    const timeoutMs = normalizeBatchSearchTimeout(options?.timeout_ms);
    const actualBatchId = batchId ?? generateBatchSearchId(requests, {
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

    if (requests.length > BATCH_SEARCH_MAX_BATCH_SIZE) {
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
            message: `Batch size ${requests.length} exceeds maximum of ${BATCH_SEARCH_MAX_BATCH_SIZE}`,
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
      ? await executeBatchFailFast(deps, requests, actualBatchId, timeoutMs, parentSignal)
      : await executeBatchPartial(deps, requests, actualBatchId, timeoutMs, parentSignal);

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

export function buildBatchSearchRunner(searchExecutor: SearchExecutorPort): BatchSearchRunner {
  const deps: BatchSearchRunnerDeps = { searchExecutor };
  return {
    execute: (requests, options, batchId, executionContext) =>
      runBatchSearch(deps, requests, options, batchId, executionContext),
  };
}

/**
 * Execute all requests with bounded concurrency; continue on errors.
 */
async function executeBatchPartial(
  deps: BatchSearchRunnerDeps,
  requests: readonly BatchSearchRequestItem[],
  batchId: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<readonly BatchSearchResultItem[]> {
  const tasks = requests.map(
    (req) => () => executeBatchSingle(deps, req, batchId, timeoutMs, parentSignal),
  );
  const raw = await runWithConcurrency(
    tasks,
    BATCH_SEARCH_CONCURRENCY_LIMIT,
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
 */
async function executeBatchFailFast(
  deps: BatchSearchRunnerDeps,
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

    const result = await executeBatchSingle(deps, req, batchId, timeoutMs, parentSignal);
    results.push(result);

    if (result.status === 'failed') {
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

async function executeBatchSingle(
  deps: BatchSearchRunnerDeps,
  req: BatchSearchRequestItem,
  batchId: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<BatchSearchResultItem> {
  const requestId = `${batchId}-${req.id}`;

  try {
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
        deps.searchExecutor.execute(searchRequest, requestId, {
          abortSignal: itemAbortSignal,
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }

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

    const batchVisibleResponse = req.explain === true
      ? response
      : (() => {
        const { counterfactuals: _counterfactuals, ...minimalResponse } = response;
        return minimalResponse;
      })();

    return {
      id: req.id,
      status: 'succeeded',
      response: batchVisibleResponse,
    };
  } catch (err) {
    const { code, message } = mapBatchSearchError(err);
    return {
      id: req.id,
      status: 'failed',
      error: { code, message },
    };
  }
}

function mapBatchSearchError(err: unknown): { code: BatchErrorCode; message: string } {
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

  if (err instanceof Error && err.name === 'ZodError') {
    return {
      code: 'QUERY_PARSE_ERROR',
      message: err.message || 'Invalid query format',
    };
  }

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

function normalizeBatchSearchTimeout(timeoutMs?: number): number {
  const actual = timeoutMs ?? BATCH_SEARCH_DEFAULT_TIMEOUT_MS;
  return Math.max(
    BATCH_SEARCH_MIN_TIMEOUT_MS,
    Math.min(actual, BATCH_SEARCH_MAX_TIMEOUT_MS),
  );
}

function generateBatchSearchId(
  requests: readonly BatchSearchRequestItem[],
  options: {
    readonly failFast: boolean;
    readonly timeoutMs: number;
  },
): string {
  const digest = deterministicHash({
    requests: requests.map((request) => ({
      id: request.id,
      query: request.query.trim().normalize('NFC'),
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

