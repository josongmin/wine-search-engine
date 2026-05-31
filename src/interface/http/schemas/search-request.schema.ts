import { z } from 'zod';
import {
  QueryBudgetSchema,
  QueryStringSchema,
  SearchContextSchema,
  SearchModeSchema,
  SearchOptionsSchema,
  SessionContextSchema,
} from './search-shared.schema.js';
import {
  // Snake-case wire shapes (SSoT, rule 30) — request side uses the
  // transforming aliases that emit camelCase envelopes for the use-case.
  QueryBudgetSnakeSchema,
  SessionContextSnakeSchema,
} from './session-budget-wire.schema.js';

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
 * Slimmer alias wrapper for retained generic entity-lookup payloads —
 * no sessionContext (entity lookup ignores it).
 * Both camelCase (queryBudget) and snake_case (query_budget) aliases are supported
 * for budget control. The live public HTTP lookup surface is
 * `POST /v1/lookup/wine`; this retained schema is for internal tooling and
 * replay/fixture validation.
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

/** Retained generic search payload schema for internal tooling / fixture
 * validation. Live public search HTTP uses `PrimitiveSearchRequestSchema`
 * through the path-authoritative primitive routes. */
export const SearchRequestSchema = withRequestAliases({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  options: SearchOptionsSchema.optional(),
  retrieval_mode: SearchModeSchema.optional(),
});

export type SearchRequestBody = z.infer<typeof SearchRequestSchema>;

/**
 * Retained generic entity-lookup payload schema for internal tooling.
 *
 * Stripped-down schema: no retrieval_mode override (always entity),
 * no options.mode (routing is not negotiable for lookup). The live public HTTP
 * surface is `POST /v1/lookup/wine`.
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
