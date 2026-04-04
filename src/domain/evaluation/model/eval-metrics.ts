/**
 * Aggregate evaluation metrics for a set of evaluation results,
 * per RFC-009 §6.
 *
 * These metrics drive release-gate decisions: the engine must meet
 * minimum thresholds on utility, wrong-resolve rate, and ECE before
 * any model or threshold change is promoted to production.
 */
export interface EvalMetrics {
  /** Aggregate Decision Utility score (mean across all cases). */
  readonly decisionUtility: number;

  /** Fraction of cases that were correctly resolved. */
  readonly correctResolveRate: number;

  /** Fraction of cases where the engine resolved to the wrong entity. */
  readonly wrongResolveRate: number;

  /** Fraction of cases where the engine safely abstained on genuinely ambiguous input. */
  readonly safeAbstainRate: number;

  /** Fraction of cases where the engine abstained despite a clear answer existing. */
  readonly avoidableAbstainRate: number;

  /** Area Under Risk-Coverage curve — lower is better. */
  readonly aurc: number;

  /** Excess AURC: AURC minus the optimal (oracle) AURC. Lower is better. */
  readonly eAurc: number;

  /** Map from coverage level (0–1) to risk (wrong-resolve rate) at that coverage. */
  readonly selectiveRiskAtCoverage: ReadonlyMap<number, number>;

  /** Expected Calibration Error — lower is better, target per query class in RFC-009. */
  readonly ece: number;

  /** Fraction of cases where all query constraints were satisfied. */
  readonly constraintSatisfactionRate: number;

  /** Fraction of anchor-based queries where the anchor entity was preserved in results. */
  readonly anchorPreservationRate: number;

  /** Fraction of resolved cases that have non-empty evidence trails. */
  readonly evidenceCompletenessRate: number;

  /**
   * Evidence sufficiency: fraction of resolved cases where the evidence
   * alone would produce the same decision (RFC-009 faithfulness metric).
   */
  readonly evidenceSufficiency: number;

  /**
   * Evidence comprehensiveness: fraction of resolved cases where removing
   * the evidence would change the decision (RFC-009 faithfulness metric).
   */
  readonly evidenceComprehensiveness: number;

  /** Median (p50) end-to-end latency in milliseconds. */
  readonly p50LatencyMs: number;

  /** 95th percentile end-to-end latency in milliseconds. */
  readonly p95LatencyMs: number;
}

/**
 * Metrics computed for a specific evaluation slice (segment).
 *
 * Slices are defined by query class, slice tags, or automatically
 * discovered groupings. Per-slice metrics enable detection of
 * regressions that are hidden in aggregate numbers.
 */
export interface SliceMetrics {
  /** The tag identifying this slice (e.g. 'korean_query', 'short_entity'). */
  readonly sliceTag: string;

  /** Number of evaluation cases in this slice. */
  readonly caseCount: number;

  /** Full metrics for this slice. */
  readonly metrics: EvalMetrics;
}
