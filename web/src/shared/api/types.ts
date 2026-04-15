// ─── API contract types (mirrors backend Zod schemas) ───

// ── Primitives ──

export type EntityId = string;
export type DecisionStatus = 'resolved' | 'ambiguous' | 'failed';
export type NextAction = 'return_result' | 'clarify' | 'hybrid_search' | 'fail';
export type EvidenceStrength = 'low' | 'medium' | 'high';
export type MatchType = 'exact' | 'alias_exact' | 'alias_fuzzy' | 'semantic' | 'hybrid';
export type DrinkingWindowConfidence = 'high' | 'medium' | 'low';
export type ExecutionMode = 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
export type QueryRoute = 'entity' | 'hybrid' | 'mixed';
export type RetrievalMode =
  | 'entity_lookup'
  | 'entity_resolution'
  | 'attribute_search'
  | 'constraint_filter'
  | 'producer_browse'
  | 'region_browse'
  | 'compare_candidates'
  | 'recommendation'
  | 'similar_items'
  | 'no_match_detection';
export type RetrievalModeSource = 'planner' | 'api_override';
export type SpecializedRoute = 'producer_browse' | 'region_browse' | 'compare_candidates';

export type ResultType =
  | 'single_entity'
  | 'entity_set'
  | 'comparison'
  | 'no_match'
  | 'producer_set'
  | 'region_set'
  | 'style_set'
  | 'wine_set';

export type FeedbackSignalType = 'click' | 'purchase' | 'dismiss';

export type WatchlistTriggerType =
  | 'new_vintage'
  | 'price_drop'
  | 'stock_available'
  | 'critic_score_above';

// ── Search Request ──

export interface SearchRequest {
  query: string;
  context?: { locale?: string; currency?: string };
  session_context?: {
    session_id: string;
    previous_entities?: readonly string[];
  };
  query_budget?: {
    max_latency_ms?: number;
    max_candidates?: number;
    rerank_limit?: number;
  };
  options?: {
    mode?: 'auto' | QueryRoute;
    explain?: boolean;
    clarification?: boolean;
  };
  retrieval_mode?: 'auto' | QueryRoute;
}

// ── Search Response ──

export interface SearchResponseV1 {
  query_type: 'search';
  engine_decision: EngineDecision;
  results: readonly ResultItem[];
  counterfactuals?: readonly CounterfactualReject[];
  clarification?: ClarificationPayload | null;
  meta: ResponseMeta;
  retrieval_mode?: RetrievalMode;
  result_type?: ResultType;
  parsed_constraints?: ParsedConstraints;
}

export interface ComparisonEntity {
  sub_query: string;
  top_result: ResultItem | null;
  result_count: number;
  resolution_status: DecisionStatus;
  all_results: readonly ResultItem[];
}

export interface ComparisonSearchResponse {
  query_type: 'comparison';
  original_query: string;
  comparison_intent: 'compare' | 'recommend_one' | 'list_both';
  entities: readonly [ComparisonEntity, ComparisonEntity];
  overall_status: DecisionStatus;
  request_id: string;
  execution_time_ms: number;
  authority_trace_ref?: string;
  runtime_correlation_ref?: string;
}

export type SearchResponse = SearchResponseV1 | ComparisonSearchResponse;

export interface EngineDecision {
  decision_status: DecisionStatus;
  next_action: NextAction;
  route: QueryRoute;
  decision_confidence: number;
  confidence_semantics: string;
  decision_trace_ref: string;
  authority_trace_ref?: string;
  execution_mode?: ExecutionMode;
  blocking_eligible?: boolean;
  degradation_reasons?: readonly string[];
  decision_snapshot: DecisionSnapshot;
  failure_reason?: string;
  abstain_reason?: string;
  retrieval_mode_source?: RetrievalModeSource;
  planner_suggested_mode?: RetrievalMode;
}

export interface DecisionSnapshot {
  model_versions: Record<string, string>;
  index_versions: Record<string, string>;
  policy_rule_version: string;
  threshold_profile_id: string;
  planner_version: string;
  feature_flags: Record<string, boolean>;
}

export interface ResultItem {
  entity: EntitySummary;
  relevance_score: number;
  match: MatchDetail;
  constraints: ConstraintEvaluation;
  uncertainty: UncertaintyBlock;
  evidence_items: readonly EvidenceItem[];
  human_readable_evidence_summary?: string;
  drinking_window?: DrinkingWindowBlock;
  match_reasons?: readonly string[];
  violated_constraints?: readonly string[];
}

export interface EntitySummary {
  entity_id: EntityId;
  canonical_label: string;
  type: string;
  producer?: string;
  region?: string;
  appellation?: string;
  producer_prestige?: number;
  vintage?: number;
  grapes?: readonly string[];
  price_range?: string;
}

export interface MatchDetail {
  match_type: MatchType;
  anchor_used?: boolean;
  matched_alias?: string;
  score_components: {
    lexical: number;
    semantic: number;
    attribute: number;
    popularity: number;
    preference_alignment?: number;
  };
}

export interface ConstraintEvaluation {
  matched: readonly string[];
  unmet: readonly string[];
  inferred: readonly string[];
}

export interface UncertaintyBlock {
  uncertainty_confidence?: number;
  missing_info: readonly string[];
  approximation_used: boolean;
  ambiguity_flags?: readonly string[];
}

export interface EvidenceItem {
  type: string;
  source: string;
  contribution: string;
  strength: EvidenceStrength;
  provenance: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DrinkingWindowBlock {
  drinking_window_start: number;
  drinking_window_end: number;
  peak_year?: number;
  currently_drinkable: boolean;
  confidence: DrinkingWindowConfidence;
  evidence_level?: 'learned' | 'heuristic';
  model_version?: string;
}

export interface ClarificationPayload {
  reason: string;
  candidates: readonly ClarificationCandidate[];
  suggestion_type: 'disambiguation' | 'missing_info';
}

export interface ClarificationCandidate {
  entity_id: EntityId;
  label: string;
  distinguishing_features: readonly string[];
}

export interface CounterfactualReject {
  entity_id: EntityId;
  canonical_label?: string;
  rejected_reason: string;
  evidence_ref?: string;
}

export interface ResponseMeta {
  request_id?: string;
  query_time_ms: number;
  route: QueryRoute;
  version: string;
  engine_schema_version: string;
  decision_snapshot?: DecisionSnapshot;
  execution_mode?: ExecutionMode;
  execution_contract?: {
    effective_retrieval_mode: RetrievalMode;
    retrieval_mode_source: RetrievalModeSource;
    planner_suggested_mode: RetrievalMode;
    retrieval_kind:
      | 'entity_lookup'
      | 'generic_hybrid'
      | 'specialized_hybrid'
      | 'mixed_similarity';
    sparse_executed: boolean;
    specialized_route_executed?: SpecializedRoute | null;
    used_compiled_execution: boolean;
    budget?: {
      max_candidates: number;
      enable_precision_rerank: boolean;
    };
    provenance_policy?: {
      require_identity_seal: boolean;
      require_constraint_evidence: boolean;
      require_anchor_evidence: boolean;
    };
    provenance_closure?: {
      policy: {
        require_identity_seal: boolean;
        require_constraint_evidence: boolean;
        require_anchor_evidence: boolean;
      };
      pre_rank: {
        candidate_count: number;
        identity_evidence_satisfied: boolean;
        constraint_evidence_satisfied: boolean;
        anchor_evidence_satisfied: boolean;
        matched_constraint_attributes: string[];
        unmet_constraint_attributes: string[];
        anchor_signal_types: string[];
      };
      post_rank: {
        candidate_count: number;
        identity_evidence_satisfied: boolean;
        constraint_evidence_satisfied: boolean;
        anchor_evidence_satisfied: boolean;
        matched_constraint_attributes: string[];
        unmet_constraint_attributes: string[];
        anchor_signal_types: string[];
      };
      missing: Array<'identity_evidence' | 'constraint_evidence' | 'anchor_evidence'>;
      satisfied: boolean;
    };
    admission_closure?: {
      required: {
        identity_seal: boolean;
        constraint_evidence: boolean;
        anchor_evidence: boolean;
      };
      satisfied: {
        identity_seal: boolean;
        constraint_evidence: boolean;
        anchor_evidence: boolean;
      };
      all_satisfied: boolean;
    };
  };
  provenance_trace?: {
    policy: {
      require_identity_seal: boolean;
      require_constraint_evidence: boolean;
      require_anchor_evidence: boolean;
    };
    observed: {
      top_entity_present: boolean;
      pre_rank: {
        candidate_count: number;
        identity_evidence_satisfied: boolean;
        constraint_evidence_satisfied: boolean;
        anchor_evidence_satisfied: boolean;
        matched_constraint_attributes: string[];
        unmet_constraint_attributes: string[];
        anchor_signal_types: string[];
      };
      post_rank: {
        candidate_count: number;
        identity_evidence_satisfied: boolean;
        constraint_evidence_satisfied: boolean;
        anchor_evidence_satisfied: boolean;
        matched_constraint_attributes: string[];
        unmet_constraint_attributes: string[];
        anchor_signal_types: string[];
      };
    };
    missing: Array<'identity_evidence' | 'constraint_evidence' | 'anchor_evidence'>;
    shortfalls: string[];
    gate_decisions: {
      admission:
        | 'admission_gate_passed'
        | 'admission_gate_rejected'
        | 'admission_gate_not_applicable';
      decision:
        | 'decision_gate_resolved'
        | 'decision_gate_ambiguous'
        | 'decision_gate_failed';
      decision_status: DecisionStatus;
      next_action: NextAction;
      failure_reason?: string;
    };
    admission_closure?: {
      required: {
        identity_seal: boolean;
        constraint_evidence: boolean;
        anchor_evidence: boolean;
      };
      satisfied: {
        identity_seal: boolean;
        constraint_evidence: boolean;
        anchor_evidence: boolean;
      };
      all_satisfied: boolean;
    };
  };
}

export interface ParsedConstraints {
  hard: readonly NormalizedConstraint[];
  soft: readonly NormalizedConstraint[];
  inferred: readonly NormalizedConstraint[];
}

export interface NormalizedConstraint {
  attribute: string;
  operator: string;
  value: string | number | { min: number; max: number } | readonly string[];
  source_phrase: string;
  confidence: number;
}

// ── Entity Resolve ──

export interface EntityResolveRequest {
  query: string;
  options?: { mode?: string };
}

export interface EntityResolveResponse {
  entity: EntitySummary;
  confidence: number;
  alternatives?: readonly EntitySummary[];
}

// ── Feedback ──

export interface FeedbackRequest {
  query: string;
  entity_id: string;
  signal_type: FeedbackSignalType;
  session_id: string;
}

export interface FeedbackResponse {
  signal_id: string;
  accepted: true;
}

// ── Watchlist ──

export interface WatchlistTrigger {
  type: WatchlistTriggerType;
  [key: string]: unknown;
}

export interface WatchlistEntry {
  watchlist_id: string;
  user_id: string;
  entity_id: string;
  trigger_conditions: readonly WatchlistTrigger[];
  callback_url: string;
  created_at: string;
  expires_at: string | null;
}

export interface WatchlistCreateRequest {
  entity_id: string;
  trigger_conditions: readonly WatchlistTrigger[];
  callback_url: string;
}

export interface WatchlistListResponse {
  entries: readonly WatchlistEntry[];
  total: number;
}

// ── Agent (POST /v1/agent) & benchmark lab (GET /v1/agent/benchmark-scenarios) ──

export interface AgentBenchmarkUiScenarioDto {
  id: number;
  tier: string;
  query: string;
  description: string;
  profile: 'quick';
}

export interface AgentBenchmarkScenariosResponse {
  scenarios: readonly AgentBenchmarkUiScenarioDto[];
}

export interface AgentToolCallDto {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentStepDto {
  index: number;
  thought: string;
  action?: AgentToolCallDto;
  observation?: string;
  actions?: readonly AgentToolCallDto[];
  observations?: readonly string[];
  answer?: string;
  duration_ms: number;
  token_count: { input: number; output: number };
}

export interface AgentExecuteResponse {
  query_type: 'agent';
  answer: string;
  steps: readonly AgentStepDto[];
  meta: {
    request_id: string;
    total_duration_ms: number;
    tool_call_count: number;
    termination_reason: string;
    fallback_applied: boolean;
    total_tokens: { input: number; output: number };
  };
}

export interface AgentExecuteRequest {
  query: string;
  options?: { max_steps?: number };
}
