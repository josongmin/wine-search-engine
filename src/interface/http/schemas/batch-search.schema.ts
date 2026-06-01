import { z } from 'zod';
import {
  MAX_BATCH_SEARCH_REQUEST_ITEMS,
  MAX_QUERY_BUDGET_CANDIDATES,
  MAX_QUERY_BUDGET_DENSE_CALLS,
  MAX_QUERY_BUDGET_LATENCY_MS,
  MAX_QUERY_BUDGET_RERANK_LIMIT,
  MAX_SEARCH_RESULTS_PER_RESPONSE,
  MAX_ENTITY_ID_CHARS,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
  MIN_BATCH_SEARCH_ITEM_TIMEOUT_MS,
} from '../constants.js';
import {
  QueryStringSchema,
  SearchContextSchema,
  SessionContextSchema,
  QueryBudgetSchema,
} from './search-shared.schema.js';
import { SearchResponseSchema } from './search-response.schema.js';

const BatchSearchRetrievalModeSchema = z.enum(['auto', 'entity', 'hybrid']);

const BatchSessionContextSnakeSchema = z.object({
  session_id: z.string().min(1),
  previous_entities: z.array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS)).max(MAX_SESSION_PREVIOUS_ENTITIES),
}).strict().transform((value) => ({
  sessionContext: {
    sessionId: value.session_id,
    previousEntities: value.previous_entities,
  },
}));

const BatchQueryBudgetSnakeSchema = z.object({
  max_latency_ms: z.number().int().positive().max(MAX_QUERY_BUDGET_LATENCY_MS),
  max_candidates: z.number().int().positive().max(MAX_QUERY_BUDGET_CANDIDATES),
  rerank_limit: z.number().int().positive().max(MAX_QUERY_BUDGET_RERANK_LIMIT),
  max_dense_calls: z.number().int().positive().max(MAX_QUERY_BUDGET_DENSE_CALLS).optional(),
}).strict().transform((value) => ({
  queryBudget: {
    maxLatencyMs: value.max_latency_ms,
    maxCandidates: value.max_candidates,
    rerankLimit: value.rerank_limit,
    ...(value.max_dense_calls !== undefined ? { maxDenseCalls: value.max_dense_calls } : {}),
  },
}));

/**
 * Batch search request item schema.
 *
 * Each item in the batch array represents a single search request with:
 * - id: unique identifier within the batch
 * - query: the search string (1–500 chars)
 * - optional limit, retrieval_mode, context, sessionContext, queryBudget
 */
export const BatchSearchRequestItemSchema = z.object({
  id: z.string()
    .min(1, 'id must be a non-empty string')
    .max(MAX_ENTITY_ID_CHARS, `id must not exceed ${String(MAX_ENTITY_ID_CHARS)} characters`),
  query: QueryStringSchema,
  limit: z.number().int().positive().max(MAX_SEARCH_RESULTS_PER_RESPONSE).optional(),
  retrieval_mode: BatchSearchRetrievalModeSchema.optional(),
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  session_context: BatchSessionContextSnakeSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  query_budget: BatchQueryBudgetSnakeSchema.optional(),
  /** When true, the response includes counterfactuals for this item. */
  explain: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionContext !== undefined && value.session_context !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use either sessionContext or session_context, not both.',
      path: ['session_context'],
    });
  }
  if (value.queryBudget !== undefined && value.query_budget !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use either queryBudget or query_budget, not both.',
      path: ['query_budget'],
    });
  }
}).transform((value) => {
  const {
    sessionContext,
    session_context,
    queryBudget,
    query_budget,
    ...rest
  } = value;
  return {
    ...rest,
    ...(sessionContext !== undefined
      ? { sessionContext }
      : session_context ?? {}),
    ...(queryBudget !== undefined
      ? { queryBudget }
      : query_budget ?? {}),
  };
});

/**
 * Batch search options schema.
 *
 * Options control execution behavior:
 * - fail_fast: stop on first error (default false)
 * - timeout_ms: per-request timeout in milliseconds (default 5000, range 1000–30000)
 */
export const BatchSearchOptionsSchema = z.object({
  fail_fast: z.boolean().optional(),
  timeout_ms: z.number()
    .int()
    .min(
      MIN_BATCH_SEARCH_ITEM_TIMEOUT_MS,
      `timeout_ms must be at least ${String(MIN_BATCH_SEARCH_ITEM_TIMEOUT_MS)} milliseconds`,
    )
    .max(
      MAX_QUERY_BUDGET_LATENCY_MS,
      `timeout_ms must not exceed ${String(MAX_QUERY_BUDGET_LATENCY_MS)} milliseconds`,
    )
    .optional(),
}).strict();

/**
 * Batch search request body schema.
 *
 * Top-level request structure:
 * - requests: array of batch items (required, max 20)
 * - options: batch execution options (optional)
 * - batch_id: optional batch identifier for idempotency
 */
export const BatchSearchRequestSchema = z.object({
  requests: z.array(BatchSearchRequestItemSchema)
    .min(1, 'requests array must contain at least 1 item')
    .max(
      MAX_BATCH_SEARCH_REQUEST_ITEMS,
      `requests array must not exceed ${String(MAX_BATCH_SEARCH_REQUEST_ITEMS)} items`,
    ),
  options: BatchSearchOptionsSchema.optional(),
  batch_id: z.string()
    .min(1, 'batch_id must be a non-empty string')
    .max(
      MAX_ENTITY_ID_CHARS,
      `batch_id must not exceed ${String(MAX_ENTITY_ID_CHARS)} characters`,
    )
    .optional(),
}).strict().superRefine((value, ctx) => {
  const ids = value.requests.map((r) => r.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate request id: "${id}". Each item in the batch must have a unique id.`,
        path: ['requests'],
      });
      return;
    }
    seen.add(id);
  }
});

export type BatchSearchRequestBody = z.infer<typeof BatchSearchRequestSchema>;

const BatchSearchErrorSchema = z.object({
  code: z.enum([
    'POLICY_BLOCKED',
    'QUERY_PARSE_ERROR',
    'RETRIEVAL_TIMEOUT',
    'REQUEST_ABORTED',
    'INTERNAL_ERROR',
  ]),
  message: z.string().min(1),
}).strict();

export const BatchSearchResultItemSchema = z.discriminatedUnion('status', [
  z.object({
    id: z.string().min(1),
    status: z.literal('succeeded'),
    response: SearchResponseSchema,
  }).strict(),
  z.object({
    id: z.string().min(1),
    /** Item ran but threw an error. */
    status: z.literal('failed'),
    error: BatchSearchErrorSchema,
  }).strict(),
  z.object({
    id: z.string().min(1),
    /** Item was never started (fail_fast abort or pre-run skip). */
    status: z.literal('not_executed'),
    error: BatchSearchErrorSchema,
  }).strict(),
]);

export const BatchSearchResponseSchema = z.object({
  batch_id: z.string().min(1),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  /** Items that ran but threw an error. */
  failed: z.number().int().nonnegative(),
  /** Items that were never started (fail_fast abort or pre-run skip). */
  not_executed: z.number().int().nonnegative(),
  batch_status: z.enum(['succeeded', 'partial_failure', 'failed']),
  has_failures: z.boolean(),
  results: z.array(BatchSearchResultItemSchema).max(MAX_BATCH_SEARCH_REQUEST_ITEMS),
  processing_time_ms: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.succeeded + value.failed + value.not_executed !== value.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'succeeded + failed + not_executed must equal total',
      path: ['total'],
    });
  }

  if (value.results.length !== value.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'results length must equal total',
      path: ['results'],
    });
  }

  const anyFailures = value.failed > 0 || value.not_executed > 0;
  const expectedStatus =
    !anyFailures
      ? 'succeeded'
      : value.succeeded === 0
        ? 'failed'
        : 'partial_failure';
  if (value.batch_status !== expectedStatus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'batch_status must match succeeded/failed/not_executed counts',
      path: ['batch_status'],
    });
  }

  if (value.has_failures !== anyFailures) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'has_failures must be true when failed > 0 or not_executed > 0',
      path: ['has_failures'],
    });
  }
});

export type BatchSearchResponseBody = z.infer<typeof BatchSearchResponseSchema>;
