import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HttpRouteContract } from './route-contracts.js';

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function validateContractResponse<T>(
  request: FastifyRequest,
  schema: z.ZodType<T>,
  payload: unknown,
): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  request.log.error(
    {
      requestId: request.requestId,
      issues: parsed.error.issues,
    },
    'http_response_contract_violation',
  );

  throw new Error(`HTTP response contract violation: ${formatIssues(parsed.error)}`);
}

export function sendContractResponse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  schema: z.ZodType<T>,
  payload: unknown,
): void {
  const body = validateContractResponse(request, schema, payload);
  void reply.status(statusCode).send(body);
}

export function parseContractBody<TContract extends { readonly body: z.ZodTypeAny }>(
  request: FastifyRequest,
  contract: TContract,
): z.output<TContract['body']> {
  return contract.body.parse(request.body);
}

export function sendRouteContractResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  contract: HttpRouteContract,
  statusCode: number,
  payload?: unknown,
): void {
  const schema = contract.responses[statusCode];
  if (schema === undefined) {
    throw new Error(
      `HTTP response contract missing for ${contract.operationId} status ${statusCode}`,
    );
  }

  if (schema === null) {
    if (payload !== undefined) {
      throw new Error(
        `HTTP response contract for ${contract.operationId} status ${statusCode} does not allow a body`,
      );
    }

    void reply.status(statusCode).send();
    return;
  }

  sendContractResponse(request, reply, statusCode, schema, payload);
}
