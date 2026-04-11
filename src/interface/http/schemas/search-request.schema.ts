import { z } from 'zod';
import {
  MAX_QUERY_BUDGET_CANDIDATES,
  MAX_QUERY_BUDGET_DENSE_CALLS,
  MAX_QUERY_BUDGET_LATENCY_MS,
  MAX_QUERY_BUDGET_RERANK_LIMIT,
  MAX_SEARCH_SHORT_STRING_LIST,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
} from '../constants.js';
import {
  DecisionSnapshotSchema,
  HybridOptionsSchema,
  QueryBudgetSchema,
  QueryStringSchema,
  SearchContextSchema,
  SearchModeSchema,
  SearchOptionsSchema,
  SessionContextSchema,
} from './search-shared.schema.js';

const SessionContextSnakeSchema = z.object({
  session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  previous_entities: z.array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS)).max(MAX_SESSION_PREVIOUS_ENTITIES),
}).strict().transform((value) => ({
  sessionContext: {
    sessionId: value.session_id,
    previousEntities: value.previous_entities,
  },
}));

const QueryBudgetSnakeSchema = z.object({
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

function withRequestAliases<T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ...shape,
    sessionContext: SessionContextSchema.optional(),
    session_context: SessionContextSnakeSchema.optional(),
    queryBudget: QueryBudgetSchema.optional(),
    query_budget: QueryBudgetSnakeSchema.optional(),
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
}

/**
 * Slimmer alias wrapper for lookup — no sessionContext (entity route ignores it).
 * Both camelCase (queryBudget) and snake_case (query_budget) aliases are supported
 * for budget control. Callers that need session affinity should use POST /v1/search.
 */
function withLookupAliases<T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ...shape,
    queryBudget: QueryBudgetSchema.optional(),
    query_budget: QueryBudgetSnakeSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.queryBudget !== undefined && value.query_budget !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use either queryBudget or query_budget, not both.',
        path: ['query_budget'],
      });
    }
  }).transform((value) => {
    const { queryBudget, query_budget, ...rest } = value;
    return {
      ...rest,
      ...(queryBudget !== undefined ? { queryBudget } : query_budget ?? {}),
    };
  });
}

export const SearchRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  options: SearchOptionsSchema.optional(),
  retrieval_mode: SearchModeSchema.optional(),
});

export type SearchRequestBody = z.infer<typeof SearchRequestSchema>;

/**
 * POST /v1/search/lookup — entity-only (exact match) search.
 *
 * Stripped-down schema: no retrieval_mode override (always entity),
 * no options.mode (routing is not negotiable for lookup).
 */
const LookupOptionsSchema = z.object({
  explain: z.boolean().default(false),
}).strict();

export const LookupRequestSchema = withLookupAliases({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  options: LookupOptionsSchema.optional(),
});

export type LookupRequestBody = z.infer<typeof LookupRequestSchema>;

export const ReplayRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  decision_snapshot: DecisionSnapshotSchema,
  context: SearchContextSchema.optional(),
  options: SearchOptionsSchema.optional(),
  expected_response_hash: z.string().min(1).optional(),
  preflight_honesty_contract: z.object({
    execution_mode: z.enum(['authoritative', 'degraded', 'heuristic', 'advisory']),
    degradation_reasons: z.array(z.string().min(1)).max(MAX_SEARCH_SHORT_STRING_LIST),
    blocking_eligible: z.boolean().optional(),
  }).strict().optional(),
});

export type ReplayRequestBody = z.infer<typeof ReplayRequestSchema>;

export const InterpretRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
});

export type InterpretRequestBody = z.infer<typeof InterpretRequestSchema>;

export const ResolveRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
});

export type ResolveRequestBody = z.infer<typeof ResolveRequestSchema>;

export const HybridRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  options: HybridOptionsSchema.optional(),
});

export type HybridRequestBody = z.infer<typeof HybridRequestSchema>;
