import { z } from 'zod';
import { MAX_QUERY_LENGTH } from '../../../domain/shared/constants.js';
import {
  MAX_CURRENCY_CODE_CHARS,
  MAX_QUERY_BUDGET_CANDIDATES,
  MAX_QUERY_BUDGET_DENSE_CALLS,
  MAX_QUERY_BUDGET_LATENCY_MS,
  MAX_QUERY_BUDGET_RERANK_LIMIT,
  MAX_SEARCH_CONTEXT_LOCALE_CHARS,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
} from '../constants.js';

export const QueryStringSchema = z
  .string()
  .min(1, 'query must be a non-empty string')
  .max(MAX_QUERY_LENGTH);

export const SearchModeSchema = z.enum(['auto', 'entity', 'hybrid', 'mixed']);

export const SearchContextSchema = z.object({
  locale: z.string().min(1).max(MAX_SEARCH_CONTEXT_LOCALE_CHARS),
  currency: z.string().min(1).max(MAX_CURRENCY_CODE_CHARS),
}).strict();

export const SessionContextSchema = z.object({
  sessionId: z.string().min(1),
  previousEntities: z.array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS)).max(MAX_SESSION_PREVIOUS_ENTITIES),
}).strict();

export const QueryBudgetSchema = z.object({
  maxLatencyMs: z.number().int().positive().max(MAX_QUERY_BUDGET_LATENCY_MS),
  maxCandidates: z.number().int().positive().max(MAX_QUERY_BUDGET_CANDIDATES),
  rerankLimit: z.number().int().positive().max(MAX_QUERY_BUDGET_RERANK_LIMIT),
  // Optional: caps the number of dense (embedding) retrieval calls per query.
  // Aligns with response-side QueryBudgetTransportSchema and domain QueryBudget.
  maxDenseCalls: z.number().int().positive().max(MAX_QUERY_BUDGET_DENSE_CALLS).optional(),
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
  snapshot_id: z.string().min(1),
  model_versions: z.record(z.string(), z.string()),
  index_versions: z.record(z.string(), z.string()),
  policy_rule_version: z.string().min(1),
  threshold_profile_id: z.string().min(1),
  planner_version: z.string().min(1),
  feature_flags: z.record(z.string(), z.boolean()),
  response_contract_version: z.literal('search_response_v1'),
  nondeterminism_notes: z.string().optional(),
}).strict();
