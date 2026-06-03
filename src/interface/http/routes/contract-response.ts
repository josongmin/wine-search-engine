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

/**
 * Eval-only EngineDecision fields that live on the in-process domain object for
 * the calibration/eval path but MUST NOT appear in the public response contract.
 * The generic camel→snake transform ({@link deepKeysToSnake}) would otherwise
 * leak them into the strict-validated wire and 500 the route. See
 * `src/domain/response/model/engine-decision.ts` (`top1RawScore`, commit
 * 5cf36815). The eval adapter reads these off the domain EngineDecision BEFORE
 * this wire boundary, so stripping here does not affect calibration capture.
 */
const EVAL_ONLY_ENGINE_DECISION_KEYS = ['top1_raw_score'] as const;

/**
 * Returns a payload with eval-only `engine_decision` fields removed. Pure:
 * never mutates the input; safe on non-object / null / string payloads.
 */
export function stripEvalOnlyFields(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;
  const engineDecision = root.engine_decision;
  if (engineDecision === null || typeof engineDecision !== 'object') return payload;

  const ed = engineDecision as Record<string, unknown>;
  const evalKeys = EVAL_ONLY_ENGINE_DECISION_KEYS as readonly string[];
  if (!evalKeys.some((k) => k in ed)) return payload;

  // Rebuild without the eval-only keys (no dynamic delete — keeps the input
  // immutable and satisfies @typescript-eslint/no-dynamic-delete).
  const nextEngineDecision = Object.fromEntries(
    Object.entries(ed).filter(([k]) => !evalKeys.includes(k)),
  );
  return { ...root, engine_decision: nextEngineDecision };
}

export function sendContractResponse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  schema: z.ZodType<T>,
  payload: unknown,
): void {
  const body = validateContractResponse(request, schema, payload);
  const serialized =
    typeof body === 'string'
      ? body
      : JSON.stringify(body);
  if (reply.getHeader('Content-Type') === undefined) {
    void reply.header('Content-Type', 'application/json; charset=utf-8');
  }
  void reply.status(statusCode).send(serialized);
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

  // Strip eval-only EngineDecision fields that the generic camel→snake
  // transform would otherwise leak into the strict-validated wire (500s the
  // route). Done at this single wire boundary so no route has to remember to.
  const snakePayload = stripEvalOnlyFields(deepKeysToSnake(payload));
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
