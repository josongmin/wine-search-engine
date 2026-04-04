/**
 * A snapshot of system versions and configuration active at the time a decision was made,
 * per RFC-015. This enables exact reproducibility analysis and regression triage.
 */
export interface DecisionSnapshot {
  /** Version identifiers for each ML model involved (e.g. { embedding: "bge-m3-v1.2" }). */
  readonly model_versions: Readonly<Record<string, string>>;

  /** Version identifiers for each search index (e.g. { wine_content: "2026-04-01" }). */
  readonly index_versions: Readonly<Record<string, string>>;

  /** Version of the policy rule set applied during resolution. */
  readonly policy_rule_version: string;

  /** Identifier of the threshold profile used for scoring decisions. */
  readonly threshold_profile_id: string;

  /** Version of the query planner that orchestrated the pipeline. */
  readonly planner_version: string;

  /** Feature flags (including kill switches) active at decision time. */
  readonly feature_flags: Readonly<Record<string, boolean>>;

  /** Optional notes on sources of nondeterminism (e.g. "embedding service jitter observed"). */
  readonly nondeterminism_notes?: string;
}
