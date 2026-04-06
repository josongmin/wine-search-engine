import { z } from 'zod';
import {
  DecisionSnapshotSchema,
} from './search-shared.schema.js';

export const ErrorResponseSchema = z.object({
  error: z.object({
    request_id: z.string(),
    code: z.string(),
    message: z.string(),
    failure_reason: z.string().nullable(),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export type ErrorResponseBody = z.infer<typeof ErrorResponseSchema>;

export const EvidenceItemSchema = z.object({
  type: z.string().min(1),
  source: z.string().min(1),
  contribution: z.string().min(1),
  strength: z.enum(['low', 'medium', 'high']),
  provenance: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
}).strict();

export const EntitySummarySchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  type: z.string().min(1),
  producer: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  appellation: z.string().min(1).optional(),
  producer_prestige: z.number().optional(),
  vintage: z.number().int().optional(),
  grapes: z.array(z.string().min(1)).optional(),
  price_range: z.string().min(1).optional(),
}).strict();

export const MatchDetailSchema = z.object({
  match_type: z.enum(['exact', 'alias_exact', 'alias_fuzzy', 'semantic', 'hybrid']),
  anchor_used: z.boolean().optional(),
  matched_alias: z.string().min(1).optional(),
  score_components: z.object({
    lexical: z.number(),
    semantic: z.number(),
    attribute: z.number(),
    popularity: z.number(),
    preference_alignment: z.number(),
  }).strict(),
}).strict();

export const ConstraintEvaluationSchema = z.object({
  matched: z.array(z.string()),
  unmet: z.array(z.string()),
  inferred: z.array(z.string()),
}).strict();

export const UncertaintyBlockSchema = z.object({
  uncertainty_confidence: z.number(),
  missing_info: z.array(z.string()),
  approximation_used: z.boolean(),
  ambiguity_flags: z.array(z.string()).optional(),
}).strict();

export const DrinkingWindowSchema = z.object({
  drinking_window_start: z.number().int(),
  drinking_window_end: z.number().int(),
  peak_year: z.number().int().optional(),
  currently_drinkable: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence_level: z.enum(['learned', 'heuristic']).optional(),
  blocking_eligible: z.boolean().optional(),
  model_version: z.string().min(1).optional(),
}).strict();

export const ResultItemSchema = z.object({
  entity: EntitySummarySchema,
  relevance_score: z.number(),
  match: MatchDetailSchema,
  constraints: ConstraintEvaluationSchema,
  uncertainty: UncertaintyBlockSchema,
  evidence_items: z.array(EvidenceItemSchema).min(1),
  human_readable_evidence_summary: z.string().min(1).optional(),
  drinking_window: DrinkingWindowSchema.optional(),
  match_reasons: z.array(z.string()).optional(),
  violated_constraints: z.array(z.string()).optional(),
}).strict();

export const ClarificationCandidateSchema = z.object({
  entity_id: z.string().min(1),
  label: z.string().min(1),
  distinguishing_features: z.array(z.string()),
}).strict();

export const ClarificationPayloadSchema = z.object({
  reason: z.string().min(1),
  candidates: z.array(ClarificationCandidateSchema),
  suggestion_type: z.enum(['disambiguation', 'missing_info']),
}).strict();

export const CounterfactualRejectSchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1).optional(),
  rejected_reason: z.string().min(1),
  evidence_ref: z.string().min(1).optional(),
}).strict();

export const EngineDecisionSchema = z.object({
  decision_status: z.enum(['resolved', 'ambiguous', 'failed']),
  next_action: z.enum(['return_result', 'clarify', 'hybrid_search', 'fail']),
  route: z.string().min(1),
  decision_confidence: z.number().min(0).max(1),
  confidence_semantics: z.literal('calibrated_decision_confidence'),
  decision_trace_ref: z
    .string()
    .min(1)
    .describe('Deprecated in favor of authority_trace_ref; kept for Phase A migration'),
  authority_trace_ref: z.string().min(1).optional(),
  runtime_correlation_ref: z.string().min(1).optional(),
  execution_mode: z
    .enum(['authoritative', 'degraded', 'heuristic', 'advisory'])
    .optional(),
  blocking_eligible: z.boolean().optional(),
  degradation_reasons: z.array(z.string()).optional(),
  decision_snapshot: DecisionSnapshotSchema,
  failure_reason: z.string().optional(),
  admission_trace_ref: z.string().optional(),
  abstain_reason: z.string().optional(),
  retrieval_mode_source: z.enum(['planner', 'api_override']).optional(),
  planner_suggested_mode: z.string().min(1).optional(),
}).strict();

export const ParsedConstraintsExternSchema = z.object({
  hard: z.array(z.object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.string(),
  }).strict()),
  soft: z.array(z.object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.string(),
  }).strict()),
  unparsed: z.array(z.string()),
}).strict();

export const SearchResponseMetaSchema = z.object({
  request_id: z.string().min(1).optional(),
  query_time_ms: z.number().min(0),
  route: z.string().min(1),
  version: z.string().min(1),
  engine_schema_version: z.literal('search_response_v1'),
  decision_snapshot: DecisionSnapshotSchema.optional(),
  debug_refs: z.array(z.string()).optional(),
  response_hash: z.string().min(1).optional(),
  authority_trace_ref: z.string().min(1).optional(),
  runtime_correlation_ref: z.string().min(1).optional(),
  execution_mode: z
    .enum(['authoritative', 'degraded', 'heuristic', 'advisory'])
    .optional(),
  blocking_eligible: z.boolean().optional(),
  degradation_reasons: z.array(z.string()).optional(),
  specialized_route_requested: z
    .enum(['producer_browse', 'region_browse', 'compare_candidates'])
    .nullable()
    .optional(),
  specialized_route_executed: z
    .enum(['producer_browse', 'region_browse', 'compare_candidates'])
    .nullable()
    .optional(),
  fallback_applied: z.boolean().optional(),
  fallback_reason: z
    .enum([
      'producer_browse_unavailable',
      'producer_browse_fallback',
      'region_browse_unavailable',
      'region_browse_fallback',
      'compare_retriever_unavailable',
      'compare_anchor_resolution_failed',
      'compare_candidates_fallback',
    ])
    .nullable()
    .optional(),
  retrieval_provenance_slices: z.array(z.object({
    query_id: z.string().min(1),
    candidate_entity_id: z.string().min(1),
    channels: z.array(z.string().min(1)),
    top_channel: z.string().min(1),
    anchor_conditioned: z.boolean(),
    protected: z.boolean(),
    protected_reason: z.string().min(1).optional(),
    fusion_score: z.number(),
    rank: z.number().int().positive(),
  }).strict()).optional(),
}).strict();

export const SearchResponseSchema = z.object({
  query_type: z.literal('search'),
  engine_decision: EngineDecisionSchema,
  results: z.array(ResultItemSchema),
  counterfactuals: z.array(CounterfactualRejectSchema).optional(),
  clarification: ClarificationPayloadSchema.nullable().optional(),
  meta: SearchResponseMetaSchema,
  retrieval_mode: z.enum([
    'entity_lookup',
    'attribute_search',
    'similar_items',
    'entity_resolution',
    'constraint_filter',
    'producer_browse',
    'region_browse',
    'compare_candidates',
    'recommendation',
    'no_match_detection',
  ]).optional(),
  result_type: z.enum([
    'single_entity',
    'entity_set',
    'comparison',
    'no_match',
    'producer_set',
    'region_set',
    'style_set',
    'wine_set',
  ]).optional(),
  parsed_constraints: ParsedConstraintsExternSchema.optional(),
}).strict();

export type SearchResponseBody = z.infer<typeof SearchResponseSchema>;

export const ComparisonEntitySchema = z.object({
  sub_query: z.string().min(1),
  top_result: ResultItemSchema.nullable(),
  result_count: z.number().int().nonnegative(),
  resolution_status: z.enum(['resolved', 'ambiguous', 'failed']),
  all_results: z.array(ResultItemSchema),
}).strict();

export const ComparisonSearchResponseSchema = z.object({
  query_type: z.literal('comparison'),
  original_query: z.string().min(1),
  comparison_intent: z.enum(['compare', 'recommend_one', 'list_both']),
  entities: z.tuple([ComparisonEntitySchema, ComparisonEntitySchema]),
  overall_status: z.enum(['resolved', 'ambiguous', 'failed']),
  request_id: z.string().min(1),
  execution_time_ms: z.number().min(0),
}).strict();

export type ComparisonSearchResponseBody = z.infer<typeof ComparisonSearchResponseSchema>;

const NormalizedQueryViewsSchema = z.object({
  raw: z.string().min(1),
  strict: z.string().min(1),
  accentless: z.string().min(1),
  collapsed_whitespace: z.string().min(1),
  punctuation_stripped: z.string().min(1),
  compact: z.string().min(1),
  phonetic_normalized: z.string().min(1).optional(),
  phonetic_compact: z.string().min(1).optional(),
  vintage_canonicalized: z.string().min(1),
  vintage_stripped: z.string().min(1),
  transliterated: z.string().min(1).optional(),
  reordered: z.array(z.string().min(1)).optional(),
  lookup_variants: z.array(z.string().min(1)),
}).strict();

const SessionContextTransportSchema = z.object({
  session_id: z.string().min(1),
  previous_entities: z.array(z.string().max(256)).max(50),
}).strict();

const QueryBudgetTransportSchema = z.object({
  max_latency_ms: z.number().int().positive(),
  max_candidates: z.number().int().positive(),
  rerank_limit: z.number().int().positive(),
}).strict();

export const InterpretResponseSchema = z.object({
  raw_query: z.string().min(1),
  normalized_query: z.string().min(1),
  normalized_query_views: NormalizedQueryViewsSchema.optional(),
  intent: z.string().min(1),
  secondary_intents: z.array(z.string().min(1)).optional(),
  route: z.enum(['entity', 'hybrid', 'mixed']),
  retrieval_mode: z.string().min(1),
  query_class: z.string().min(1),
  anchors: z.array(z.unknown()),
  constraints: z.object({
    hard: z.array(z.unknown()),
    soft: z.array(z.unknown()),
    inferred: z.array(z.unknown()),
  }).strict(),
  expansions: z.object({
    lexical: z.array(z.string()),
    semantic: z.array(z.string()),
  }).strict(),
  policy: z.record(z.unknown()),
  uncertainty: z.record(z.unknown()),
  planner_version: z.string().min(1),
  policy_rule_version: z.string().min(1),
  threshold_profile_id: z.string().min(1),
  admission_context: z.object({
    requires_identity_seal: z.boolean(),
    requires_constraint_evidence: z.boolean(),
    requires_anchor_evidence: z.boolean(),
  }).strict().optional(),
  session_context: SessionContextTransportSchema.optional(),
  query_budget: QueryBudgetTransportSchema.optional(),
  target_entity_type: z.string().min(1).optional(),
}).strict();

export type InterpretResponseBody = z.infer<typeof InterpretResponseSchema>;

export const ResolveCandidateSchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  rank: z.number().int().positive(),
  calibrated_score: z.number().min(0).max(1),
  match_reasons: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

export const ResolveTopEntitySchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  calibrated_score: z.number().min(0).max(1),
}).strict();

export const ResolveResponseSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'failed']),
  candidates: z.array(ResolveCandidateSchema),
  top_entity: ResolveTopEntitySchema.optional(),
  decision_trace_ref: z.string().min(1),
  request_id: z.string().min(1).optional(),
}).strict();

export type ResolveResponseBody = z.infer<typeof ResolveResponseSchema>;
