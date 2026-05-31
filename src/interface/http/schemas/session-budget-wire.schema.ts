import { z } from 'zod';
import {
  MAX_QUERY_BUDGET_CANDIDATES,
  MAX_QUERY_BUDGET_DENSE_CALLS,
  MAX_QUERY_BUDGET_LATENCY_MS,
  MAX_QUERY_BUDGET_RERANK_LIMIT,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
} from '../constants.js';

/**
 * SSoT for the snake_case `session_context` / `query_budget` wire shapes
 * shared across the HTTP request and response surfaces.
 *
 * Before this module the snake-case object shape was hand-copied into
 * `search-request.schema.ts` (request, with a snake→camel `.transform()`)
 * and `search-response.schema.ts` (response, snake-only transport). The two
 * copies drifted: the request copy bounded `session_id` to
 * `MAX_SESSION_ID_CHARS` while the response copy left it unbounded.
 *
 * Resolution (domain fact): `session_id` is server-issued and capped at
 * `MAX_SESSION_ID_CHARS = 256` (see agent.schema.ts — "Server-issued;
 * bounded"). The response echoes the same server-issued id, so it can never
 * exceed that bound. The SSoT therefore enforces `MAX_SESSION_ID_CHARS` on
 * BOTH surfaces; the previously-missing bound on the response side was a
 * latent drift, not an intentional relaxation.
 *
 * The raw object schemas live here; the request surface chains `.transform()`
 * to camel-case the keys for the internal use-case contract, while the
 * response surface uses the strict object directly (snake stays snake on the
 * wire).
 */

/** Snake-case session-context wire object (server-issued ids, bounded). */
export const SessionContextWireSchema = z.object({
  session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  previous_entities: z
    .array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS))
    .max(MAX_SESSION_PREVIOUS_ENTITIES),
}).strict();

/** Snake-case query-budget wire object. */
export const QueryBudgetWireSchema = z.object({
  max_latency_ms: z.number().int().positive().max(MAX_QUERY_BUDGET_LATENCY_MS),
  max_candidates: z.number().int().positive().max(MAX_QUERY_BUDGET_CANDIDATES),
  rerank_limit: z.number().int().positive().max(MAX_QUERY_BUDGET_RERANK_LIMIT),
  max_dense_calls: z.number().int().positive().max(MAX_QUERY_BUDGET_DENSE_CALLS).optional(),
}).strict();

/**
 * Request-side alias: same snake wire object, transformed to the camelCase
 * `sessionContext` envelope the internal search use-case consumes.
 */
export const SessionContextSnakeSchema = SessionContextWireSchema.transform((value) => ({
  sessionContext: {
    sessionId: value.session_id,
    previousEntities: value.previous_entities,
  },
}));

/**
 * Request-side alias: same snake wire object, transformed to the camelCase
 * `queryBudget` envelope the internal search use-case consumes.
 */
export const QueryBudgetSnakeSchema = QueryBudgetWireSchema.transform((value) => ({
  queryBudget: {
    maxLatencyMs: value.max_latency_ms,
    maxCandidates: value.max_candidates,
    rerankLimit: value.rerank_limit,
    ...(value.max_dense_calls !== undefined ? { maxDenseCalls: value.max_dense_calls } : {}),
  },
}));
