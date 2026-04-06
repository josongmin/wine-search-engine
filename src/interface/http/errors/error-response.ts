import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendContractResponse } from '../routes/contract-response.js';
import {
  ErrorResponseSchema,
  type ErrorResponseBody,
} from '../schemas/search-response.schema.js';

export function buildSearchErrorResponse(
  requestId: string,
  code: string,
  message: string,
  failureReason: string | null,
  retryable: boolean,
): ErrorResponseBody {
  return {
    error: {
      request_id: requestId,
      code,
      message,
      failure_reason: failureReason,
      retryable,
    },
  };
}

export function sendSearchErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  body: ErrorResponseBody,
): void {
  sendContractResponse(request, reply, statusCode, ErrorResponseSchema, body);
}
