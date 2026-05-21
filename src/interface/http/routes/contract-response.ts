import type { FastifyReply, FastifyRequest } from 'fastify';
import '../fastify-augmentations.js';
import { type z } from 'zod';
import type { HttpRouteContract } from './route-contracts.js';
import { deepKeysToSnake } from '../middleware/snake-case-hook.js';
import { getRequestId } from '../request-id.js';

function validateContractResponse<T>(
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
      requestId: getRequestId(request),
      issues: parsed.error.issues,
    },
    'http_response_contract_violation',
  );

  throw new Error('HTTP response contract violation: outbound payload failed schema validation');
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

export function parseContractBody<TBody extends z.ZodTypeAny>(
  request: FastifyRequest,
  contract: { readonly body: TBody },
): z.output<TBody> {
  return contract.body.parse(request.body) as z.output<TBody>;
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

  const snakePayload = deepKeysToSnake(payload);
  // Mark reply so the preSerialization hook skips the redundant conversion.
  reply.snakeCaseApplied = true;
  sendContractResponse(
    request,
    reply,
    statusCode,
    schema as z.ZodType<unknown>,
    snakePayload,
  );
}
