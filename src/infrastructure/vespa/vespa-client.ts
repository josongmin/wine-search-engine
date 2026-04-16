/**
 * Low-level Vespa HTTP client.
 *
 * Wraps the Vespa HTTP/JSON Search API and Document v1 API.
 * Uses native `fetch` — no external SDK dependency.
 */

import fs from 'node:fs';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { VespaQueryResponseSchema } from './vespa-response.schema.js';
import {
  VESPA_SEARCH_TIMEOUT_MS,
} from './per-channel-timeouts.js';

const vespaLog = bootstrapLogger.child({ component: 'VespaClient' });

const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_SERVER_ERROR_MIN = 500;

/** Default Vespa HTTP timeouts (override via env / {@link VespaClient} constructor). */
interface VespaHttpTimeouts {
  readonly searchRequestMs: number;
  readonly documentMutationMs: number;
  readonly documentGetDeleteMs: number;
}

const DEFAULT_VESPA_HTTP_TIMEOUTS: VespaHttpTimeouts = {
  searchRequestMs: 30_000,
  documentMutationMs: 15_000,
  documentGetDeleteMs: 10_000,
};
const DEFAULT_VESPA_DOCUMENT_CONNECTIONS = 12;
const VESPA_DOCUMENT_CONNECTIONS = (() => {
  const raw = process.env['VESPA_DOCUMENT_CONNECTIONS'];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VESPA_DOCUMENT_CONNECTIONS;
})();

/** Fraction of hits that can be malformed before escalating from debug to warn.
 *  >20% dropped hits indicates systematic Vespa schema corruption, not stray data. */
const VESPA_HIT_DROP_WARN_THRESHOLD = 0.2;
/** Max characters of the raw Vespa response included in schema-failure logs. */
const VESPA_SCHEMA_FAIL_PREVIEW_CHARS = 500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single hit returned by the Vespa query API. */
export interface VespaHit {
  readonly id: string;
  readonly relevance: number;
  readonly source: string;
  readonly fields: Record<string, unknown>;
}

/** Top-level response envelope from the Vespa query API. */
export interface VespaQueryResponse {
  readonly root: {
    readonly id: string;
    readonly relevance: number;
    readonly fields?: { readonly totalCount: number };
    readonly children?: readonly VespaHit[];
  };
}

/** Summary of a bulk-feed operation. */
interface BulkFeedResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// VespaHttpError
// ---------------------------------------------------------------------------

/**
 * Thrown when Vespa returns a non-2xx HTTP response.
 *
 * Carries the HTTP status code and convenience flags so callers can apply
 * the right retry / circuit-breaker policy without parsing error messages:
 * - `isRateLimited` (HTTP 429): the caller should back off and retry later.
 * - `isClientError` (HTTP 4xx): the request itself is malformed; retrying
 *   without fixing the request will not help.
 * - 5xx errors are neither `isRateLimited` nor `isClientError`; they are
 *   transient server-side failures that are safe to retry.
 */
export class VespaHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly isRateLimited: boolean,
    public readonly isClientError: boolean,
  ) {
    super(message);
    this.name = 'VespaHttpError';
  }
}

// ---------------------------------------------------------------------------
// VespaNetworkError
// ---------------------------------------------------------------------------

/**
 * Thrown when a low-level network or transport error occurs while communicating
 * with Vespa (e.g. connection refused, DNS resolution failure, request aborted
 * by the AbortController timeout, or any other `fetch` rejection that is not an
 * HTTP error).
 *
 * Distinguishing network errors from HTTP errors (which carry a status code and
 * a response body) lets callers apply the right retry / circuit-breaker policy:
 * - Network errors are typically transient and safe to retry immediately.
 * - HTTP errors (4xx / 5xx) usually indicate a logic or data issue that may not
 *   resolve on retry.
 */
export class VespaNetworkError extends Error {
  /** The original error from `fetch` (always an `Error` in practice). */
  override readonly cause: Error;

  /**
   * True when the request was aborted by the caller (external AbortSignal or
   * internal timeout). Aborted requests must NOT be retried — the caller
   * already cancelled and retrying triple-counts the failure in the circuit
   * breaker (one per retry attempt vs. one for the original failure).
   */
  readonly isAborted: boolean;

  constructor(message: string, cause: Error, isAborted = false) {
    super(message);
    this.name = 'VespaNetworkError';
    this.cause = cause;
    this.isAborted = isAborted;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that an unknown value is a plain object (i.e. a `Record`).
 */
function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Vespa: expected object for ${label}, got ${typeof value}`);
  }
}

/**
 * Attempts to extract a human-readable error message from an unknown body.
 */
function extractErrorMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b['message'] === 'string') return b['message'];
    if (typeof b['error'] === 'string') return b['error'];
    return JSON.stringify(b);
  }
  return String(body);
}

/**
 * Logs the HTTP error response with appropriate severity based on status code,
 * then throws an error with a descriptive message.
 *
 * - 429 Too Many Requests: logged as warn (transient rate-limit, include Retry-After).
 * - 5xx Server Error:      logged as warn (transient server-side issue, include status).
 * - 4xx Client Error:      logged as error (bad query / caller logic issue).
 */
function handleHttpError(
  response: Response,
  operation: string,
  body: string,
): never {
  const status = response.status;

  if (status === HTTP_STATUS_TOO_MANY_REQUESTS) {
    const retryAfter = response.headers.get('Retry-After');
    vespaLog.warn(
      { status, operation, ...(retryAfter !== null ? { retryAfter } : {}) },
      `Vespa rate-limited (429) during ${operation}${retryAfter !== null ? `; Retry-After: ${retryAfter}` : ''}`,
    );
    throw new VespaHttpError(
      `Vespa ${operation} rate-limited [HTTP 429]${retryAfter !== null ? `; Retry-After: ${retryAfter}` : ''}: ${body}`,
      HTTP_STATUS_TOO_MANY_REQUESTS,
      true,
      false, // 429 is a transient rate-limit, not a client error
    );
  }

  if (status >= HTTP_STATUS_SERVER_ERROR_MIN) {
    vespaLog.warn(
      { status, operation },
      `Vespa server error (${status}) during ${operation}`,
    );
    throw new VespaHttpError(
      `Vespa ${operation} failed [HTTP ${status}]: ${body}`,
      status,
      false,
      false,
    );
  }

  // 4xx client error (non-429) — bad query or caller logic issue
  vespaLog.error(
    { status, operation },
    `Vespa client error (${status}) during ${operation}`,
  );
  throw new VespaHttpError(
    `Vespa ${operation} failed [HTTP ${status}]: ${body}`,
    status,
    false,
    true,
  );
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const VESPA_RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
} as const;

async function withRetry<T>(
  fn: () => Promise<T>,
  config = VESPA_RETRY_CONFIG,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry client errors (4xx) except rate limits
      if (err instanceof VespaHttpError && err.isClientError && !err.isRateLimited) {
        throw err;
      }
      // Don't retry aborted requests — the caller cancelled (timeout or external
      // AbortSignal). Retrying would: (a) waste resources since the caller no
      // longer cares, and (b) triple-count the failure in the circuit breaker
      // (threshold = 3), which would open the breaker on a single caller abort.
      if (err instanceof VespaNetworkError && err.isAborted) {
        throw err;
      }
      if (attempt < config.maxRetries) {
        // Bail immediately if the caller already aborted before we start sleeping.
        if (signal?.aborted === true) {
          throw lastErr;
        }
        // Full jitter (AWS architecture blog): random in [0, expDelay].
        // Without jitter, every concurrent failed request retries at the
        // same instant, creating a thundering herd against an already
        // failing Vespa under load.
        const expDelay = Math.min(
          config.baseDelayMs * 2 ** attempt,
          config.maxDelayMs,
        );
        const delay = Math.floor(Math.random() * expDelay);
        // Also abort mid-sleep if the signal fires during the wait.
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(resolve, delay);
          signal?.addEventListener('abort', () => {
            clearTimeout(id);
            const reason = signal.reason instanceof Error ? signal.reason : new Error('Aborted');
            reject(reason);
          }, { once: true });
        });
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// VespaClient
// ---------------------------------------------------------------------------

/**
 * Low-level client for the Vespa search engine.
 *
 * All methods use the native `fetch` API and throw descriptive errors that
 * include the HTTP status code on failure.
 */
/** Vespa Cloud mTLS client certificate configuration. */
interface VespaMtlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
}

/**
 * Build an undici Agent with client certificate for Vespa Cloud mTLS.
 * Returns undefined for plain HTTP (local dev without cloud).
 */
function buildMtlsDispatcher(mtls: VespaMtlsConfig | undefined): UndiciAgent | undefined {
  if (mtls === undefined) return undefined;
  return new UndiciAgent({
    connect: {
      cert: fs.readFileSync(mtls.certPath),
      key: fs.readFileSync(mtls.keyPath),
      rejectUnauthorized: true,
    },
    // Document-plane publish is throughput-sensitive; keep pipelining off for
    // correctness, but allow a wider connection pool so prepared-feed replay
    // does not serialize 7K+ upserts behind four sockets.
    connections: VESPA_DOCUMENT_CONNECTIONS,
    pipelining: 1,
    keepAliveTimeout: 30_000,
  });
}

export class VespaClient {
  private readonly timeouts: VespaHttpTimeouts;
  private readonly dispatcher: UndiciAgent | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly namespace: string,
    private readonly appName: string,
    timeouts?: Partial<VespaHttpTimeouts>,
    mtls?: VespaMtlsConfig,
  ) {
    this.timeouts = { ...DEFAULT_VESPA_HTTP_TIMEOUTS, ...timeouts };
    this.dispatcher = buildMtlsDispatcher(mtls);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Wraps `fetch` with an AbortController-based timeout.
   *
   * The request is aborted and a `VespaNetworkError` thrown if it takes longer
   * than `timeoutMs` milliseconds, or if the underlying TCP/TLS connection
   * fails for any other reason (`fetch` rejection).
   *
   * Callers can distinguish transport failures (`VespaNetworkError`) from Vespa
   * application errors (non-2xx `response.ok === false`) to apply different
   * retry / circuit-breaker policies.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();

    // If the external signal is already aborted, abort immediately so fetch
    // never starts. Without this, addEventListener would never fire (event
    // already dispatched) and the request would proceed unexpectedly.
    if (externalSignal?.aborted === true) {
      controller.abort();
    }

    const id = setTimeout(() => { controller.abort(); }, timeoutMs);

    // Forward future external aborts to our controller.
    const onExternalAbort = (): void => { controller.abort(); };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      if (this.dispatcher !== undefined) {
        // undici fetch with mTLS dispatcher — build the init object
        // conditionally to satisfy exactOptionalPropertyTypes.
        const undiciInit: Record<string, unknown> = {
          method: options.method,
          headers: options.headers,
          signal: controller.signal,
          dispatcher: this.dispatcher,
        };
        if (options.body !== undefined) undiciInit['body'] = options.body;
        return await undiciFetch(url, undiciInit as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      }
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      // `fetch` rejects with a TypeError (or DOMException for abort) when the
      // request cannot be sent at the network/transport layer — not for HTTP
      // error responses.  Wrap these in VespaNetworkError so callers can
      // distinguish transport failures from Vespa application errors.
      const cause = err instanceof Error ? err : new Error(String(err));
      const aborted = controller.signal.aborted;
      const message = aborted
        ? `Vespa request timed out after ${timeoutMs}ms (${url})`
        : `Vespa network error (${url}): ${cause.message}`;
      throw new VespaNetworkError(message, cause, aborted);
    } finally {
      clearTimeout(id);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Executes a YQL query against the Vespa search API.
   *
   * @param yql - The YQL query string.
   * @param params - Additional query parameters merged into the request body.
   * @param signal - Optional AbortSignal to cancel the request early.
   * @returns The parsed Vespa query response.
   * @throws {VespaNetworkError} On transport-level failure (timeout, connection refused, etc.).
   * @throws {Error} On non-2xx HTTP status or malformed response.
   */
  async query(
    yql: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<VespaQueryResponse> {
    return withRetry(async () => {
      const startedAt = performance.now();
      const url = `${this.baseUrl}/search/`;
      // CRITICAL: spread `params` first so a caller-supplied `yql` cannot
      // override the audited query string. The previous order
      // `{ yql, ...params }` allowed a malicious or buggy caller to swap
      // out the YQL after construction, defeating sparse-filter validation.
      const body: Record<string, unknown> = { ...params, yql };

      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(requestId !== undefined ? { 'X-Request-Id': requestId } : {}),
          },
          body: JSON.stringify(body),
        },
        VESPA_SEARCH_TIMEOUT_MS,
        signal,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        handleHttpError(response, 'query', text);
      }

      const data: unknown = await response.json();
      assertObject(data, 'query response');

      // Structural validation before casting. Vespa schema drift would
      // otherwise produce a silently-typed garbage response.
      if (!('root' in data)) {
        throw new Error('Vespa: query response missing "root" field');
      }
      const root = (data)['root'];
      if (root === null || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error('Vespa: query response "root" is not an object');
      }
      const rootObj = root as Record<string, unknown>;
      if ('children' in rootObj && rootObj['children'] !== undefined && !Array.isArray(rootObj['children'])) {
        throw new Error('Vespa: query response "root.children" is not an array');
      }

      // Filter out malformed hits before downstream consumers see them.
      // A single hit missing `relevance` (NaN-by-omission) corrupts the
      // sort comparator and downstream similarity normalization. We also
      // require `source` here because the VespaHitSchema validates it as
      // required (P1 audit gap T06-1) — dropping the bad hit is preferable
      // to failing the whole response for a single stray entry.
      const rawChildren = Array.isArray(rootObj['children']) ? rootObj['children'] : [];
      const validChildren: unknown[] = [];
      for (const hit of rawChildren) {
        if (
          hit !== null &&
          typeof hit === 'object' &&
          typeof (hit as Record<string, unknown>)['id'] === 'string' &&
          typeof (hit as Record<string, unknown>)['relevance'] === 'number' &&
          Number.isFinite((hit as Record<string, unknown>)['relevance']) &&
          typeof (hit as Record<string, unknown>)['source'] === 'string'
        ) {
          validChildren.push(hit);
        }
      }
      if (validChildren.length !== rawChildren.length) {
        const dropped = rawChildren.length - validChildren.length;
        const dropRatio = rawChildren.length > 0 ? dropped / rawChildren.length : 0;
        // Escalate to warn when >20% of hits are malformed — indicates Vespa
        // schema corruption or serialization regression, not just a stray hit.
        const logFn = dropRatio > VESPA_HIT_DROP_WARN_THRESHOLD ? bootstrapLogger.warn.bind(bootstrapLogger) : pipelineDebug;
        logFn(
          { step: PipelineDebugStep.VESPA_QUERY, dropped_malformed_hits: dropped, dropRatio },
          'pipeline vespa hit validation dropped entries',
        );
      }
      rootObj['children'] = validChildren;

      // Runtime-validate the full response shape (Epic 06 T06-1).
      // `safeParse` so we can log a structured validation error with a
      // truncated preview before throwing — schema drift is operationally
      // important to diagnose, not just to crash on.
      const validation = VespaQueryResponseSchema.safeParse(data);
      if (!validation.success) {
        bootstrapLogger.error(
          {
            err: validation.error.format(),
            preview: JSON.stringify(data).slice(0, VESPA_SCHEMA_FAIL_PREVIEW_CHARS),
          },
          '[VespaClient] Vespa response failed schema validation',
        );
        throw new Error('Vespa response shape is invalid');
      }
      // The runtime-validated shape is a superset of the declared
      // VespaQueryResponse interface (both require root; parsed adds
      // optional passthrough fields). Cast through unknown is safe here
      // because every field the interface claims has been verified.
      const parsed = validation.data as unknown as VespaQueryResponse;
      const hitCount = parsed.root.children?.length ?? 0;
      const totalCount = parsed.root.fields?.totalCount;
      const durationMs = performance.now() - startedAt;
      pipelineDebug(
        {
          step: PipelineDebugStep.VESPA_QUERY,
          duration_ms: durationMs,
          yql_length: yql.length,
          hit_count: hitCount,
          ...(totalCount !== undefined ? { total_count: totalCount } : {}),
        },
        'pipeline vespa query',
      );

      return parsed;
    }, VESPA_RETRY_CONFIG, signal);
  }

  // -------------------------------------------------------------------------
  // Document v1 API — helpers
  // -------------------------------------------------------------------------

  /**
   * Builds a Document v1 URL for the given document ID.
   * Format: /document/v1/{namespace}/{docType}/docid/{docId}
   */
  private docUrl(docType: string, docId: string): string {
    return `${this.baseUrl}/document/v1/${this.namespace}/${docType}/docid/${encodeURIComponent(docId)}`;
  }

  /**
   * Shared logic for PUT / UPDATE operations.
   */
  private async sendDocumentRequest(
    method: 'PUT' | 'POST',
    url: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(
      url,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: payload }),
      },
      this.timeouts.documentMutationMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      handleHttpError(response, `document ${method}`, text);
    }
  }

  // -------------------------------------------------------------------------
  // Document v1 API — public operations
  // -------------------------------------------------------------------------

  /**
   * Inserts or replaces a document in the index.
   *
   * Vespa `/document/v1` uses **POST** for full-document writes and **PUT** for partial
   * updates (`assign` / etc.). See document-v1 API guide.
   *
   * @param docId - The document identifier (used as the docid path segment).
   * @param fields - The document fields to store.
   * @throws {VespaNetworkError} On transport-level failure.
   * @throws {Error} On non-2xx HTTP status.
   */
  async put(docId: string, fields: Record<string, unknown>): Promise<void> {
    const url = this.docUrl(this.appName, docId);
    await this.sendDocumentRequest('POST', url, fields);
  }

  /**
   * Partially updates an existing document.
   *
   * @param docId - The document identifier.
   * @param fields - The fields to update (partial update semantics).
   * @throws {VespaNetworkError} On transport-level failure.
   * @throws {Error} On non-2xx HTTP status.
   */
  async update(docId: string, fields: Record<string, unknown>): Promise<void> {
    // Vespa partial update uses PUT with "update" path or POST with field updates.
    // We use the Document v1 UPDATE endpoint (PUT to the same URL with assign actions).
    const url = this.docUrl(this.appName, docId);
    // Build assign update map
    const assignFields: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(fields)) {
      assignFields[key] = { assign: value };
    }
    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: assignFields }),
      },
      this.timeouts.documentMutationMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      handleHttpError(response, 'document UPDATE', text);
    }
  }

  /**
   * Deletes a document from the index.
   *
   * @param docId - The document identifier.
   * @throws {VespaNetworkError} On transport-level failure.
   * @throws {Error} On non-2xx HTTP status (404 is tolerated as a no-op).
   */
  async delete(docId: string): Promise<void> {
    const url = this.docUrl(this.appName, docId);
    const response = await this.fetchWithTimeout(
      url,
      { method: 'DELETE' },
      this.timeouts.documentGetDeleteMs,
    );

    // 404 is acceptable — the document simply did not exist.
    if (!response.ok && response.status !== HTTP_STATUS_NOT_FOUND) {
      const text = await response.text().catch(() => '');
      handleHttpError(response, 'document DELETE', text);
    }
  }

  /**
   * Retrieves a single document by its identifier.
   *
   * @param docId - The document identifier.
   * @returns The document fields, or `null` if the document was not found.
   * @throws {VespaNetworkError} On transport-level failure.
   * @throws {Error} On non-2xx / non-404 HTTP status.
   */
  async get(docId: string): Promise<Record<string, unknown> | null> {
    const url = this.docUrl(this.appName, docId);
    const response = await this.fetchWithTimeout(url, {}, this.timeouts.documentGetDeleteMs);

    if (response.status === HTTP_STATUS_NOT_FOUND) return null;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      handleHttpError(response, 'document GET', text);
    }

    const data: unknown = await response.json();
    assertObject(data, 'document GET response');

    const fields = data['fields'];
    if (fields === undefined || fields === null) return {};
    assertObject(fields, 'document fields');
    return fields;
  }

  /**
   * Feeds multiple documents to Vespa in a single batched sequence of PUT
   * requests. Failures are collected and returned rather than thrown, so
   * partial success is possible.
   *
   * @param docs - Array of `{ id, fields }` pairs to feed.
   * @returns A summary of successes, failures, and error messages.
   */
  async bulkFeed(
    docs: Array<{ id: string; fields: Record<string, unknown> }>,
  ): Promise<BulkFeedResult> {
    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];

    const results = await Promise.allSettled(
      docs.map((doc) => this.put(doc.id, doc.fields)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result === undefined) continue;
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failureCount++;
        const docId = docs[i]?.id ?? `index:${i}`;
        errors.push(
          `doc[${docId}]: ${extractErrorMessage(result.reason)}`,
        );
      }
    }

    return { successCount, failureCount, errors };
  }
}
