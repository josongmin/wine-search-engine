import { z } from 'zod';
import { MAX_QUERY_LENGTH } from '../../../domain/shared/constants.js';

export const QueryStringSchema = z
  .string()
  .min(1, 'query must be a non-empty string')
  .max(MAX_QUERY_LENGTH);

export const SearchModeSchema = z.enum(['auto', 'entity', 'hybrid', 'mixed']);

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
  mode: SearchModeSchema.default('auto'),
  explain: z.boolean().default(false),
  clarification: z.boolean().default(true),
}).strict();

export const HybridOptionsSchema = z.object({
  explain: z.boolean().default(false),
  clarification: z.boolean().default(true),
}).strict();

export const DecisionSnapshotSchema = z.object({
  model_versions: z.record(z.string(), z.string()),
  index_versions: z.record(z.string(), z.string()),
  policy_rule_version: z.string().min(1),
  threshold_profile_id: z.string().min(1),
  planner_version: z.string().min(1),
  feature_flags: z.record(z.string(), z.boolean()),
  nondeterminism_notes: z.string().optional(),
}).strict();
