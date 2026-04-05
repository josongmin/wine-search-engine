import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import {
  POLICY_BLOCKED_CODE,
  POLICY_BLOCKED_MESSAGE,
  PolicyBlockedError,
} from '../../../domain/shared/error/policy-blocked.js';
import {
  ErrorResponseSchema,
  type ErrorResponseBody,
} from '../schemas/search-response.schema.js';
import { sendContractResponse } from '../routes/contract-response.js';

export function isPolicyBlockedSearchResponse(response: SearchResponseV1): boolean {
  return (
    response.engineDecision.decisionStatus === 'failed' &&
    response.engineDecision.failure_reason === POLICY_BLOCKED_CODE &&
    response.engineDecision.route === 'security_gate'
  );
}

export function buildPolicyBlockedErrorResponse(requestId: string): ErrorResponseBody {
  return {
    error: {
      request_id: requestId,
      code: POLICY_BLOCKED_CODE,
      message: POLICY_BLOCKED_MESSAGE,
      failure_reason: POLICY_BLOCKED_CODE,
      retryable: false,
    },
  };
}

export function sendPolicyBlockedResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  requestId: string = request.requestId,
): void {
  sendContractResponse(
    request,
    reply,
    403,
    ErrorResponseSchema,
    buildPolicyBlockedErrorResponse(requestId),
  );
}

export function throwIfPolicyBlockedSearchResponse(response: SearchResponseV1): void {
  if (isPolicyBlockedSearchResponse(response)) {
    throw new PolicyBlockedError();
  }
}
