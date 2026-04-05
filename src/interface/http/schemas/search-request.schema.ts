import { z } from 'zod';
import {
  DecisionSnapshotSchema,
  HybridOptionsSchema,
  QueryBudgetSchema,
  QueryStringSchema,
  SearchContextSchema,
  SearchOptionsSchema,
  SessionContextSchema,
} from './search-shared.schema.js';

export const SearchRequestSchema = z.object({
  query: QueryStringSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: SearchOptionsSchema.optional(),
}).strict();

export type SearchRequestBody = z.infer<typeof SearchRequestSchema>;

export const ReplayRequestSchema = z.object({
  query: QueryStringSchema,
  decision_snapshot: DecisionSnapshotSchema,
  context: SearchContextSchema.optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  options: SearchOptionsSchema.optional(),
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
