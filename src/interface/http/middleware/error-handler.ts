import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
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

/**
 * Maps DomainError codes to HTTP status codes.
 */
const DOMAIN_ERROR_STATUS_MAP: Readonly<Record<string, number>> = {
  WRONG_RESOLVE: 500,
  EVIDENCE_OBLIGATION: 500,
  BLOCKING_MISS: 503,
  SNAPSHOT_MISMATCH: 409,
  MISSING_SNAPSHOT: 400,
  DETERMINISM_VIOLATION: 409,
  [POLICY_BLOCKED_CODE]: 403,
};

const RETRYABLE_DOMAIN_CODES: ReadonlySet<string> = new Set(['BLOCKING_MISS']);

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

  const fastifyError = error as { code?: string; statusCode?: number; message?: string };

  // Request timeout — 503 Service Unavailable
  // Fastify throws FST_ERR_HANDLER_TIMEOUT (statusCode=503) when a route
  // handler exceeds the configured requestTimeout option.
  // Only match the specific timeout code; other 503 errors fall through to
  // the generic handler at the bottom.
  if (fastifyError.code === 'FST_ERR_HANDLER_TIMEOUT') {
    request.log.warn({ requestId }, 'request_timeout');

    // Reset snakeCaseApplied so the preSerialization hook correctly converts
    // this response (it may have been set by a prior sendRouteContractResponse
    // call that failed before sending).
    reply.snakeCaseApplied = false;

    const body = buildSearchErrorResponse(
      requestId,
      'REQUEST_TIMEOUT',
      'Request timed out',
      null,
      true,
    );
    sendSearchErrorResponse(request, reply, 503, body);
    return;
  }

  // Rate limit — 429 Too Many Requests (RFC-014 §13)
  // @fastify/rate-limit v10 throws a FastifyError with statusCode=429 when the
  // limit is exceeded (without a custom errorResponseBuilder).
  reply.snakeCaseApplied = false;
  if (fastifyError.statusCode === 429) {
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

    sendSearchErrorResponse(request, reply, 429, body);
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

    sendSearchErrorResponse(request, reply, 400, body);
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

    sendSearchErrorResponse(request, reply, 409, body);
    return;
  }

  // DomainError — map to appropriate HTTP status
  if (error instanceof DomainError) {
    const status = DOMAIN_ERROR_STATUS_MAP[error.code] ?? 500;
    const retryable = isDomainErrorRetryable(error.code);

    request.log[error.code === POLICY_BLOCKED_CODE ? 'warn' : 'error'](
      { requestId, code: error.code, message: error.message },
      'domain_error',
    );

    if (error.code === POLICY_BLOCKED_CODE) {
      sendPolicyBlockedResponse(request, reply, requestId);
      return;
    }

    const body = buildSearchErrorResponse(
      requestId,
      error.code,
      error.message,
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

  sendSearchErrorResponse(request, reply, 500, body);
}
