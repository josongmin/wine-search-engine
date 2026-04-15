/**
 * Shared failure classification for LLM adapter circuit breakers.
 *
 * Circuit breakers on LLM adapters protect against *service health*
 * degradation — not against client-side programming errors. A 400
 * "invalid request" response means the caller sent a bad body; the
 * upstream service is perfectly healthy, so we must NOT count it as a
 * failure. Otherwise, a buggy caller could single-handedly trip the
 * breaker and deny service to every other caller.
 *
 * Rules:
 *   - 5xx, 429, 408 → service health failure (recordFailure)
 *   - Other 4xx (400, 401, 403, 404, 422, ...) → not a health issue
 *     (recordSuccess — the server was healthy enough to reject us)
 *   - Network / transport / timeout errors with no HTTP status → failure
 *   - AbortError → neither success nor failure (caller cancelled)
 *
 * The adapter wires this helper into a manual try/catch around its SDK
 * call (see anthropic-chat-llm.ts / openai-chat-llm.ts) because the
 * default `circuitBreaker.execute()` blanket-counts every throw as a
 * failure, which is wrong for 4xx.
 */

import type { CircuitBreaker } from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';

/** HTTP status codes that indicate upstream service degradation. */
const HTTP_STATUS_REQUEST_TIMEOUT = 408;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_5XX_MIN = 500;
const HTTP_STATUS_5XX_MAX_EXCLUSIVE = 600;
const HTTP_STATUS_4XX_MIN = 400;
const HTTP_STATUS_4XX_MAX_EXCLUSIVE = 500;

/**
 * Extract an HTTP status code from a thrown error, if any.
 *
 * Supports two shapes:
 *   1. Structured errors with a numeric `status` field (Anthropic SDK, fetch wrappers)
 *   2. Errors whose `message` contains `HTTP <status>` — the shape produced by
 *      our retryWithBackoff helper when it exhausts retries on a persistent
 *      HTTP error (`... failed [HTTP 503]: ...`).
 */
function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  // Shape 1: SDK-style `status` field
  const statusField = (err as Record<string, unknown>)['status'];
  if (typeof statusField === 'number' && Number.isFinite(statusField)) {
    return statusField;
  }

  // Shape 2: stringified HTTP status in the error message
  if (err instanceof Error) {
    const match = err.message.match(/HTTP\s+(\d{3})/);
    if (match?.[1] !== undefined) {
      const code = parseInt(match[1], 10);
      if (Number.isFinite(code)) return code;
    }
  }

  return undefined;
}

/** Returns true for AbortError-like exceptions that must not touch the breaker. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  return false;
}

/**
 * Classify a thrown error as "upstream service degradation" (should trip
 * the breaker) vs "caller fault / cancelled" (must not trip the breaker).
 *
 * Returns:
 *   - 'service-failure' → recordFailure()
 *   - 'caller-fault'    → recordSuccess() (service was healthy)
 *   - 'abort'           → neither (caller cancelled, don't pollute stats)
 */
function classifyLlmError(err: unknown): 'service-failure' | 'caller-fault' | 'abort' {
  if (isAbortError(err)) return 'abort';

  if (err instanceof CircuitBreakerOpenError) {
    // Shouldn't reach the classifier (we fast-fail before the SDK call),
    // but if it somehow does, it's a breaker artifact — not an upstream signal.
    return 'abort';
  }

  const status = extractHttpStatus(err);
  if (status !== undefined) {
    if (status === HTTP_STATUS_REQUEST_TIMEOUT) return 'service-failure';
    if (status === HTTP_STATUS_TOO_MANY_REQUESTS) return 'service-failure';
    if (status >= HTTP_STATUS_5XX_MIN && status < HTTP_STATUS_5XX_MAX_EXCLUSIVE) return 'service-failure';
    if (status >= HTTP_STATUS_4XX_MIN && status < HTTP_STATUS_4XX_MAX_EXCLUSIVE) return 'caller-fault';
    // 1xx/2xx/3xx shouldn't reach an error path — fall through to service-failure.
  }

  // No recognizable status → treat as network/transport/timeout failure.
  return 'service-failure';
}

/**
 * Run `fn` under a circuit breaker with LLM-aware failure classification.
 *
 * Unlike `CircuitBreaker.execute()`, this helper does NOT count 4xx
 * (non-429) errors as failures, because they reflect client bugs, not
 * upstream health.
 *
 * Flow:
 *   1. Read `breaker.state` — this getter is side-effecting in the good
 *      sense: it lazily transitions OPEN → HALF_OPEN when the recovery
 *      window has elapsed, so we pick up probing eligibility for free.
 *   2. If OPEN, throw CircuitBreakerOpenError synchronously (fast-fail).
 *   3. Otherwise run `fn()` and hand-classify the outcome. We deliberately
 *      do NOT route through `breaker.execute()` because that helper blanket-
 *      records every throw as a failure, which would wrongly trip the
 *      breaker on 4xx (caller fault).
 *
 * Trade-off: we lose the HALF_OPEN probe quota enforcement that lives
 * inside `execute()`. For LLM adapters this is acceptable — concurrent
 * probes during a recovery window are bounded by ordinary request
 * concurrency at the call site, and a probe failing will immediately
 * re-open the breaker.
 */
export async function runUnderLlmBreaker<T>(
  breaker: CircuitBreaker,
  breakerName: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Fast-fail: reading `state` also performs the lazy OPEN → HALF_OPEN
  // transition based on wall-clock, so this single check is enough.
  if (breaker.state === 'OPEN') {
    throw new CircuitBreakerOpenError(breakerName);
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (err) {
    const kind = classifyLlmError(err);
    if (kind === 'service-failure') {
      breaker.recordFailure();
    } else if (kind === 'caller-fault') {
      // Service was healthy enough to reject us — credit it as a success
      // so a buggy caller can't single-handedly trip the breaker.
      breaker.recordSuccess();
    }
    // 'abort' → leave breaker stats untouched.
    throw err;
  }
}
