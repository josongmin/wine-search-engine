import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  POLICY_BLOCKED_CODE,
  POLICY_BLOCKED_MESSAGE,
} from '../../../domain/shared/error/policy-blocked.js';
import {
  buildSearchErrorResponse,
  sendSearchErrorResponse,
} from './error-response.js';
import type { ErrorResponseBody } from '../schemas/search-response.schema.js';
import { getRequestId } from '../request-id.js';
import { getAuthenticatedSubject } from '../authenticated-subject.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { HTTP_STATUS_FORBIDDEN } from '../constants.js';

const securityAuditLog = bootstrapLogger.child({ component: 'security_audit' });

/** Truncate SHA-256 hex in audit hashes (correlate without full digest). */
const POLICY_BLOCKED_AUDIT_HASH_HEX_PREFIX_CHARS = 16;

/**
 * Returns a one-way hash of a string suitable for audit logs.
 * The query text itself must not appear in logs (PII / content policy concern).
 */
function hashForAuditLog(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, POLICY_BLOCKED_AUDIT_HASH_HEX_PREFIX_CHARS);
}

export function buildPolicyBlockedErrorResponse(requestId: string): ErrorResponseBody {
  return buildSearchErrorResponse(
    requestId,
    POLICY_BLOCKED_CODE,
    POLICY_BLOCKED_MESSAGE,
    POLICY_BLOCKED_CODE,
    false,
  );
}

export function sendPolicyBlockedResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  requestId: string = getRequestId(request),
): void {
  // Structured forensic audit entry.  Fields are chosen to support incident
  // investigation without retaining PII:
  //   - timestamp: ISO-8601 wall-clock time of the rejection event
  //   - request_id: correlation handle across logs
  //   - ip: client address (resolved after trustProxy)
  //   - subject_hash: one-way hash of x-authenticated-subject (first 16 hex chars)
  //     so we can correlate repeat offenders without storing the raw API key
  //   - query_hash: one-way hash of the raw query body field so we can look up the
  //     original request in a separate audit store without logging query text here
  //   - method / url: identify the targeted endpoint
  const rawBody = request.body as Record<string, unknown> | undefined;
  const rawQuery = typeof rawBody?.['query'] === 'string' ? rawBody['query'] : '';
  const subject = getAuthenticatedSubject(request) ?? '';

  securityAuditLog.warn({
    event: 'query_blocked_policy',
    timestamp: new Date().toISOString(),
    request_id: requestId,
    ip: request.ip,
    subject_hash: subject.length > 0 ? hashForAuditLog(subject) : null,
    query_hash: rawQuery.length > 0 ? hashForAuditLog(rawQuery) : null,
    method: request.method,
    url: request.url,
  });

  sendSearchErrorResponse(request, reply, HTTP_STATUS_FORBIDDEN, buildPolicyBlockedErrorResponse(requestId));
}
