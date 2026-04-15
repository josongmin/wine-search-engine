/**
 * Shared retry utility with exponential backoff, jitter, and Retry-After support.
 *
 * Extracts duplicated retry logic from OpenAI / Anthropic LLM clients into a
 * single composable primitive. Supports:
 *   - Configurable max attempts, base delay, max delay
 *   - Full jitter exponential backoff (transient 5xx / network errors)
 *   - Rate-limit (429) backoff with optional Retry-After header floor
 *   - Cooperative abort via AbortSignal
 *   - Transient error classification (status codes + network error codes)
 */

const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_5XX_MIN = 500;
const HTTP_STATUS_5XX_MAX_EXCLUSIVE = 600;
const MILLISECONDS_PER_SECOND = 1000;
/** Jitter fraction added on top of server-mandated Retry-After: 25%.
 *  Spreads retries from concurrent requests to prevent synchronized retry storms. */
const RATE_LIMIT_JITTER_FRACTION = 0.25;

/** Network-level error codes that are transient and safe to retry. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Total attempts (initial + retries). Default 4. */
  readonly maxAttempts: number;
  /** Base delay (ms) for transient (5xx / network) errors. Default 250. */
  readonly transientBackoffBaseMs: number;
  /** Cap delay (ms) for transient errors. Default 2000. */
  readonly transientBackoffCapMs: number;
  /** Base delay (ms) for 429 rate-limit backoff. Default 2000. */
  readonly rateLimitBackoffBaseMs: number;
  /** Cap delay (ms) for 429 rate-limit backoff. Default 30000. */
  readonly rateLimitBackoffCapMs: number;
  /** Label used in error messages (e.g. "OpenAI chat", "Anthropic chat"). */
  readonly label: string;
}

/** Result returned by the attempt function on non-OK HTTP responses. */
interface RetryableHttpError {
  readonly kind: 'http-error';
  readonly status: number;
  readonly bodyText: string;
  /** Parsed Retry-After header value in seconds, or undefined. */
  readonly retryAfterSec: number | undefined;
}

/** Result returned by the attempt function on success. */
interface RetryableSuccess<T> {
  readonly kind: 'success';
  readonly value: T;
}

type AttemptResult<T> = RetryableSuccess<T> | RetryableHttpError;

/** Truncate chars in error previews. */
const ERROR_PREVIEW_CHARS = 200;

// ---------------------------------------------------------------------------
// Core utility
// ---------------------------------------------------------------------------

/**
 * Execute `attemptFn` with retry on transient failures.
 *
 * `attemptFn` receives the 1-based attempt number and must return either:
 *   - `{ kind: 'success', value }` on a successful response
 *   - `{ kind: 'http-error', status, bodyText, retryAfterSec }` on a non-OK response
 *   - throw on network-level errors (ECONNRESET, timeout, etc.)
 *
 * Network errors thrown by `attemptFn` are caught and retried if transient.
 * AbortError-shaped exceptions always propagate immediately.
 */
export async function retryWithBackoff<T>(
  attemptFn: (attempt: number) => Promise<AttemptResult<T>>,
  config: RetryConfig,
  abortSignal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Honor caller cancellation between attempts.
    if (abortSignal?.aborted === true) {
      throw new Error(`${config.label}: aborted`);
    }

    let result: AttemptResult<T>;
    try {
      result = await attemptFn(attempt);
    } catch (err) {
      // Abort errors always propagate immediately.
      if (isAbortLike(err)) {
        throw err;
      }
      // Network-level error: retry if transient and attempts remain.
      lastError = err;
      if (attempt < config.maxAttempts && isTransientNetworkError(err)) {
        await sleepWithJitter(
          attempt,
          config.transientBackoffBaseMs,
          config.transientBackoffCapMs,
          abortSignal,
          config.label,
        );
        continue;
      }
      throw err;
    }

    if (result.kind === 'success') {
      return result.value;
    }

    // HTTP error path
    const { status, bodyText, retryAfterSec } = result;
    const isRateLimit = status === HTTP_STATUS_TOO_MANY_REQUESTS;
    const isTransient =
      isRateLimit ||
      (status >= HTTP_STATUS_5XX_MIN && status < HTTP_STATUS_5XX_MAX_EXCLUSIVE);

    if (isTransient && attempt < config.maxAttempts) {
      lastError = new Error(
        `${config.label} HTTP ${status}: ${bodyText.slice(0, ERROR_PREVIEW_CHARS)}`,
      );
      if (isRateLimit) {
        await sleepRateLimit(
          attempt,
          retryAfterSec,
          config.rateLimitBackoffBaseMs,
          config.rateLimitBackoffCapMs,
          abortSignal,
          config.label,
        );
      } else {
        await sleepWithJitter(
          attempt,
          config.transientBackoffBaseMs,
          config.transientBackoffCapMs,
          abortSignal,
          config.label,
        );
      }
      continue;
    }

    throw new Error(
      `${config.label} failed [HTTP ${status}]: ${bodyText.slice(0, ERROR_PREVIEW_CHARS)}`,
    );
  }

  // Exhausted all retries
  throw lastError instanceof Error
    ? lastError
    : new Error(`${config.label}: retry budget exhausted`);
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

function isAbortLike(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'AbortError'
  );
}

/** Exported for use in attempt functions that need to classify fetch errors. */
export function isTransientNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as Record<string, unknown>)['code'];
  if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
  // Node fetch / undici sometimes wraps the real error in .cause
  const cause = (err as Record<string, unknown>)['cause'];
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as Record<string, unknown>)['code'];
    if (typeof causeCode === 'string' && TRANSIENT_NETWORK_CODES.has(causeCode)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sleep helpers
// ---------------------------------------------------------------------------

/**
 * 429 rate-limit sleep with two regimes:
 *
 * 1. Retry-After header present: honor the server-mandated floor strictly,
 *    plus a small jitter (25%) on top to decorrelate concurrent waiters.
 *
 * 2. No Retry-After: full exponential jitter in [0, baseExp]. Pure
 *    decorrelation, lets the TPM window recover at random times.
 */
async function sleepRateLimit(
  attempt: number,
  retryAfterSec: number | undefined,
  baseMs: number,
  capMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  let delayMs: number;
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    const retryAfterMs = Math.min(retryAfterSec * MILLISECONDS_PER_SECOND, capMs);
    // Server-mandated floor + small additive jitter (25% of mandate).
    const jitterCeil = Math.floor(retryAfterMs * RATE_LIMIT_JITTER_FRACTION);
    delayMs = retryAfterMs + Math.floor(Math.random() * jitterCeil);
  } else {
    const baseExpMs = Math.min(baseMs * 2 ** (attempt - 1), capMs);
    // Full jitter -- uniform in [0, baseExpMs].
    delayMs = Math.floor(Math.random() * baseExpMs);
  }
  await sleepFixed(delayMs, signal, label);
}

/** Exponential backoff with full jitter -- used for 5xx / network errors. */
async function sleepWithJitter(
  attempt: number,
  baseMs: number,
  maxMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  const expDelay = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  const delay = Math.floor(Math.random() * expDelay);
  await sleepFixed(delay, signal, label);
}

/** Fixed-duration sleep, abortable via signal.
 *  Cleans up the abort listener when the timer fires to prevent listener leaks. */
function sleepFixed(ms: number, signal: AbortSignal | undefined, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    if (signal) {
      onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error(`${label}: aborted`));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Convenience: parse Retry-After header from a Response
// ---------------------------------------------------------------------------

/** Extract a numeric Retry-After value (seconds) from a Response, or undefined.
 *  Supports both delta-seconds (`120`) and HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`)
 *  formats per RFC 7231 §7.1.3. */
export function parseRetryAfterHeader(response: Response): number | undefined {
  // Headers API is case-insensitive per spec — single lookup suffices.
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;

  // Try delta-seconds first (most common for 429 responses).
  // RFC 7231 delta-seconds = 1*DIGIT — reject partial parses like "123abc".
  if (/^\d+$/.test(header)) {
    const sec = parseFloat(header);
    if (Number.isFinite(sec) && sec > 0) return sec;
  }

  // Fall back to HTTP-date format.
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    const deltaSec = (dateMs - Date.now()) / MILLISECONDS_PER_SECOND;
    return deltaSec > 0 ? deltaSec : undefined;
  }
  return undefined;
}
