import { z } from 'zod';

// ────────────────────────────────────────────────────────────────
// Request schemas
// ────────────────────────────────────────────────────────────────

export const SearchContextSchema = z.object({
  locale: z.string().min(1),
  currency: z.string().min(1),
}).strict();

export const SessionContextSchema = z.object({
  sessionId: z.string().min(1),
  previousEntities: z.array(z.string().max(256)).max(50),
}).strict();

export const QueryBudgetSchema = z.object({
  maxLatencyMs: z.number().int().positive(),
  maxCandidates: z.number().int().positive(),
  rerankLimit: z.number().int().positive(),
}).strict();

export const SearchOptionsSchema = z.object({
  mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).default('auto'),
  explain: z.boolean().default(false),
  clarification: z.boolean().default(true),
}).strict();

export const SearchRequestSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string').max(2000),
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: SearchOptionsSchema.optional(),
}).strict();

export type SearchRequestBody = z.infer<typeof SearchRequestSchema>;

// ────────────────────────────────────────────────────────────────
// Replay request schema
// ────────────────────────────────────────────────────────────────

export const DecisionSnapshotSchema = z.object({
  model_versions: z.record(z.string(), z.string()),
  index_versions: z.record(z.string(), z.string()),
  policy_rule_version: z.string().min(1),
  threshold_profile_id: z.string().min(1),
  planner_version: z.string().min(1),
  feature_flags: z.record(z.string(), z.boolean()),
  nondeterminism_notes: z.string().optional(),
}).strict();

export const ReplayRequestSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string').max(2000),
  decision_snapshot: DecisionSnapshotSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: SearchOptionsSchema.optional(),
}).strict();

export type ReplayRequestBody = z.infer<typeof ReplayRequestSchema>;

// ────────────────────────────────────────────────────────────────
// Interpret request schema
// ────────────────────────────────────────────────────────────────

export const InterpretRequestSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string').max(2000),
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
}).strict();

export type InterpretRequestBody = z.infer<typeof InterpretRequestSchema>;

// ────────────────────────────────────────────────────────────────
// Resolve request schema
// ────────────────────────────────────────────────────────────────

export const ResolveRequestSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string').max(2000),
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
}).strict();

export type ResolveRequestBody = z.infer<typeof ResolveRequestSchema>;

// ────────────────────────────────────────────────────────────────
// Hybrid request schema
// ────────────────────────────────────────────────────────────────

export const HybridRequestSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string').max(2000),
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: z.object({
    explain: z.boolean().default(false),
    clarification: z.boolean().default(true),
  }).strict().optional(),
}).strict();

export type HybridRequestBody = z.infer<typeof HybridRequestSchema>;

// ────────────────────────────────────────────────────────────────
// Error response schema (RFC-014 error contract)
// ────────────────────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.object({
    request_id: z.string(),
    code: z.string(),
    message: z.string(),
    failure_reason: z.string().nullable(),
    retryable: z.boolean(),
  }),
});

export type ErrorResponseBody = z.infer<typeof ErrorResponseSchema>;
