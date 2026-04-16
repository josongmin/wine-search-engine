import { z } from 'zod';
import {
  DecisionSnapshotSchema,
} from './search-shared.schema.js';
import { DETERMINISM_FINGERPRINT_HEX_LENGTH } from '../../../domain/shared/utils/determinism-fingerprint.js';
import {
  MIN_PRODUCED_VINTAGE_YEAR,
  MAX_PRODUCED_VINTAGE_YEAR,
} from '../../../domain/shared/constants.js';
import {
  MAX_SOURCE_RECORD_REFS_PER_ENTITY,
  MAX_SOURCE_RECORD_RECORD_ID_CHARS,
  MAX_SOURCE_RECORD_SOURCE_SYSTEM_CHARS,
} from '../../../domain/entity/model/source-record-ref.js';
import { RETRIEVAL_MODES } from '../../../domain/query/model/retrieval-mode.js';
import { QUERY_ROUTES } from '../../../domain/query/model/query-route.js';
import { QUERY_CLASSES } from '../../../domain/shared/types/query-class.js';
import { NEXT_ACTIONS } from '../../../domain/shared/types/next-action.js';
import {
  AUTHORITY_TRACE_REF_SHA256_HEX_LENGTH,
  MAX_AUDIT_BLOCKER_SEED_ENTITY_IDS,
  MAX_AUDIT_CONSTRAINT_ATOMS,
  MAX_AUDIT_CONSTRAINT_RELATIONS,
  MAX_AUDIT_HARD_FILTER_DROP_LOG_ITEMS,
  MAX_AUDIT_PLANNER_POLICY_TRACE_ITEMS,
  MAX_AUDIT_POLICY_OUTCOMES,
  MAX_AUDIT_RANKING_TOP_N,
  MAX_AUDIT_RESOLVER_SOURCE_BREAKDOWN_ITEMS,
  MAX_AUDIT_SOURCE_BREAKDOWN_ENTITY_IDS,
  MAX_CLARIFICATION_CANDIDATES,
  MAX_ENTITY_SUMMARY_CERTIFICATIONS,
  MAX_ENTITY_SUMMARY_GRAPES,
  MAX_ENTITY_SUMMARY_OCCASIONS,
  MAX_ENTITY_SUMMARY_PAIRING_TAGS,
  MAX_ERROR_ENVELOPE_CODE_CHARS,
  MAX_ERROR_ENVELOPE_FAILURE_REASON_CHARS,
  MAX_ERROR_ENVELOPE_MESSAGE_CHARS,
  MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS,
  MAX_INTERPRET_SECONDARY_INTENTS,
  MAX_NORMALIZED_QUERY_VIEW_STRINGS,
  MAX_QUERY_BUDGET_CANDIDATES,
  MAX_QUERY_BUDGET_DENSE_CALLS,
  MAX_QUERY_BUDGET_LATENCY_MS,
  MAX_QUERY_BUDGET_RERANK_LIMIT,
  MAX_RESOLVE_CANDIDATES,
  MAX_SEARCH_CONSTRAINT_STRING_LIST,
  MAX_SEARCH_COUNTERFACTUALS,
  MAX_SEARCH_EVIDENCE_ITEMS_PER_RESULT,
  MAX_SEARCH_METADATA_OBJECT_KEYS,
  MAX_SEARCH_META_DEBUG_REFS,
  MAX_SEARCH_PARSED_UNPARSED_FRAGMENTS,
  MAX_SEARCH_RESULTS_PER_RESPONSE,
  MAX_SEARCH_RETRIEVAL_PROVENANCE_SLICES,
  MAX_SEARCH_SHORT_STRING_LIST,
  MAX_SEARCH_UNCERTAINTY_STRING_LIST,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
  MAX_RESOLVE_CANDIDATE_SOURCES_LIST,
  SEARCH_RELEVANCE_SCORE_ABS_MAX,
} from '../constants.js';

export const CANONICAL_AUTHORITY_TRACE_REF_PATTERN = new RegExp(
  `^(decision|admission):v1:[A-Za-z0-9_]+:[a-f0-9]{${String(AUTHORITY_TRACE_REF_SHA256_HEX_LENGTH)}}$`,
);

export const ErrorResponseSchema = z.object({
  error: z.object({
    request_id: z.string().min(1).max(MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS),
    code: z.string().min(1).max(MAX_ERROR_ENVELOPE_CODE_CHARS),
    message: z.string().max(MAX_ERROR_ENVELOPE_MESSAGE_CHARS),
    failure_reason: z.string().max(MAX_ERROR_ENVELOPE_FAILURE_REASON_CHARS).nullable(),
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
  metadata: z.record(z.string(), z.unknown()).refine(
    (obj) => Object.keys(obj).length <= MAX_SEARCH_METADATA_OBJECT_KEYS,
    'metadata must have at most 50 keys',
  ).optional(),
}).strict();

const SourceRecordRefWireSchema = z
  .object({
    source_system: z.string().min(1).max(MAX_SOURCE_RECORD_SOURCE_SYSTEM_CHARS),
    source_record_id: z.string().min(1).max(MAX_SOURCE_RECORD_RECORD_ID_CHARS),
  })
  .strict();

export const EntitySummarySchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  type: z.string().min(1),
  producer: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  appellation: z.string().min(1).optional(),
  producer_prestige: z.number().finite().optional(),
  vintage: z.number().int().optional(),
  grapes: z.array(z.string().min(1)).max(MAX_ENTITY_SUMMARY_GRAPES).optional(),
  price_range: z.string().min(1).optional(),
  // Extended sensory / classification fields (added in RFC-019 Phase 7).
  style: z.string().min(1).optional(),
  wine_type: z.string().min(1).optional(),
  classification: z.string().min(1).optional(),
  critic_score: z.number().finite().min(0).max(1).optional(),
  alcohol_pct: z.number().finite().min(0).optional(),
  certifications: z.array(z.string().min(1)).max(MAX_ENTITY_SUMMARY_CERTIFICATIONS).optional(),
  pairing_tags: z.array(z.string().min(1)).max(MAX_ENTITY_SUMMARY_PAIRING_TAGS).optional(),
  occasion: z.array(z.string().min(1)).max(MAX_ENTITY_SUMMARY_OCCASIONS).optional(),
  // Sensory attributes are stored as normalized 0–1 floats in the index.
  body: z.number().finite().min(0).max(1).optional(),
  tannin: z.number().finite().min(0).max(1).optional(),
  acidity: z.number().finite().min(0).max(1).optional(),
  sweetness: z.number().finite().min(0).max(1).optional(),
  source_record_refs: z
    .array(SourceRecordRefWireSchema)
    .max(MAX_SOURCE_RECORD_REFS_PER_ENTITY)
    .optional(),
}).strict();

export const MatchDetailSchema = z.object({
  match_type: z.enum(['exact', 'alias_exact', 'alias_fuzzy', 'semantic', 'hybrid']),
  anchor_used: z.boolean().optional(),
  matched_alias: z.string().min(1).optional(),
  score_components: z.object({
    lexical: z.number().finite(),
    semantic: z.number().finite(),
    attribute: z.number().finite(),
    popularity: z.number().finite(),
    preference_alignment: z.number().finite().optional(),
  }).strict(),
}).strict();

export const ConstraintEvaluationSchema = z.object({
  matched: z.array(z.string()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
  unmet: z.array(z.string()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
  inferred: z.array(z.string()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
}).strict();

export const UncertaintyBlockSchema = z.object({
  uncertainty_confidence: z.number().finite().min(0).max(1).optional(),
  missing_info: z.array(z.string()).max(MAX_SEARCH_UNCERTAINTY_STRING_LIST),
  approximation_used: z.boolean(),
  ambiguity_flags: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST).optional(),
}).strict();

export const DrinkingWindowSchema = z.object({
  drinking_window_start: z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  drinking_window_end: z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  peak_year: z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR).optional(),
  currently_drinkable: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence_level: z.enum(['learned', 'heuristic']).optional(),
  blocking_eligible: z.boolean().optional(),
  model_version: z.string().min(1).optional(),
}).strict().refine(
  (w) => w.drinking_window_start <= w.drinking_window_end,
  'drinking_window_start must be <= drinking_window_end',
);

export const ResultItemSchema = z.object({
  entity: EntitySummarySchema,
  // Bounded relevance: never NaN/Infinity, never absurd numbers that would
  // break percentile telemetry or float32 client-side ranking.
  relevance_score: z
    .number()
    .finite()
    .min(-SEARCH_RELEVANCE_SCORE_ABS_MAX)
    .max(SEARCH_RELEVANCE_SCORE_ABS_MAX),
  match: MatchDetailSchema,
  constraints: ConstraintEvaluationSchema,
  uncertainty: UncertaintyBlockSchema,
  evidence_items: z.array(EvidenceItemSchema).min(1).max(MAX_SEARCH_EVIDENCE_ITEMS_PER_RESULT),
  human_readable_evidence_summary: z.string().min(1).optional(),
  drinking_window: DrinkingWindowSchema.optional(),
  match_reasons: z.array(z.string()).max(MAX_SEARCH_UNCERTAINTY_STRING_LIST).optional(),
  violated_constraints: z.array(z.string()).max(MAX_SEARCH_UNCERTAINTY_STRING_LIST).optional(),
}).strict();

export const ClarificationCandidateSchema = z.object({
  entity_id: z.string().min(1),
  label: z.string().min(1),
  distinguishing_features: z.array(z.string()).max(MAX_CLARIFICATION_CANDIDATES),
}).strict();

export const ClarificationPayloadSchema = z.object({
  reason: z.string().min(1),
  candidates: z.array(ClarificationCandidateSchema).max(MAX_CLARIFICATION_CANDIDATES),
  suggestion_type: z.enum(['disambiguation', 'missing_info']),
  structured_payload: z.object({
    kind: z.enum([
      'anchor_disambiguation',
      'constraint_conflict',
      'preference_gap',
      'budget_gap',
    ]),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).max(MAX_CLARIFICATION_CANDIDATES).optional(),
    conflicting_atoms: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
    gap_description: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export const CounterfactualRejectSchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1).optional(),
  rejection_type: z.enum(['lower_calibrated_score', 'below_top_window', 'abstain_tied']),
  rejected_reason: z.string().min(1),
  evidence_ref: z.string().min(1).optional(),
}).strict();

export const EngineDecisionSchema = z.object({
  decision_status: z.enum(['resolved', 'ambiguous', 'failed']),
  next_action: z.enum(['return_result', 'clarify', 'hybrid_search', 'fail']),
  route: z.enum(QUERY_ROUTES),
  decision_confidence: z.number().finite().min(0).max(1),
  confidence_semantics: z.literal('calibrated_decision_confidence'),
  decision_trace_ref: z
    .string()
    .regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN)
    .describe('Deprecated in favor of authority_trace_ref; kept for Phase A migration'),
  authority_trace_ref: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN).optional(),
  runtime_correlation_ref: z.string().min(1).optional(),
  execution_mode: z
    .enum(['authoritative', 'degraded', 'heuristic', 'advisory'])
    .optional(),
  blocking_eligible: z.boolean().optional(),
  degradation_reasons: z.array(z.string().min(1)).max(MAX_SEARCH_SHORT_STRING_LIST).optional(),
  decision_snapshot: DecisionSnapshotSchema,
  failure_reason: z.string().min(1).optional(),
  admission_trace_ref: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN).optional(),
  abstain_reason: z.enum(['no_match', 'low_confidence', 'semantic_conflict', 'insufficient_evidence']).optional(),
  retrieval_mode_source: z.enum(['planner', 'api_override']).optional(),
  planner_suggested_mode: z.enum(RETRIEVAL_MODES).optional(),
}).strict();

export const ParsedConstraintsExternSchema = z.object({
  hard: z.array(z.object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.string(),
  }).strict()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
  soft: z.array(z.object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.string(),
  }).strict()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
  unparsed: z.array(z.string()).max(MAX_SEARCH_PARSED_UNPARSED_FRAGMENTS),
}).strict();

// ─── T-E5-01: AuditExtension typed surface ──────────────────────────────────
//
// Typed "enough" for client autocompletion and basic validation.
// All fields optional — audit fields are gated by explain/debug.
// .passthrough() on sub-objects tolerates future field additions.
// Complex/deeply-nested trace payloads stay z.unknown() to avoid fragile coupling.
//
// T-E5-03: Stable vs Debug boundary
//
// STABLE fields (always emitted when trigger condition is met — public contract):
//   - abstain_policy_trace
//   - fallback_trace
//   - hard_filter_drop_log
//   - corrective_retry_calibrated_confidence
//   - determinism_fingerprint
//
// DEBUG-ONLY fields (gated by explain=true or X-Debug-Key — shape may change):
//   - planner_policy_trace
//   - constraint_resolution_trace
//   - retrieval_fusion_trace
//   - ranking_delta_trace
//   - rerank_decision_trace
//   - execution_trace
//   - resolver_provenance_trace
//
// Only the top-level audit_extension envelope remains passthrough so future
// debug fields can be added without breaking consumers. Nested trace payloads
// are strict to keep the structured security boundary closed.

export const AuditExtensionSchema = z.object({
  /**
   * E3: Planner policy trace — one record per decision stage.
   * Opaque records: typed as unknown[] because PolicyDecisionRecord has
   * free-form inputFacts and open-ended stage values.
   *
   * @stability debug
   */
  planner_policy_trace: z.array(z.unknown()).max(MAX_AUDIT_PLANNER_POLICY_TRACE_ITEMS).optional(),

  /**
   * E2: Constraint resolution trace — atoms, relations, and outcomes.
   *
   * @stability debug
   */
  constraint_resolution_trace: z.object({
    atoms: z.array(z.unknown()).max(MAX_AUDIT_CONSTRAINT_ATOMS),
    relations: z.array(z.unknown()).max(MAX_AUDIT_CONSTRAINT_RELATIONS),
    policy_outcomes: z.array(z.object({
      atom_index: z.number().int(),
      outcome: z.enum(['kept', 'dropped', 'shadowed']),
      reason: z.string(),
    }).strict()).max(MAX_AUDIT_POLICY_OUTCOMES),
  }).strict().optional(),

  /**
   * E4: RRF fusion trace — per-query fusion parameters and candidate counts.
   * Complex nested structure; kept opaque.
   *
   * @stability debug
   */
  retrieval_fusion_trace: z.unknown().optional(),

  /**
   * E5: Ranking delta trace — pre/post rerank positions + Kendall tau drift.
   *
   * @stability debug
   */
  ranking_delta_trace: z.object({
    pre_rerank_top5: z.array(z.string()).max(MAX_AUDIT_RANKING_TOP_N),
    post_rerank_top5: z.array(z.string()).max(MAX_AUDIT_RANKING_TOP_N),
    safety_envelope_blocks: z.number().int(),
    protected_candidate_evictions: z.number().int().optional(),
    drift: z.unknown(),
  }).strict().optional(),

  /**
   * Rerank gate decision — was LTR applied, skipped, or blocked?
   *
   * @stability debug
   */
  rerank_decision_trace: z.object({
    gate_decision: z.enum([
      'applied',
      'no_model_for_query_class',
      'empty_candidates',
      'feature_dimension_mismatch',
      'gate_blocked',
      'normalization_failed',
    ]),
    applied_model: z.string().optional(),
    ltr_feature_dimension: z.number().int().optional(),
    score_contract: z.enum(['bounded_normalized_0_1']).optional(),
    blocked_reason_counts: z.record(z.string(), z.number().int()).optional(),
  }).strict().optional(),

  /**
   * E6: Abstain policy trace — always emitted when abstain occurs.
   *
   * @stability stable
   */
  abstain_policy_trace: z.object({
    evaluated: z.boolean(),
    decision: z.unknown(),
    top_k_entropy: z.number().finite().optional(),
    constraint_conflicts: z.array(z.unknown()).max(MAX_AUDIT_CONSTRAINT_RELATIONS).optional(),
    channel_degradation: z.object({
      dense_degraded: z.boolean(),
      anchor_degraded: z.boolean(),
      sparse_degraded: z.boolean(),
      sparse_zero_hits: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),

  /**
   * E4: Hard-filter dropout log — top-N candidates dropped by hard constraint filter.
   * CandidateDropRecord shape kept opaque per entry.
   *
   * @stability stable
   */
  hard_filter_drop_log: z.array(z.unknown()).max(MAX_AUDIT_HARD_FILTER_DROP_LOG_ITEMS).optional(),

  /**
   * Request-level execution contract facts (debug/explain traces).
   *
   * @stability debug
   */
  execution_trace: z.object({
    effective_route: z.enum(QUERY_ROUTES),
    retrieval_mode_source: z.enum(['planner', 'api_override']).optional(),
    effective_retrieval_mode: z.string().optional(),
    retrieval_kind: z.enum([
      'entity_lookup',
      'generic_hybrid',
      'specialized_hybrid',
      'mixed_similarity',
    ]).optional(),
    sparse_executed: z.boolean().optional(),
    specialized_route_executed: z.string().nullable().optional(),
    used_compiled_execution: z.boolean().optional(),
    compiled_budget: z.object({
      max_candidates: z.number().int(),
      enable_precision_rerank: z.boolean(),
    }).strict().optional(),
    provenance_policy: z.object({
      require_identity_seal: z.boolean(),
      require_constraint_evidence: z.boolean(),
      require_anchor_evidence: z.boolean(),
    }).strict().optional(),
    provenance_closure: z.unknown().optional(),
  }).strict().optional(),

  /**
   * Exact-recovery resolver provenance (noisy entity lookup audit).
   *
   * @stability debug
   */
  resolver_provenance_trace: z.object({
    candidate_source_breakdown: z.array(z.object({
      source: z.enum(['alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed']),
      entity_ids: z.array(z.string()).max(MAX_AUDIT_SOURCE_BREAKDOWN_ENTITY_IDS),
      count: z.number().int(),
    }).strict()).max(MAX_AUDIT_RESOLVER_SOURCE_BREAKDOWN_ITEMS).optional(),
    blocker_seed_entity_ids: z.array(z.string()).max(MAX_AUDIT_BLOCKER_SEED_ENTITY_IDS).optional(),
    blocker_seed_count: z.number().int().optional(),
  }).strict().optional(),

  /**
   * TA5: Calibrated posterior confidence from corrective retry.
   *
   * @stability stable
   */
  corrective_retry_calibrated_confidence: z.number().finite().optional(),

  /**
   * Agent fallback trace — always emitted when agent fallback occurs.
   *
   * @stability stable
   */
  fallback_trace: z.object({
    fallback_applied: z.enum(['layer2', 'layer3', 'layer4']).nullable(),
    reasoning_failure: z.boolean(),
    failed_synthesis_attempts: z.number().int(),
    fallback_search_used: z.boolean(),
  }).strict().optional(),

  /**
   * E1-T5: Determinism fingerprint — normally in meta, but can appear here too.
   *
   * @stability stable
   */
  determinism_fingerprint: z.string().optional(),
}).passthrough();

export type AuditExtensionWire = z.infer<typeof AuditExtensionSchema>;

/**
 * T-E5-03: Audit extension field keys classified by stability boundary.
 *
 * STABLE fields are always emitted when their trigger condition is met.
 * Clients MAY depend on their presence and shape.
 *
 * DEBUG fields are gated by explain=true or X-Debug-Key header.
 * Clients MUST NOT depend on their presence in production responses.
 */
export const AUDIT_EXTENSION_STABLE_FIELDS = [
  'abstain_policy_trace',
  'fallback_trace',
  'hard_filter_drop_log',
  'corrective_retry_calibrated_confidence',
  'determinism_fingerprint',
] as const satisfies readonly (keyof AuditExtensionWire)[];

export const AUDIT_EXTENSION_DEBUG_FIELDS = [
  'planner_policy_trace',
  'constraint_resolution_trace',
  'retrieval_fusion_trace',
  'ranking_delta_trace',
  'rerank_decision_trace',
  'execution_trace',
  'resolver_provenance_trace',
] as const satisfies readonly (keyof AuditExtensionWire)[];

export const SearchResponseMetaSchema = z.object({
  request_id: z.string().min(1).optional(),
  query_time_ms: z.number().finite().min(0),
  route: z.enum(QUERY_ROUTES),
  version: z.string().min(1),
  engine_schema_version: z.literal('search_response_v1'),
  decision_snapshot: DecisionSnapshotSchema.optional(),
  debug_refs: z.array(z.string()).max(MAX_SEARCH_META_DEBUG_REFS).optional(),
  response_hash: z.string().min(1).optional(),
  /**
   * E1-T5: Determinism fingerprint — 16-char hex digest of engine configuration
   * (planner version, model ID, fusion config, ranking config). Two responses
   * with identical fingerprints were produced by the same engine configuration.
   * Populated on every response. Distinct from response_hash (which hashes
   * result content) — the fingerprint hashes configuration, not output.
   */
  determinism_fingerprint: z.string().length(DETERMINISM_FINGERPRINT_HEX_LENGTH).optional(),
  authority_trace_ref: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN).optional(),
  runtime_correlation_ref: z.string().min(1).optional(),
  execution_mode: z
    .enum(['authoritative', 'degraded', 'heuristic', 'advisory'])
    .optional(),
  blocking_eligible: z.boolean().optional(),
  degradation_reasons: z.array(z.string().min(1)).max(MAX_SEARCH_SHORT_STRING_LIST).optional(),
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
  execution_contract: z.object({
    effective_retrieval_mode: z.enum(RETRIEVAL_MODES),
    retrieval_mode_source: z.enum(['planner', 'api_override']),
    planner_suggested_mode: z.enum(RETRIEVAL_MODES),
    retrieval_kind: z.enum([
      'entity_lookup',
      'generic_hybrid',
      'specialized_hybrid',
      'mixed_similarity',
    ]),
    sparse_executed: z.boolean(),
    specialized_route_executed: z
      .enum(['producer_browse', 'region_browse', 'compare_candidates'])
      .nullable()
      .optional(),
    used_compiled_execution: z.boolean(),
    budget: z.object({
      max_candidates: z.number().int().nonnegative().max(MAX_QUERY_BUDGET_CANDIDATES),
      enable_precision_rerank: z.boolean(),
    }).strict().optional(),
    provenance_policy: z.object({
      require_identity_seal: z.boolean(),
      require_constraint_evidence: z.boolean(),
      require_anchor_evidence: z.boolean(),
    }).strict().optional(),
    provenance_closure: z.object({
      policy: z.object({
        require_identity_seal: z.boolean(),
        require_constraint_evidence: z.boolean(),
        require_anchor_evidence: z.boolean(),
      }).strict(),
      pre_rank: z.object({
        candidate_count: z.number().int().nonnegative(),
        identity_evidence_satisfied: z.boolean(),
        constraint_evidence_satisfied: z.boolean(),
        anchor_evidence_satisfied: z.boolean(),
        matched_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        unmet_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        anchor_signal_types: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
      }).strict(),
      post_rank: z.object({
        candidate_count: z.number().int().nonnegative(),
        identity_evidence_satisfied: z.boolean(),
        constraint_evidence_satisfied: z.boolean(),
        anchor_evidence_satisfied: z.boolean(),
        matched_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        unmet_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        anchor_signal_types: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
      }).strict(),
      missing: z.array(z.enum([
        'identity_evidence',
        'constraint_evidence',
        'anchor_evidence',
      ])).max(3),
      satisfied: z.boolean(),
    }).strict().optional(),
    admission_closure: z.object({
      required: z.object({
        identity_seal: z.boolean(),
        constraint_evidence: z.boolean(),
        anchor_evidence: z.boolean(),
      }).strict(),
      satisfied: z.object({
        identity_seal: z.boolean(),
        constraint_evidence: z.boolean(),
        anchor_evidence: z.boolean(),
      }).strict(),
      all_satisfied: z.boolean(),
    }).strict().optional(),
  }).strict().optional(),
  provenance_trace: z.object({
    policy: z.object({
      require_identity_seal: z.boolean(),
      require_constraint_evidence: z.boolean(),
      require_anchor_evidence: z.boolean(),
    }).strict(),
    observed: z.object({
      top_entity_present: z.boolean(),
      pre_rank: z.object({
        candidate_count: z.number().int().nonnegative(),
        identity_evidence_satisfied: z.boolean(),
        constraint_evidence_satisfied: z.boolean(),
        anchor_evidence_satisfied: z.boolean(),
        matched_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        unmet_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        anchor_signal_types: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
      }).strict(),
      post_rank: z.object({
        candidate_count: z.number().int().nonnegative(),
        identity_evidence_satisfied: z.boolean(),
        constraint_evidence_satisfied: z.boolean(),
        anchor_evidence_satisfied: z.boolean(),
        matched_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        unmet_constraint_attributes: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
        anchor_signal_types: z.array(z.string()).max(MAX_SEARCH_SHORT_STRING_LIST),
      }).strict(),
    }).strict(),
    missing: z.array(z.enum([
      'identity_evidence',
      'constraint_evidence',
      'anchor_evidence',
    ])).max(3),
    shortfalls: z.array(z.string().min(1)).max(MAX_SEARCH_SHORT_STRING_LIST),
    gate_decisions: z.object({
      admission: z.enum([
        'admission_gate_passed',
        'admission_gate_rejected',
        'admission_gate_not_applicable',
      ]),
      decision: z.enum([
        'decision_gate_resolved',
        'decision_gate_ambiguous',
        'decision_gate_failed',
      ]),
      decision_status: z.enum(['resolved', 'ambiguous', 'failed']),
      next_action: z.enum(NEXT_ACTIONS),
      failure_reason: z.string().min(1).optional(),
    }).strict(),
    admission_closure: z.object({
      required: z.object({
        identity_seal: z.boolean(),
        constraint_evidence: z.boolean(),
        anchor_evidence: z.boolean(),
      }).strict(),
      satisfied: z.object({
        identity_seal: z.boolean(),
        constraint_evidence: z.boolean(),
        anchor_evidence: z.boolean(),
      }).strict(),
      all_satisfied: z.boolean(),
    }).strict().optional(),
  }).strict().optional(),
  retrieval_provenance_slices: z.array(z.object({
    query_id: z.string().min(1),
    candidate_entity_id: z.string().min(1),
    channels: z.array(z.string().min(1)).max(MAX_SEARCH_SHORT_STRING_LIST),
    top_channel: z.string().min(1),
    anchor_conditioned: z.boolean(),
    protected: z.boolean(),
    protected_reason: z.string().min(1).optional(),
    fusion_score: z.number().finite(),
    rank: z.number().int().positive(),
  }).strict()).max(MAX_SEARCH_RETRIEVAL_PROVENANCE_SLICES).optional(),
  /**
   * E8: Audit extension — structured trace payloads from EPIC-3 through EPIC-7.
   *
   * T-E5-01: Upgraded from z.unknown() to AuditExtensionSchema.
   * The schema uses .passthrough() extensively so future field additions
   * do not break existing clients. Complex nested traces (fusion, drift,
   * abstain decision) remain z.unknown() to avoid fragile coupling.
   *
   * Gating: fields within the envelope are populated per the field gating policy
   * in AuditExtension (explain=true / debug header / always-on for abstain+fallback).
   */
  audit_extension: AuditExtensionSchema.optional(),
}).strict();

export const SearchResponseSchema = z.object({
  query_type: z.literal('search'),
  engine_decision: EngineDecisionSchema,
  // Hard cap on response size: ranking pipeline already truncates, but
  // a defense-in-depth bound keeps an out-of-control producer from
  // shipping 100k items into a single HTTP response.
  results: z.array(ResultItemSchema).max(MAX_SEARCH_RESULTS_PER_RESPONSE),
  counterfactuals: z.array(CounterfactualRejectSchema).max(MAX_SEARCH_COUNTERFACTUALS).optional(),
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
}).strict().superRefine((value, ctx) => {
  const expectedAuthorityTraceRef =
    value.engine_decision.authority_trace_ref ?? value.engine_decision.decision_trace_ref;

  if (
    value.engine_decision.authority_trace_ref !== undefined
    && value.engine_decision.authority_trace_ref !== value.engine_decision.decision_trace_ref
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'engine_decision.authority_trace_ref must equal engine_decision.decision_trace_ref',
      path: ['engine_decision', 'authority_trace_ref'],
    });
  }

  if (
    value.meta.authority_trace_ref !== undefined
    && value.meta.authority_trace_ref !== expectedAuthorityTraceRef
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'meta.authority_trace_ref must match engine authority trace',
      path: ['meta', 'authority_trace_ref'],
    });
  }

  if (
    value.engine_decision.runtime_correlation_ref !== undefined
    && value.meta.runtime_correlation_ref !== undefined
    && value.engine_decision.runtime_correlation_ref !== value.meta.runtime_correlation_ref
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'meta.runtime_correlation_ref must match engine_decision.runtime_correlation_ref',
      path: ['meta', 'runtime_correlation_ref'],
    });
  }

  const expectedRuntimeCorrelationRef =
    value.engine_decision.runtime_correlation_ref ?? value.meta.runtime_correlation_ref;
  if (
    value.meta.request_id !== undefined
    && expectedRuntimeCorrelationRef !== undefined
    && value.meta.request_id !== expectedRuntimeCorrelationRef
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'meta.request_id must match runtime correlation reference',
      path: ['meta', 'request_id'],
    });
  }
});

export type SearchResponseBody = z.infer<typeof SearchResponseSchema>;

export const ComparisonEntitySchema = z.object({
  sub_query: z.string().min(1),
  top_result: ResultItemSchema.nullable(),
  result_count: z.number().int().nonnegative(),
  resolution_status: z.enum(['resolved', 'ambiguous', 'failed']),
  all_results: z.array(ResultItemSchema).max(MAX_SEARCH_RESULTS_PER_RESPONSE),
}).strict();

export const ComparisonSearchResponseSchema = z.object({
  query_type: z.literal('comparison'),
  original_query: z.string().min(1),
  comparison_intent: z.enum(['compare', 'recommend_one', 'list_both']),
  entities: z.tuple([ComparisonEntitySchema, ComparisonEntitySchema]),
  overall_status: z.enum(['resolved', 'ambiguous', 'failed']),
  request_id: z.string().min(1),
  authority_trace_ref: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN).optional(),
  runtime_correlation_ref: z.string().min(1).optional(),
  execution_time_ms: z.number().finite().min(0),
}).strict().superRefine((value, ctx) => {
  if (
    value.runtime_correlation_ref !== undefined
    && value.runtime_correlation_ref !== value.request_id
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime_correlation_ref must equal request_id on comparison responses',
      path: ['runtime_correlation_ref'],
    });
  }
});

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
  reordered: z.array(z.string().min(1)).max(MAX_NORMALIZED_QUERY_VIEW_STRINGS).optional(),
  lookup_variants: z.array(z.string().min(1)).max(MAX_NORMALIZED_QUERY_VIEW_STRINGS),
}).strict();

const SessionContextTransportSchema = z.object({
  session_id: z.string().min(1),
  previous_entities: z
    .array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS))
    .max(MAX_SESSION_PREVIOUS_ENTITIES),
}).strict();

const QueryBudgetTransportSchema = z.object({
  max_latency_ms: z.number().int().positive().max(MAX_QUERY_BUDGET_LATENCY_MS),
  max_candidates: z.number().int().positive().max(MAX_QUERY_BUDGET_CANDIDATES),
  rerank_limit: z.number().int().positive().max(MAX_QUERY_BUDGET_RERANK_LIMIT),
  max_dense_calls: z.number().int().positive().max(MAX_QUERY_BUDGET_DENSE_CALLS).optional(),
}).strict();

export const InterpretResponseSchema = z.object({
  raw_query: z.string().min(1),
  normalized_query: z.string().min(1),
  normalized_query_views: NormalizedQueryViewsSchema.optional(),
  intent: z.string().min(1),
  secondary_intents: z.array(z.string().min(1)).max(MAX_INTERPRET_SECONDARY_INTENTS).optional(),
  route: z.enum(['entity', 'hybrid', 'mixed']),
  retrieval_mode: z.enum(RETRIEVAL_MODES),
  query_class: z.enum(QUERY_CLASSES),
  anchors: z.array(z.record(z.unknown())).max(MAX_NORMALIZED_QUERY_VIEW_STRINGS),
  constraints: z.object({
    hard: z.array(z.record(z.unknown())).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
    soft: z.array(z.record(z.unknown())).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
    inferred: z.array(z.record(z.unknown())).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
  }).strict(),
  expansions: z.object({
    lexical: z.array(z.string()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
    semantic: z.array(z.string()).max(MAX_SEARCH_CONSTRAINT_STRING_LIST),
  }).strict(),
  policy: z.record(z.unknown()).refine(
    (rec) => Object.keys(rec).length <= MAX_SEARCH_METADATA_OBJECT_KEYS,
    { message: `policy must not exceed ${String(MAX_SEARCH_METADATA_OBJECT_KEYS)} keys` },
  ),
  uncertainty: z.record(z.unknown()).refine(
    (rec) => Object.keys(rec).length <= MAX_SEARCH_METADATA_OBJECT_KEYS,
    { message: `uncertainty must not exceed ${String(MAX_SEARCH_METADATA_OBJECT_KEYS)} keys` },
  ),
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

const ResolveCandidateTraceSchema = z.object({
  score: z.number().finite(),
  calibrated_confidence: z.number().finite().min(0).max(1),
  boundary_decision: z.enum(['singleton', 'admitted', 'rejected']),
  admission_gate_reason: z.string().min(1).optional(),
  match_source: z.enum(['alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed']),
}).strict();

export const ResolveCandidateSchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  rank: z.number().int().positive(),
  calibrated_score: z.number().finite().min(0).max(1),
  source: z.enum(['alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed']).optional(),
  sources: z
    .array(z.enum(['alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed']))
    .max(MAX_RESOLVE_CANDIDATE_SOURCES_LIST)
    .optional(),
  blocker_seed: z.literal(true).optional(),
  evidence_refs: z.array(z.string().min(1)).max(MAX_SEARCH_META_DEBUG_REFS).optional(),
  match_reasons: z.array(z.string()).max(MAX_SEARCH_UNCERTAINTY_STRING_LIST).optional(),
  metadata: z.record(z.string(), z.unknown()).refine(
    (obj) => Object.keys(obj).length <= MAX_SEARCH_METADATA_OBJECT_KEYS,
    'metadata must have at most 50 keys',
  ).optional(),
  trace: ResolveCandidateTraceSchema.optional(),
}).strict();

export const ResolveTopEntitySchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  calibrated_score: z.number().finite().min(0).max(1),
}).strict();

export const ResolveResponseSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'failed']),
  candidates: z.array(ResolveCandidateSchema).max(MAX_RESOLVE_CANDIDATES),
  top_entity: ResolveTopEntitySchema.optional(),
  decision_trace_ref: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN),
  authority_trace_ref: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN),
  request_id: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authority_trace_ref !== value.decision_trace_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'authority_trace_ref must equal decision_trace_ref on resolve responses',
      path: ['authority_trace_ref'],
    });
  }
});

export type ResolveResponseBody = z.infer<typeof ResolveResponseSchema>;
