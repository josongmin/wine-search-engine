import { z } from 'zod';
import {
  QueryStringSchema,
  SearchModeSchema,
  SearchContextSchema,
  SessionContextSchema,
  QueryBudgetSchema,
} from './search-shared.schema.js';
import { SearchResponseSchema } from './search-response.schema.js';

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
    .max(256, 'id must not exceed 256 characters'),
  query: QueryStringSchema,
  limit: z.number().int().positive().optional(),
  retrieval_mode: SearchModeSchema.optional(),
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
}).strict();

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
    .min(1000, 'timeout_ms must be at least 1000 milliseconds')
    .max(30000, 'timeout_ms must not exceed 30000 milliseconds')
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
    .max(20, 'requests array must not exceed 20 items'),
  options: BatchSearchOptionsSchema.optional(),
  batch_id: z.string()
    .min(1, 'batch_id must be a non-empty string')
    .max(256, 'batch_id must not exceed 256 characters')
    .optional(),
}).strict();

export type BatchSearchRequestBody = z.infer<typeof BatchSearchRequestSchema>;

const BatchSearchErrorSchema = z.object({
  code: z.enum([
    'POLICY_BLOCKED',
    'QUERY_PARSE_ERROR',
    'RETRIEVAL_TIMEOUT',
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
    status: z.literal('failed'),
    error: BatchSearchErrorSchema,
  }).strict(),
]);

export const BatchSearchResponseSchema = z.object({
  batch_id: z.string().min(1),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BatchSearchResultItemSchema),
  processing_time_ms: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.succeeded + value.failed !== value.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'succeeded + failed must equal total',
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
});

export type BatchSearchResponseBody = z.infer<typeof BatchSearchResponseSchema>;
