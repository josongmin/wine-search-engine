import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isAbortError } from '../../../domain/shared/cooperative-abort.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
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
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  RETRY_AFTER_SECONDS_BLOCKING_MISS,
} from '../constants.js';

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
  [POLICY_BLOCKED_CODE]: HTTP_STATUS_FORBIDDEN,
};

const RETRYABLE_DOMAIN_CODES: ReadonlySet<string> = new Set(['BLOCKING_MISS']);

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

  const fastifyError = error as { code?: string; statusCode?: number; message?: string };

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
