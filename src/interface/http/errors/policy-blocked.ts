import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  POLICY_BLOCKED_CODE,
  POLICY_BLOCKED_MESSAGE,
} from '../../../domain/shared/error/policy-blocked.js';
import {
  buildSearchErrorResponse,
  getErrorRequestId,
  sendSearchErrorResponse,
} from './error-response.js';
import type { ErrorResponseBody } from '../schemas/search-response.schema.js';

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
  requestId: string = getErrorRequestId(request),
): void {
  sendSearchErrorResponse(request, reply, 403, buildPolicyBlockedErrorResponse(requestId));
}
