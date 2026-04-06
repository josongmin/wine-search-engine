/**
 * Stable field set for search execution logs / metrics / traces (Wave 3).
 * Keep in sync with HTTP response meta and engine decision.
 */
export interface SearchLogSchema {
  authority_trace_ref?: string;
  runtime_correlation_ref?: string;
  snapshot_id?: string;
  execution_mode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  degradation_reasons?: readonly string[];
  route_name?: string;
  model_versions?: Record<string, string>;
  kill_switch_state?: Record<string, boolean>;
}
