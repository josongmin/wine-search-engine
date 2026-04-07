import { z } from 'zod';
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
  session_id: z.string().min(1),
  previous_entities: z.array(z.string().max(256)).max(50),
}).strict().transform((value) => ({
  sessionContext: {
    sessionId: value.session_id,
    previousEntities: value.previous_entities,
  },
}));

const QueryBudgetSnakeSchema = z.object({
  max_latency_ms: z.number().int().positive(),
  max_candidates: z.number().int().positive(),
  rerank_limit: z.number().int().positive(),
}).strict().transform((value) => ({
  queryBudget: {
    maxLatencyMs: value.max_latency_ms,
    maxCandidates: value.max_candidates,
    rerankLimit: value.rerank_limit,
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
        : session_context !== undefined
          ? session_context
          : {}),
      ...(queryBudget !== undefined
        ? { queryBudget }
        : query_budget !== undefined
          ? query_budget
          : {}),
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

export const ReplayRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  decision_snapshot: DecisionSnapshotSchema,
  context: SearchContextSchema.optional(),
  options: SearchOptionsSchema.optional(),
  expected_response_hash: z.string().min(1).optional(),
  preflight_honesty_contract: z.object({
    execution_mode: z.enum(['authoritative', 'degraded', 'heuristic', 'advisory']),
    degradation_reasons: z.array(z.string()),
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
