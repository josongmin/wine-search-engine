/**
 * Primitive search & lookup HTTP request schemas — T-IR-01.
 *
 * Path-authoritative selectors: each primitive endpoint owns a dedicated path
 * (`/v1/search/hybrid`, `/v1/search/semantic`, `/v1/search/lexical`) and the
 * request body deliberately CANNOT override the
 * retrieval lane. `retrieval_mode`, `sessionContext`, and other monolith-era
 * control surfaces are gone. A narrow legacy `options` envelope is still
 * accepted as a no-op compatibility shim so stale callers do not hard-fail
 * during the primitive-route cutover; the path remains the sole authority on
 * the executed lane (architecture-decision §2.2).
 *
 * Schema shape is shared across the three public search primitives — the only thing that
 * differs at the public boundary is the URL. The route handler is what
 * derives the internal `retrievalLane` from the path.
 *
 * All schemas chain `.strict()` per CLAUDE.md rule 10 — HTTP contracts MUST
 * fail closed on unknown keys.
 */

import { z } from 'zod';
import {
  MAX_QUERY_BUDGET_CANDIDATES,
  MAX_QUERY_BUDGET_DENSE_CALLS,
  MAX_QUERY_BUDGET_LATENCY_MS,
  MAX_QUERY_BUDGET_RERANK_LIMIT,
  MAX_SEARCH_RESULTS_PER_RESPONSE,
} from '../constants.js';
import {
  QueryBudgetSchema,
  QueryStringSchema,
  SearchContextSchema,
} from './search-shared.schema.js';
import { NormalizedConstraintSchema } from '@shared/types/index.js';
import { WINE_SEARCH_MAX_CONSTRAINTS } from '@app/wine-search/wine-search-schemas.js';

/**
 * Snake-case alias for {@link QueryBudgetSchema}. Mirrors the camelCase shape
 * but lets HTTP callers send `query_budget` in their canonical wire format
 * without needing to pre-translate. Both forms are accepted by
 * {@link PrimitiveSearchRequestSchema} (callers MUST supply at most one).
 */
const QueryBudgetSnakeSchema = z.object({
  max_latency_ms: z.number().int().finite().positive().max(MAX_QUERY_BUDGET_LATENCY_MS),
  max_candidates: z.number().int().finite().positive().max(MAX_QUERY_BUDGET_CANDIDATES),
  rerank_limit: z.number().int().finite().positive().max(MAX_QUERY_BUDGET_RERANK_LIMIT),
  max_dense_calls: z.number().int().finite().positive().max(MAX_QUERY_BUDGET_DENSE_CALLS).optional(),
}).strict().transform((value) => ({
  queryBudget: {
    maxLatencyMs: value.max_latency_ms,
    maxCandidates: value.max_candidates,
    rerankLimit: value.rerank_limit,
    ...(value.max_dense_calls !== undefined ? { maxDenseCalls: value.max_dense_calls } : {}),
  },
}));

const PrimitiveCompatibilityOptionsSchema = z.object({
  explain: z.boolean().optional(),
  clarification: z.boolean().optional(),
}).strict();

/**
 * Canonical body shape for every primitive search/lookup route. The four
 * endpoints differ in URL path only — the body MUST be primitive-agnostic so
 * a request payload is portable across primitives without reshaping (caller
 * picks the lane by choosing the URL, not by toggling a body field).
 */
export const PrimitiveSearchRequestSchema = z.object({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  /** Structured hard constraints injected by the caller (agent tool requests,
   *  batch API). Bypass the lexical constraint extractor — these flow
   *  straight to Vespa as YQL filter predicates. */
  filters: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS).optional(),
  /** Structured preference constraints (soft tier). Merged into the
   *  planner's ConstraintBundle.soft rather than hard YQL filters. */
  preferences: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS).optional(),
  /** Per-request result-count cap. Bounded by `MAX_SEARCH_RESULTS_PER_RESPONSE`
   *  so a single caller cannot exhaust the response budget. */
  limit: z.number().int().finite().min(1).max(MAX_SEARCH_RESULTS_PER_RESPONSE).optional(),
  /** Legacy no-op compatibility envelope. Path authority is strict: lane /
   *  mode override keys are rejected instead of silently ignored. */
  options: PrimitiveCompatibilityOptionsSchema.optional(),
  /** Per-request budget — camelCase form. */
  queryBudget: QueryBudgetSchema.optional(),
  /** Per-request budget — snake_case form (auto-normalized to `queryBudget`). */
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
  const { options, queryBudget, query_budget, ...rest } = value;
  void options;
  return {
    ...rest,
    ...(queryBudget !== undefined ? { queryBudget } : query_budget ?? {}),
  };
});
export type PrimitiveSearchRequestBody = z.infer<typeof PrimitiveSearchRequestSchema>;

/**
 * Path-specific aliases — the schema shape is identical, but each named
 * export documents which primitive owns it so the route registration site
 * and the OpenAPI catalog can wire by intent. Aliasing rather than
 * duplicating keeps shape drift at zero (CLAUDE.md rule 30).
 */
export const HybridSearchRequestSchema = PrimitiveSearchRequestSchema;
export const SemanticSearchRequestSchema = PrimitiveSearchRequestSchema;
export const LexicalSearchRequestSchema = PrimitiveSearchRequestSchema;
export const LookupWineRequestSchema = PrimitiveSearchRequestSchema;
