import type { FastifyReply, FastifyRequest } from 'fastify';
import '../fastify-augmentations.js';
import { type z } from 'zod';
import type { HttpRouteContract } from './route-contracts.js';
import { deepKeysToSnake } from '../middleware/snake-case-hook.js';
import { getRequestId } from '../request-id.js';

/**
 * Wire-boundary DIAGNOSTIC paths (snake_case, dotted) — best-effort telemetry /
 * eval that is NOT user-facing. If strict response validation fails ONLY on
 * these, the boundary drops them and re-validates rather than 500ing the user's
 * search (Move 3 — eliminate the "diagnostic field 500s the whole response"
 * class by design). Add new diagnostic fields here instead of guarding each one
 * field-by-field at its producer.
 */
const DROPPABLE_DIAGNOSTIC_PATHS: ReadonlySet<string> = new Set([
  'stage_timings', // per-stage latency telemetry (StageTimer)
  'engine_decision.top1_raw_score', // eval-only calibration signal
]);

/**
 * Result of {@link tolerantParse}. `dropped` lists the diagnostic paths removed
 * to recover (empty on a clean parse) — surfaced so a recovery is never silent.
 */
export type TolerantParse<T> =
  | { readonly ok: true; readonly data: T; readonly dropped: readonly string[] }
  | { readonly ok: false; readonly error: z.ZodError };

/**
 * Map a schema's validation issues to the set of droppable diagnostic paths
 * that caused them — or `null` if ANY issue touches a non-droppable
 * (user-facing) path, in which case recovery is not allowed.
 */
function droppablePathsFromIssues(issues: readonly z.ZodIssue[]): string[] | null {
  const paths: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      // strict-object extra key: Zod reports the parent path + the keys.
      for (const key of issue.keys) {
        const dotted = [...issue.path, key].join('.');
        if (!DROPPABLE_DIAGNOSTIC_PATHS.has(dotted)) return null;
        paths.push(dotted);
      }
    } else {
      const dotted = issue.path.join('.');
      if (!DROPPABLE_DIAGNOSTIC_PATHS.has(dotted)) return null;
      paths.push(dotted);
    }
  }
  return paths;
}

function deleteAtPath(root: Record<string, unknown>, dotted: string): void {
  const segments = dotted.split('.');
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = cursor[segments[i] as string];
    if (next === null || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  // Reflect.deleteProperty (not the `delete` operator) — satisfies
  // @typescript-eslint/no-dynamic-delete while removing a computed key.
  Reflect.deleteProperty(cursor, segments[segments.length - 1] as string);
}

/**
 * Strict-validate `payload` against `schema`, but RECOVER (drop + re-validate)
 * when the only violations are confined to {@link DROPPABLE_DIAGNOSTIC_PATHS}.
 * A clean payload passes through unchanged; a user-facing violation (or a
 * non-droppable unknown key) still fails. Never mutates the input.
 */
export function tolerantParse<T>(schema: z.ZodType<T>, payload: unknown): TolerantParse<T> {
  const first = schema.safeParse(payload);
  if (first.success) return { ok: true, data: first.data, dropped: [] };

  const droppable = droppablePathsFromIssues(first.error.issues);
  if (droppable === null || droppable.length === 0) {
    return { ok: false, error: first.error };
  }

  const clone = structuredClone(payload) as Record<string, unknown>;
  for (const path of droppable) deleteAtPath(clone, path);

  const second = schema.safeParse(clone);
  if (second.success) return { ok: true, data: second.data, dropped: droppable };
  return { ok: false, error: second.error };
}

function validateContractResponse<T>(
  request: FastifyRequest,
  schema: z.ZodType<T>,
  payload: unknown,
): T {
  const result = tolerantParse(schema, payload);
  if (result.ok) {
    if (result.dropped.length > 0) {
      // No silent caps (CLAUDE.md): record exactly what was dropped to keep the
      // user's result rather than 500'ing on a best-effort diagnostic field.
      request.log.warn(
        {
          requestId: getRequestId(request),
          droppedDiagnosticPaths: result.dropped,
        },
        'http_response_diagnostic_dropped',
      );
    }
    return result.data;
  }

  request.log.error(
    {
      requestId: getRequestId(request),
      issues: result.error.issues,
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
