// ─── API contract types (mirrors backend Zod schemas) ───

// ── Primitives ──

export type EntityId = string;
export type DecisionStatus = 'resolved' | 'ambiguous' | 'failed';
export type NextAction = 'return_result' | 'clarify' | 'hybrid_search' | 'fail';
export type EvidenceStrength = 'low' | 'medium' | 'high';
export type MatchType = 'exact' | 'alias_exact' | 'alias_fuzzy' | 'semantic' | 'hybrid';
export type DrinkingWindowConfidence = 'high' | 'medium' | 'low';
export type ExecutionMode = 'authoritative' | 'degraded' | 'heuristic' | 'advisory';

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
    mode?: 'auto' | 'entity' | 'hybrid' | 'mixed';
    explain?: boolean;
    clarification?: boolean;
  };
  retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed';
}

// ── Search Response ──

export interface SearchResponse {
  query_type: 'search';
  engine_decision: EngineDecision;
  results: readonly ResultItem[];
  counterfactuals?: readonly CounterfactualReject[];
  clarification?: ClarificationPayload | null;
  meta: ResponseMeta;
  retrieval_mode?: string;
  result_type?: ResultType;
  parsed_constraints?: ParsedConstraints;
}

export interface EngineDecision {
  decision_status: DecisionStatus;
  next_action: NextAction;
  route: string;
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
  retrieval_mode_source?: 'planner' | 'api_override';
  planner_suggested_mode?: string;
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
    preference_alignment: number;
  };
}

export interface ConstraintEvaluation {
  matched: readonly string[];
  unmet: readonly string[];
  inferred: readonly string[];
}

export interface UncertaintyBlock {
  uncertainty_confidence: number;
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
  route: string;
  version: string;
  engine_schema_version: string;
  decision_snapshot?: DecisionSnapshot;
  execution_mode?: ExecutionMode;
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
