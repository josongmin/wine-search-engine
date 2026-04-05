import { z } from 'zod';
import { SearchContextSchema, SessionContextSchema, QueryBudgetSchema } from './search.schema.js';

/**
 * Batch search request item schema.
 *
 * Each item in the batch array represents a single search request with:
 * - id: unique identifier within the batch
 * - query: the search string (1–2000 chars)
 * - optional limit, retrieval_mode, context, sessionContext, queryBudget
 */
export const BatchSearchRequestItemSchema = z.object({
  id: z.string()
    .min(1, 'id must be a non-empty string')
    .max(256, 'id must not exceed 256 characters'),
  query: z.string()
    .min(1, 'query must be a non-empty string')
    .max(2000, 'query must not exceed 2000 characters'),
  limit: z.number().int().positive().optional(),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional(),
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
