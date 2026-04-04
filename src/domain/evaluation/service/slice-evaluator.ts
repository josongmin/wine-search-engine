import type { EvalResult } from '../model/eval-result.js';
import type { EvalCase } from '../model/eval-case.js';
import type { EvalMetrics, SliceMetrics } from '../model/eval-metrics.js';
import type { UtilityScorer } from './utility-scorer.js';
import type { SelectivePredictor } from './selective-predictor.js';
import type { CalibrationEvaluator } from './calibration-evaluator.js';
import type { EvidenceAuditor } from './evidence-auditor.js';

/**
 * A flagged slice where metrics are significantly below the overall average.
 */
export interface FlaggedSlice {
  /** The slice tag. */
  readonly sliceTag: string;

  /** The metric that triggered the flag. */
  readonly metric: string;

  /** The slice's value for the flagged metric. */
  readonly sliceValue: number;

  /** The overall value for the flagged metric. */
  readonly overallValue: number;

  /** How much worse the slice is (positive = worse). */
  readonly delta: number;
}

/**
 * Evaluates engine performance across data slices, per RFC-009 §10.
 *
 * Slice evaluation ensures that aggregate metrics do not mask regressions
 * in important sub-populations (e.g. Korean queries, short-form names,
 * multi-vintage wines).
 */
export class SliceEvaluator {
  constructor(
    private readonly utilityScorer: UtilityScorer,
    private readonly selectivePredictor: SelectivePredictor,
    private readonly calibrationEvaluator: CalibrationEvaluator,
    private readonly evidenceAuditor: EvidenceAuditor,
  ) {}

  /**
   * Computes per-slice metrics by grouping results according to their
   * eval case slice tags and query classes.
   *
   * @param results - All evaluation results.
   * @param cases - Corresponding evaluation cases.
   * @returns Per-slice metrics for each discovered slice.
   */
  evaluateBySlice(
    results: readonly EvalResult[],
    cases: readonly EvalCase[],
  ): readonly SliceMetrics[] {
    const caseMap = new Map(cases.map((c) => [c.caseId, c]));

    // Discover all slices: union of sliceTags and queryClass values
    const sliceToResults = new Map<string, EvalResult[]>();

    for (const result of results) {
      const evalCase = caseMap.get(result.caseId);
      if (!evalCase) continue;

      // Add to query-class slice
      const qcSlice = `queryClass:${evalCase.queryClass}`;
      this.addToSlice(sliceToResults, qcSlice, result);

      // Add to each slice tag
      for (const tag of evalCase.sliceTags) {
        this.addToSlice(sliceToResults, tag, result);
      }
    }

    // Compute metrics for each slice
    const sliceMetrics: SliceMetrics[] = [];
    for (const [sliceTag, sliceResults] of sliceToResults) {
      const metrics = this.computeMetrics(sliceResults);
      sliceMetrics.push({
        sliceTag,
        caseCount: sliceResults.length,
        metrics,
      });
    }

    return sliceMetrics;
  }

  /**
   * Identifies slices where the Decision Utility is significantly below
   * the overall average. Uses a configurable threshold (default: 0.1
   * utility points below overall).
   *
   * @param sliceMetrics - Per-slice metrics.
   * @param overallMetrics - Aggregate metrics across all cases.
   * @param utilityDeltaThreshold - Minimum delta to flag (default: 0.1).
   * @returns Flagged slices that need attention.
   */
  flagUnderperformingSlices(
    sliceMetrics: readonly SliceMetrics[],
    overallMetrics: EvalMetrics,
    utilityDeltaThreshold: number = 0.1,
  ): readonly FlaggedSlice[] {
    const flagged: FlaggedSlice[] = [];

    for (const slice of sliceMetrics) {
      // Flag slices where decision utility is significantly below overall
      const utilityDelta = overallMetrics.decisionUtility - slice.metrics.decisionUtility;
      if (utilityDelta > utilityDeltaThreshold) {
        flagged.push({
          sliceTag: slice.sliceTag,
          metric: 'decisionUtility',
          sliceValue: slice.metrics.decisionUtility,
          overallValue: overallMetrics.decisionUtility,
          delta: utilityDelta,
        });
      }

      // Flag slices where wrong-resolve rate is significantly above overall
      const wrongResolveDelta =
        slice.metrics.wrongResolveRate - overallMetrics.wrongResolveRate;
      if (wrongResolveDelta > 0.05) {
        flagged.push({
          sliceTag: slice.sliceTag,
          metric: 'wrongResolveRate',
          sliceValue: slice.metrics.wrongResolveRate,
          overallValue: overallMetrics.wrongResolveRate,
          delta: wrongResolveDelta,
        });
      }

      // Flag slices where ECE is significantly above overall
      const eceDelta = slice.metrics.ece - overallMetrics.ece;
      if (eceDelta > 0.05) {
        flagged.push({
          sliceTag: slice.sliceTag,
          metric: 'ece',
          sliceValue: slice.metrics.ece,
          overallValue: overallMetrics.ece,
          delta: eceDelta,
        });
      }
    }

    return flagged;
  }

  /**
   * Computes full EvalMetrics for a subset of results.
   */
  computeMetrics(results: readonly EvalResult[]): EvalMetrics {
    const count = results.length;
    if (count === 0) {
      return this.emptyMetrics();
    }

    const correctResolves = results.filter((r) => r.isCorrectResolve).length;
    const wrongResolves = results.filter((r) => r.isWrongResolve).length;
    const safeAbstains = results.filter((r) => r.isSafeAbstain).length;
    const avoidableAbstains = results.filter((r) => r.isAvoidableAbstain).length;

    const aurc = this.selectivePredictor.computeAURC(results);
    const eAurc = this.selectivePredictor.computeEAURC(results);
    const selectiveRiskAtCoverage = this.selectivePredictor.computeSelectiveRiskMap(results);
    const ece = this.calibrationEvaluator.computeECE(results);
    const evidenceAudit = this.evidenceAuditor.audit(results);

    const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

    return {
      decisionUtility: this.utilityScorer.aggregateUtility(results),
      correctResolveRate: correctResolves / count,
      wrongResolveRate: wrongResolves / count,
      safeAbstainRate: safeAbstains / count,
      avoidableAbstainRate: avoidableAbstains / count,
      aurc,
      eAurc,
      selectiveRiskAtCoverage,
      ece,
      constraintSatisfactionRate: this.computeConstraintSatisfactionRate(results),
      anchorPreservationRate: this.computeAnchorPreservationRate(results),
      evidenceCompletenessRate: evidenceAudit.completenessRate,
      evidenceSufficiency: evidenceAudit.sufficiency,
      evidenceComprehensiveness: evidenceAudit.comprehensiveness,
      p50LatencyMs: this.percentile(latencies, 0.5),
      p95LatencyMs: this.percentile(latencies, 0.95),
    };
  }

  /**
   * Computes the constraint satisfaction rate from evidence items.
   * Looks for 'constraint_pass' evidence types.
   */
  private computeConstraintSatisfactionRate(results: readonly EvalResult[]): number {
    const resolved = results.filter((r) => r.predictedStatus === 'resolved');
    if (resolved.length === 0) return 0;

    const satisfied = resolved.filter((r) =>
      r.evidenceItems.some((e) => e.type === 'constraint_pass'),
    ).length;

    // If no constraint-related evidence exists, assume N/A → return 1.0
    const hasConstraintEvidence = resolved.some((r) =>
      r.evidenceItems.some(
        (e) => e.type === 'constraint_pass' || e.type === 'constraint_fail',
      ),
    );

    if (!hasConstraintEvidence) return 1.0;
    return satisfied / resolved.length;
  }

  /**
   * Computes the anchor preservation rate from evidence items.
   * Looks for 'anchor_preserved' evidence types.
   */
  private computeAnchorPreservationRate(results: readonly EvalResult[]): number {
    const resolved = results.filter((r) => r.predictedStatus === 'resolved');
    if (resolved.length === 0) return 0;

    const hasAnchorEvidence = resolved.some((r) =>
      r.evidenceItems.some(
        (e) => e.type === 'anchor_preserved' || e.type === 'anchor_missing',
      ),
    );

    if (!hasAnchorEvidence) return 1.0;

    const preserved = resolved.filter((r) =>
      r.evidenceItems.some((e) => e.type === 'anchor_preserved'),
    ).length;

    return preserved / resolved.length;
  }

  /** Computes a percentile from a sorted array. */
  private percentile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
  }

  /** Returns zeroed-out metrics for empty result sets. */
  private emptyMetrics(): EvalMetrics {
    return {
      decisionUtility: 0,
      correctResolveRate: 0,
      wrongResolveRate: 0,
      safeAbstainRate: 0,
      avoidableAbstainRate: 0,
      aurc: 0,
      eAurc: 0,
      selectiveRiskAtCoverage: new Map(),
      ece: 0,
      constraintSatisfactionRate: 0,
      anchorPreservationRate: 0,
      evidenceCompletenessRate: 0,
      evidenceSufficiency: 0,
      evidenceComprehensiveness: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  /** Adds a result to the appropriate slice bucket. */
  private addToSlice(
    map: Map<string, EvalResult[]>,
    sliceTag: string,
    result: EvalResult,
  ): void {
    const existing = map.get(sliceTag);
    if (existing) {
      existing.push(result);
    } else {
      map.set(sliceTag, [result]);
    }
  }
}
