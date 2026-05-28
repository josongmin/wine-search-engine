import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isAbortError } from '../../../domain/shared/cooperative-abort.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../../domain/shared/error/circuit-breaker-open-error.js';
import { POLICY_BLOCKED_CODE } from '../../../domain/shared/error/policy-blocked.js';
import { SnapshotMismatchError } from '../../../application/search/replay.usecase.js';
import {
  buildSearchErrorResponse,
  sendSearchErrorResponse,
} from '../errors/error-response.js';
import { sendPolicyBlockedResponse } from '../errors/policy-blocked.js';
import { getRequestId } from '../request-id.js';
import { parseRetryAfterSecondsFromRateLimitMessage } from '../retry-after-from-rate-limit-message.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
  RETRY_AFTER_SECONDS_BLOCKING_MISS,
} from '../constants.js';

/**
 * Fastify content-type-parser (CTP) error codes that legitimately mean
 * "the client sent bad bytes / unparseable JSON" and MUST surface as 400
 * (or 415 for unsupported media types), wrapped in the RFC-014 envelope.
 *
 * Without an explicit branch, the global error handler would fall through
 * to the generic "unknown 500" path and clients would see HTTP 500
 * INTERNAL_ERROR — a misleading status code for a client-side payload
 * defect. See `node_modules/fastify/lib/errors.js` for the authoritative
 * list (matches Fastify 4.x/5.x).
 *
 * Note: `FST_ERR_CTP_BODY_TOO_LARGE` is handled separately above as a 413,
 * and `FST_ERR_CTP_INVALID_MEDIA_TYPE` is broken out below as a 415.
 */
const MALFORMED_REQUEST_BODY_ERROR_CODES: ReadonlySet<string> = new Set([
  // Body is not valid JSON (raw NaN, trailing commas, truncated input, etc.).
  'FST_ERR_CTP_INVALID_JSON_BODY',
  // Body was empty under Content-Type: application/json.
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  // Content-Length header disagreed with the actual body bytes.
  'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
]);

/**
 * Maps DomainError codes to HTTP status codes.
 */
const DOMAIN_ERROR_STATUS_MAP: Readonly<Record<string, number>> = {
  WRONG_RESOLVE: HTTP_STATUS_INTERNAL_SERVER_ERROR,
  EVIDENCE_OBLIGATION: HTTP_STATUS_INTERNAL_SERVER_ERROR,
  BLOCKING_MISS: HTTP_STATUS_SERVICE_UNAVAILABLE,
  SNAPSHOT_MISMATCH: HTTP_STATUS_CONFLICT,
  MISSING_SNAPSHOT: HTTP_STATUS_BAD_REQUEST,
  DETERMINISM_VIOLATION: HTTP_STATUS_CONFLICT,
  // Domain model invariant violations — thrown by entity factories and alias
  // constructors when input fails structural validation. Surface as 500 because
  // these represent internal logic failures, not malformed client requests.
  ENTITY_INVARIANT: HTTP_STATUS_INTERNAL_SERVER_ERROR,
  INVARIANT_VIOLATION: HTTP_STATUS_INTERNAL_SERVER_ERROR,
  // Search use-case internal consistency failure — thrown when resolved results
  // disagree with retrieval evidence in ways that should be impossible. 500.
  INTERNAL_INCONSISTENCY: HTTP_STATUS_INTERNAL_SERVER_ERROR,
  // Client sent a request that violates the endpoint's semantic contract
  // (e.g. comparison query sent to the lookup endpoint). 400.
  INVALID_REQUEST: HTTP_STATUS_BAD_REQUEST,
  [POLICY_BLOCKED_CODE]: HTTP_STATUS_FORBIDDEN,
  // Bugbash inventory #10: LLM circuit breaker OPEN fast-fails with a
  // DomainError — surface as 503 Service Unavailable (retryable) instead
  // of a generic 500. Callers (agent/search) can degrade gracefully
  // downstream; the HTTP envelope communicates retryability to clients.
  [CIRCUIT_BREAKER_OPEN_CODE]: HTTP_STATUS_SERVICE_UNAVAILABLE,
};

const RETRYABLE_DOMAIN_CODES: ReadonlySet<string> = new Set([
  'BLOCKING_MISS',
  CIRCUIT_BREAKER_OPEN_CODE,
]);

/**
 * Generic, non-sensitive messages for each domain error code. Used in HTTP
 * responses instead of `error.message` to avoid leaking SQL fragments, internal
 * IDs, snapshot hashes, user input echoes, or other sensitive details that
 * may appear in domain error messages. Detailed messages still go to logs.
 */
const SAFE_DOMAIN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  WRONG_RESOLVE: 'The engine could not confidently identify a wine for this query.',
  EVIDENCE_OBLIGATION: 'The engine could not produce a result with sufficient evidence.',
  BLOCKING_MISS: 'The retrieval layer is temporarily unavailable. Please retry.',
  SNAPSHOT_MISMATCH: 'Replay snapshot does not match the current engine version.',
  MISSING_SNAPSHOT: 'Replay snapshot was not found.',
  DETERMINISM_VIOLATION: 'Replay produced a non-deterministic result.',
  ENTITY_INVARIANT: 'An internal data consistency error occurred.',
  INVARIANT_VIOLATION: 'An internal data consistency error occurred.',
  INTERNAL_INCONSISTENCY: 'An internal consistency check failed.',
  INVALID_REQUEST: 'The request is not valid for this endpoint.',
  [CIRCUIT_BREAKER_OPEN_CODE]: 'A downstream dependency is temporarily degraded. Please retry shortly.',
};

/**
 * Determines whether a domain error is retryable.
 */
function isDomainErrorRetryable(code: string): boolean {
  return RETRYABLE_DOMAIN_CODES.has(code);
}

/**
 * Global error handler for the Fastify server.
 *
 * Handles:
 * - DomainError -> appropriate HTTP status + RFC-014 error contract
 * - SnapshotMismatchError -> 409
 * - ZodError -> 400 (validation error)
 * - Unknown errors -> 500
 *
 * Always includes request_id in the response.
 */
/**
 * Not-found handler for the Fastify server.
 *
 * Fastify's built-in 404 response (`{statusCode,error,message}`) does NOT
 * conform to the RFC-014 envelope and omits `request_id`, so every client SDK
 * that parses the envelope breaks on an unknown path. This handler returns the
 * canonical `{error:{request_id,code,message,failure_reason,retryable}}` shape.
 */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  const requestId = getRequestId(request);
  const body = buildSearchErrorResponse(
    requestId,
    'NOT_FOUND',
    'The requested resource was not found.',
    null,
    false,
  );
  sendSearchErrorResponse(request, reply, HTTP_STATUS_NOT_FOUND, body);
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = getRequestId(request);

  // If a response was already partially sent (e.g., handler partially flushed
  // headers before throwing), do not attempt to send another — Fastify would
  // throw FST_ERR_REP_ALREADY_SENT and trigger an unbounded recursion in the
  // error handler.
  if (reply.sent) {
    request.log.error({ requestId, err: error }, 'error_after_reply_sent');
    return;
  }

  // Reset snakeCaseApplied unconditionally for ALL error paths. A prior
  // sendRouteContractResponse may have set this to true before throwing — if we
  // didn't reset, the preSerialization hook would skip key conversion for the
  // error body. All error bodies built here use literal snake_case keys, so the
  // reset is always safe and never causes double-conversion.
  reply.snakeCaseApplied = false;

  // Narrow `error` to the Fastify-error-like shape using runtime typeof checks
  // rather than a blanket `as` cast (rule 12 spirit: don't coerce external/
  // foreign types without validation). Each field is independently optional
  // because Fastify's typings reflect that — only some throw paths set `code`
  // or `statusCode`.
  const fastifyError: { code?: string; statusCode?: number; message?: string } = {
    ...(typeof (error as { code?: unknown }).code === 'string'
      ? { code: (error as { code: string }).code }
      : {}),
    ...(typeof (error as { statusCode?: unknown }).statusCode === 'number'
    && Number.isFinite((error as { statusCode: number }).statusCode)
      ? { statusCode: (error as { statusCode: number }).statusCode }
      : {}),
    ...(typeof (error as { message?: unknown }).message === 'string'
      ? { message: (error as { message: string }).message }
      : {}),
  };

  // Body too large — 413 Payload Too Large
  // Fastify throws FST_ERR_CTP_BODY_TOO_LARGE when the body exceeds bodyLimit.
  // Without this branch, a 413 returns Fastify's default envelope which does
  // NOT match the RFC-014 error contract.
  if (
    fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
    || fastifyError.statusCode === HTTP_STATUS_PAYLOAD_TOO_LARGE
  ) {
    const body = buildSearchErrorResponse(
      requestId,
      'PAYLOAD_TOO_LARGE',
      'Request body exceeds the maximum allowed size.',
      null,
      false,
    );
    sendSearchErrorResponse(request, reply, HTTP_STATUS_PAYLOAD_TOO_LARGE, body);
    return;
  }

  // Malformed JSON body / empty body / mismatched Content-Length — 400.
  // Fastify's default JSON body parser throws an FST_ERR_CTP_* error for
  // these cases; without this branch they fall through to the unknown-error
  // 500 path. The CONTRACT (RFC-014) is that a client-side payload defect
  // MUST surface as 400 with the canonical error envelope (H1-F1, H1-F2).
  if (
    typeof fastifyError.code === 'string'
    && MALFORMED_REQUEST_BODY_ERROR_CODES.has(fastifyError.code)
  ) {
    request.log.warn(
      { requestId, code: fastifyError.code },
      'malformed_request_body',
    );
    const body = buildSearchErrorResponse(
      requestId,
      'MALFORMED_JSON_BODY',
      'Request body is not valid JSON.',
      null,
      false,
    );
    sendSearchErrorResponse(request, reply, HTTP_STATUS_BAD_REQUEST, body);
    return;
  }

  // Unsupported media type — 415. Fastify throws FST_ERR_CTP_INVALID_MEDIA_TYPE
  // when the request's Content-Type is missing or does not match any registered
  // content parser (e.g. text/plain hitting a JSON-only route). Surface as a
  // proper 415 with the RFC-014 envelope rather than a generic 500.
  if (fastifyError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    request.log.warn(
      { requestId, code: fastifyError.code },
      'unsupported_media_type',
    );
    const body = buildSearchErrorResponse(
      requestId,
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported request Content-Type. Expected application/json.',
      null,
      false,
    );
    sendSearchErrorResponse(request, reply, HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE, body);
    return;
  }

  // Request timeout — 503 Service Unavailable
  // Fastify throws FST_ERR_HANDLER_TIMEOUT (statusCode=503) when a route
  // handler exceeds the configured requestTimeout option.
  // Only match the specific timeout code; other 503 errors fall through to
  // the generic handler at the bottom.
  if (fastifyError.code === 'FST_ERR_HANDLER_TIMEOUT') {
    request.log.warn({ requestId }, 'request_timeout');

    const body = buildSearchErrorResponse(
      requestId,
      'REQUEST_TIMEOUT',
      'Request timed out',
      null,
      true,
    );
    sendSearchErrorResponse(request, reply, HTTP_STATUS_SERVICE_UNAVAILABLE, body);
    return;
  }

  // Rate limit — 429 Too Many Requests (RFC-014 §13)
  // Only match rate-limit plugin errors — future upstream proxies could
  // propagate 429s with different semantics. Matching on statusCode alone
  // would mis-label them as "RATE_LIMIT_EXCEEDED" with a parsed retry.
  if (
    fastifyError.statusCode === HTTP_STATUS_TOO_MANY_REQUESTS &&
    (fastifyError.code === undefined || fastifyError.code.startsWith('FST_'))
  ) {
    const rawMessage = fastifyError.message ?? '';

    request.log.warn({ requestId }, 'rate_limit_exceeded');

    const retrySeconds = parseRetryAfterSecondsFromRateLimitMessage(rawMessage);
    reply.header('Retry-After', String(retrySeconds));

    const body = buildSearchErrorResponse(
      requestId,
      'RATE_LIMIT_EXCEEDED',
      `Retry after ${String(retrySeconds)} seconds`,
      null,
      true,
    );

    sendSearchErrorResponse(request, reply, HTTP_STATUS_TOO_MANY_REQUESTS, body);
    return;
  }

  // Cooperative cancellation (AbortSignal, client disconnect) — 408
  // Distinct from 500 so clients do not treat this as a server defect.
  if (isAbortError(error)) {
    request.log.info({ requestId }, 'request_aborted');

    const body = buildSearchErrorResponse(
      requestId,
      'REQUEST_ABORTED',
      'The request was cancelled.',
      null,
      false,
    );
    sendSearchErrorResponse(request, reply, HTTP_STATUS_REQUEST_TIMEOUT, body);
    return;
  }

  // ZodError — request validation failure
  if (error instanceof ZodError) {
    const issues = error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');

    request.log.warn({ requestId, issues }, 'validation_error');

    const body = buildSearchErrorResponse(
      requestId,
      'VALIDATION_ERROR',
      `Request validation failed: ${issues}`,
      null,
      false,
    );

    sendSearchErrorResponse(request, reply, HTTP_STATUS_BAD_REQUEST, body);
    return;
  }

  // SnapshotMismatchError — 409 Conflict
  if (error instanceof SnapshotMismatchError) {
    request.log.warn({ requestId, code: error.code }, 'snapshot_mismatch');

    const body = buildSearchErrorResponse(
      requestId,
      error.code,
      error.message,
      null,
      false,
    );

    sendSearchErrorResponse(request, reply, HTTP_STATUS_CONFLICT, body);
    return;
  }

  // DomainError — map to appropriate HTTP status
  if (error instanceof DomainError) {
    const status = DOMAIN_ERROR_STATUS_MAP[error.code] ?? HTTP_STATUS_INTERNAL_SERVER_ERROR;
    const retryable = isDomainErrorRetryable(error.code);

    request.log[error.code === POLICY_BLOCKED_CODE ? 'warn' : 'error'](
      { requestId, code: error.code, message: error.message },
      'domain_error',
    );

    if (error.code === POLICY_BLOCKED_CODE) {
      sendPolicyBlockedResponse(request, reply, requestId);
      return;
    }

    // Retryable 503 errors (e.g., BLOCKING_MISS) MUST advertise Retry-After
    // per RFC 7231 §7.1.3 so SDK retry middleware honors a backoff window.
    if (retryable && status === HTTP_STATUS_SERVICE_UNAVAILABLE) {
      reply.header('Retry-After', String(RETRY_AFTER_SECONDS_BLOCKING_MISS));
    }

    // Do NOT echo `error.message` verbatim — domain errors can carry SQL fragments,
    // internal IDs, snapshot hashes, user input echoes, or LLM outputs. Use a
    // generic per-code message and keep details in server-side logs only.
    // Fallback includes the error code (already in body.error.code; codes are
    // not sensitive) so unmapped failures bucket distinctly in client trackers.
    const safeMessage = SAFE_DOMAIN_ERROR_MESSAGES[error.code]
      ?? `Request failed (${error.code}).`;
    const body = buildSearchErrorResponse(
      requestId,
      error.code,
      safeMessage,
      null,
      retryable,
    );

    sendSearchErrorResponse(request, reply, status, body);
    return;
  }

  // Unknown error — 500
  request.log.error(
    { requestId, err: error },
    'unhandled_error',
  );

  const body = buildSearchErrorResponse(
    requestId,
    'INTERNAL_ERROR',
    'An unexpected error occurred.',
    null,
    false,
  );

  try {
    sendSearchErrorResponse(request, reply, HTTP_STATUS_INTERNAL_SERVER_ERROR, body);
  } catch (sendErr) {
    // Last-resort fallback: if the error response itself fails outbound
    // validation, hand-roll a minimal contract-shaped JSON via the raw socket
    // so the client never sees a Fastify default envelope.
    request.log.error({ requestId, err: sendErr }, 'error_handler_send_failed');
    // Hard-coded safe defaults — never reuse `body` which may have caused
    // the validation failure in sendSearchErrorResponse above.
    void reply
      .status(HTTP_STATUS_INTERNAL_SERVER_ERROR)
      .header('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({
        error: {
          request_id: requestId,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          failure_reason: null,
          retryable: false,
        },
      }));
  }
}
