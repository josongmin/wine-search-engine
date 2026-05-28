/**
 * Stable field set for search execution logs / metrics / traces (Wave 3).
 * Keep in sync with HTTP response meta and engine decision.
 */
import type { QueryObservabilitySlice } from '../query/model/query-observability-vocab.js';
import type {
  SpecializedRouteName,
  SpecializedFallbackReason,
} from '../response/model/specialized-route.js';

export interface SearchLogSchema {
  authority_trace_ref?: string;
  authority_trace_schema_version?: string;
  invalid_authority_trace_ref_reason?: string;
  runtime_correlation_ref?: string;
  snapshot_id?: string;
  snapshot_schema_version?: string;
  invalid_snapshot_id_reason?: string;
  execution_mode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  blocking_eligible?: boolean;
  degradation_reasons?: readonly string[];
  route_name?: string;
  specialized_route_requested?: SpecializedRouteName | null;
  specialized_route_executed?: SpecializedRouteName | null;
  fallback_applied?: boolean;
  fallback_reason?: SpecializedFallbackReason | null;
  model_versions?: Record<string, string>;
  kill_switch_state?: Record<string, boolean>;
  query_observability?: QueryObservabilitySlice;
  executed_query_observability?: QueryObservabilitySlice;
  decomposition_strategy?: string;
}
