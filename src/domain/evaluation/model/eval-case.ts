import type { CanonicalEntityId, QueryClass, DecisionStatus } from '../../shared/types/index.js';

/**
 * Label quality tier for an evaluation case, per RFC-009 §4.
 *
 * - `gold`   — 3+ annotators with IAA κ ≥ 0.8; highest reliability.
 * - `silver` — 2 annotators with κ ≥ 0.6; acceptable for most metrics.
 * - `bronze` — single annotator or low agreement; used for coverage only.
 */
export type LabelTier = 'gold' | 'silver' | 'bronze';

/**
 * A single evaluation case from the gold set, per RFC-009 §3.
 *
 * Each case represents a query with a known-correct resolution outcome
 * that the engine should reproduce. Cases carry metadata for slice-based
 * evaluation and label quality tracking.
 */
export interface EvalCase {
  /** Unique identifier for this evaluation case. */
  readonly caseId: string;

  /** The raw query string exactly as a user would type it. */
  readonly query: string;

  /** The classified query type, used for per-class metric breakdowns. */
  readonly queryClass: QueryClass;

  /** The expected entity ID for resolved cases. Absent when the expected outcome is ambiguous or failed. */
  readonly expectedEntityId?: CanonicalEntityId;

  /** The expected decision status (resolved, ambiguous, or failed). */
  readonly expectedStatus: DecisionStatus;

  /** Quality tier of the label, based on annotator agreement. */
  readonly labelTier: LabelTier;

  /**
   * Inter-annotator agreement (Cohen's κ or Fleiss' κ) for this case.
   * Gold-tier cases must have κ ≥ 0.8.
   */
  readonly annotatorAgreement?: number;

  /** When this case was created, used for temporal split enforcement. */
  readonly timestamp: Date;

  /**
   * Tags for slice-based evaluation (e.g. `['korean_query', 'short_form', 'multi_vintage']`).
   * Used by the slice evaluator to compute per-segment metrics.
   */
  readonly sliceTags: readonly string[];
}
