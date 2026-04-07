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

export const SearchRequestSchema = z.object({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: SearchOptionsSchema.optional(),
  retrieval_mode: SearchModeSchema.optional(),
}).strict();

export type SearchRequestBody = z.infer<typeof SearchRequestSchema>;

export const ReplayRequestSchema = z.object({
  query: QueryStringSchema,
  decision_snapshot: DecisionSnapshotSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: SearchOptionsSchema.optional(),
  expected_response_hash: z.string().min(1).optional(),
  preflight_honesty_contract: z.object({
    execution_mode: z.enum(['authoritative', 'degraded', 'heuristic', 'advisory']),
    degradation_reasons: z.array(z.string()),
    blocking_eligible: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type ReplayRequestBody = z.infer<typeof ReplayRequestSchema>;

export const InterpretRequestSchema = z.object({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
}).strict();

export type InterpretRequestBody = z.infer<typeof InterpretRequestSchema>;

export const ResolveRequestSchema = z.object({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
}).strict();

export type ResolveRequestBody = z.infer<typeof ResolveRequestSchema>;

export const HybridRequestSchema = z.object({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: HybridOptionsSchema.optional(),
}).strict();

export type HybridRequestBody = z.infer<typeof HybridRequestSchema>;
