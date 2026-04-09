/**
 * Sentinel value used as the snapshot_id when JSONB validation fails in
 * pg-feedback-store. Downstream code MUST check for this before using
 * a DecisionSnapshot read from the database.
 */
export const CORRUPTED_SNAPSHOT_ID = '__corrupted__' as const;

/**
 * Runtime type guard: returns `true` when the snapshot was produced by the
 * JSONB-validation fallback path (all fields set to `__corrupted__`).
 *
 * Accepts `unknown` so callers can guard before narrowing.
 */
export function isCorruptedSnapshot(snapshot: unknown): boolean {
  return (
    typeof snapshot === 'object'
    && snapshot !== null
    && 'snapshot_id' in snapshot
    && (snapshot as Readonly<Record<string, unknown>>).snapshot_id === CORRUPTED_SNAPSHOT_ID
  );
}

/**
 * A snapshot of system versions and configuration active at the time a decision was made,
 * per RFC-015. This enables exact reproducibility analysis and regression triage.
 */
export interface DecisionSnapshot {
  /** Stable snapshot identifier for cache/replay/audit comparisons. */
  readonly snapshot_id: string;
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
  /** Public response contract version emitted by the engine for this decision. */
  readonly response_contract_version: string;

  /** Optional notes on sources of nondeterminism (e.g. "embedding service jitter observed"). */
  readonly nondeterminism_notes?: string;
}
