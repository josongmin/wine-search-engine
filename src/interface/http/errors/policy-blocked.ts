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
  sendSearchErrorResponse(request, reply, 403, buildPolicyBlockedErrorResponse(requestId));
}
