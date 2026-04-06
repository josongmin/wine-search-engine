import type { DecisionStatus, EntityId, EvidenceItem, DecisionSnapshot } from '../../shared/types/index.js';
import type { LTRScoreComponents } from '../../ranking/service/ltr-feature-extractor.js';
import type { FunnelMetrics } from '../../ranking/model/ranking-stage.js';
import type { EvalProvenanceSlice } from '../../retrieval/model/provenance.js';
import type { EvalCase } from '../model/eval-case.js';
import type { EvalResult } from '../model/eval-result.js';
import type { EvalMetrics, SliceMetrics } from '../model/eval-metrics.js';
import type { GoldSetStore, GoldSetFilter } from '../port/gold-set-store.port.js';
import type { EvalResultStore } from '../port/eval-result-store.port.js';
import { UtilityScorer } from './utility-scorer.js';
import { SliceEvaluator, type FlaggedSlice } from './slice-evaluator.js';
import { SelectivePredictor } from './selective-predictor.js';
import { CalibrationEvaluator } from './calibration-evaluator.js';
import { EvidenceAuditor } from './evidence-auditor.js';

/**
 * The output of the search pipeline for a single query, as seen by the
 * evaluation framework. Adapters must convert domain-specific results
 * to this shape.
 */
export interface SearchPipelineOutput {
  /** The predicted entity ID, if resolved. */
  readonly predictedEntityId?: EntityId;

  /** The decision status. */
  readonly predictedStatus: DecisionStatus;

  /** Calibrated decision confidence. */
  readonly decisionConfidence: number;

  /** Surfaced execution contract for honesty-aware evaluation. */
  readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';

  /** Whether the surfaced execution path was blocking-eligible. */
  readonly blockingEligible?: boolean;

  /** Structured degradation reasons surfaced by the runtime contract. */
  readonly degradationReasons?: readonly string[];

  /** Evidence trail for the decision. */
  readonly evidenceItems: readonly EvidenceItem[];

  /** Latency in milliseconds. */
  readonly latencyMs: number;

  /** System snapshot at decision time. */
  readonly decisionSnapshot: DecisionSnapshot;

  /**
   * Whether an RFC-016 admission invariant violation was detected for this
   * case (RFC-009 §4.7).  Infrastructure adapters set this when the engine
   * emitted a resolved response that breached an AdmissionGate invariant.
   */
  readonly admissionViolationDetected?: boolean;

  /** Score components from the top-ranked result, for LTR training. */
  readonly topResultScoreComponents?: LTRScoreComponents;

  /** T5.6: Stage-aware funnel metrics emitted by the ranking pipeline when available. */
  readonly funnelMetrics?: FunnelMetrics;

  /**
   * Retrieval provenance slices for this query, collected by the eval adapter.
   * Used for channel-level offline analysis and quality regression.
   */
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[];
}

/**
 * Port for running a query through the search pipeline during evaluation.
 * Infrastructure adapters implement this to connect evaluation to the
 * actual engine.
 */
export interface SearchPipelinePort {
  /**
   * Runs a single query through the search pipeline and returns the output.
   *
   * @param query - The raw query string.
   * @param queryClass - The classified query type.
   * @returns The pipeline's output for this query.
   */
  execute(query: string, queryClass: EvalCase['queryClass']): Promise<SearchPipelineOutput>;
}

/**
 * Release gate thresholds. The evaluation must pass ALL gates for a
 * model/threshold change to be eligible for promotion.
 */
export interface ReleaseGates {
  /** Minimum aggregate Decision Utility. */
  readonly minUtility: number;

  /** Maximum tolerated wrong-resolve rate. */
  readonly maxWrongResolveRate: number;

  /** Maximum tolerated ECE. */
  readonly maxECE: number;

  /** Maximum tolerated E-AURC. */
  readonly maxEAURC: number;

  /**
   * Maximum tolerated admission violation rate (RFC-016 invariant breaches).
   * Target: 0 — any non-zero value is a release blocker.
   */
  readonly maxAdmissionViolationRate: number;

  /** Minimum required evidence sufficiency (RFC-009 §8.1). Target: ≥ 0.85. */
  readonly minEvidenceSufficiency: number;

  /** Minimum required evidence comprehensiveness (RFC-009 §8.1). Target: ≥ 0.70. */
  readonly minEvidenceComprehensiveness: number;
}

/** Default release gates, per RFC-009 §11. */
const DEFAULT_RELEASE_GATES: ReleaseGates = {
  minUtility: 0.6,
  maxWrongResolveRate: 0.02,
  maxECE: 0.05,
  maxEAURC: 0.1,
  maxAdmissionViolationRate: 0,
  minEvidenceSufficiency: 0.85,
  minEvidenceComprehensiveness: 0.70,
};

/**
 * Result of checking release gates.
 */
export interface ReleaseGateResult {
  /** Whether all gates passed. */
  readonly passed: boolean;

  /** Individual gate outcomes. */
  readonly gates: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly actual: number;
    readonly threshold: number;
  }[];
}

/**
 * The complete evaluation report produced by a single evaluation run.
 */
export interface EvalReport {
  /** Aggregate metrics across all cases. */
  readonly overallMetrics: EvalMetrics;

  /** Per-slice metrics. */
  readonly sliceMetrics: readonly SliceMetrics[];

  /** Flagged underperforming slices. */
  readonly flaggedSlices: readonly FlaggedSlice[];

  /** Release gate results. */
  readonly releaseGateResult: ReleaseGateResult;

  /** Number of cases evaluated. */
  readonly caseCount: number;

  /** Timestamp of this evaluation run. */
  readonly evaluatedAt: Date;
}

/**
 * Main evaluation orchestrator, per RFC-009 §12.
 *
 * Pipeline:
 * 1. Load gold-set cases from the store.
 * 2. Run each case through the search pipeline via the port.
 * 3. Score each result with the UtilityScorer.
 * 4. Compute aggregate EvalMetrics.
 * 5. Compute per-slice metrics.
 * 6. Check release gates.
 * 7. Return the full evaluation report.
 */
export class EvalRunner {
  private readonly utilityScorer: UtilityScorer;
  private readonly selectivePredictor: SelectivePredictor;
  private readonly calibrationEvaluator: CalibrationEvaluator;
  private readonly evidenceAuditor: EvidenceAuditor;
  private readonly sliceEvaluator: SliceEvaluator;

  constructor(
    private readonly goldSetStore: GoldSetStore,
    private readonly evalResultStore: EvalResultStore,
    private readonly searchPipeline: SearchPipelinePort,
    private readonly releaseGates: ReleaseGates = DEFAULT_RELEASE_GATES,
  ) {
    this.utilityScorer = new UtilityScorer();
    this.selectivePredictor = new SelectivePredictor();
    this.calibrationEvaluator = new CalibrationEvaluator();
    this.evidenceAuditor = new EvidenceAuditor();
    this.sliceEvaluator = new SliceEvaluator(
      this.utilityScorer,
      this.selectivePredictor,
      this.calibrationEvaluator,
      this.evidenceAuditor,
    );
  }

  /**
   * Runs a full evaluation pass over the gold set.
   *
   * @param filter - Optional filter for gold-set case selection.
   * @returns The complete evaluation report.
   */
  async run(filter?: GoldSetFilter): Promise<EvalReport> {
    // Step 1: Load gold-set cases
    const cases = await this.goldSetStore.getCases(filter);

    // Step 2 & 3: Run each case and score
    const results: EvalResult[] = [];
    for (const evalCase of cases) {
      const result = await this.evaluateCase(evalCase);
      results.push(result);

      // Persist each result for historical tracking
      await this.evalResultStore.saveResult(result);
    }

    // Step 4: Compute aggregate metrics
    const overallMetrics = this.sliceEvaluator.computeMetrics(results);

    // Step 5: Compute per-slice metrics
    const sliceMetrics = this.sliceEvaluator.evaluateBySlice(results, cases);

    // Step 5b: Flag underperforming slices
    const flaggedSlices = this.sliceEvaluator.flagUnderperformingSlices(
      sliceMetrics,
      overallMetrics,
    );

    // Step 6: Check release gates
    const releaseGateResult = this.checkReleaseGates(overallMetrics);

    // Step 7: Return full report
    return {
      overallMetrics,
      sliceMetrics,
      flaggedSlices,
      releaseGateResult,
      caseCount: cases.length,
      evaluatedAt: new Date(),
    };
  }

  /**
   * Evaluates a single case: runs through the pipeline and computes utility.
   */
  private async evaluateCase(evalCase: EvalCase): Promise<EvalResult> {
    const output = await this.searchPipeline.execute(
      evalCase.query,
      evalCase.queryClass,
    );

    const classification = this.utilityScorer.score(
      output.predictedStatus,
      output.predictedEntityId,
      evalCase,
    );

    const result: EvalResult = {
      caseId: evalCase.caseId,
      ...(output.predictedEntityId !== undefined
        ? { predictedEntityId: output.predictedEntityId }
        : {}),
      predictedStatus: output.predictedStatus,
      decisionConfidence: output.decisionConfidence,
      ...(output.executionMode !== undefined ? { executionMode: output.executionMode } : {}),
      ...(output.blockingEligible !== undefined ? { blockingEligible: output.blockingEligible } : {}),
      ...(output.degradationReasons !== undefined ? { degradationReasons: output.degradationReasons } : {}),
      utilityScore: classification.utilityScore,
      isCorrectResolve: classification.isCorrectResolve,
      isWrongResolve: classification.isWrongResolve,
      isSafeAbstain: classification.isSafeAbstain,
      isAvoidableAbstain: classification.isAvoidableAbstain,
      evidenceItems: output.evidenceItems,
      ...(output.admissionViolationDetected === true
        ? { isAdmissionViolation: true }
        : {}),
      ...(output.topResultScoreComponents !== undefined
        ? { topResultScoreComponents: output.topResultScoreComponents }
        : {}),
      ...(output.funnelMetrics !== undefined
        ? { funnelMetrics: output.funnelMetrics }
        : {}),
      ...(output.retrievalProvenanceSlices !== undefined && output.retrievalProvenanceSlices.length > 0
        ? { retrievalProvenanceSlices: output.retrievalProvenanceSlices }
        : {}),
      latencyMs: output.latencyMs,
      decisionSnapshot: output.decisionSnapshot,
    };

    return result;
  }

  /**
   * Checks whether the evaluation metrics pass all release gates.
   */
  private checkReleaseGates(metrics: EvalMetrics): ReleaseGateResult {
    const gates = [
      {
        name: 'minUtility',
        passed: metrics.decisionUtility >= this.releaseGates.minUtility,
        actual: metrics.decisionUtility,
        threshold: this.releaseGates.minUtility,
      },
      {
        name: 'maxWrongResolveRate',
        passed: metrics.wrongResolveRate <= this.releaseGates.maxWrongResolveRate,
        actual: metrics.wrongResolveRate,
        threshold: this.releaseGates.maxWrongResolveRate,
      },
      {
        name: 'maxECE',
        passed: metrics.ece <= this.releaseGates.maxECE,
        actual: metrics.ece,
        threshold: this.releaseGates.maxECE,
      },
      {
        name: 'maxEAURC',
        passed: metrics.eAurc <= this.releaseGates.maxEAURC,
        actual: metrics.eAurc,
        threshold: this.releaseGates.maxEAURC,
      },
      {
        name: 'maxAdmissionViolationRate',
        passed: metrics.admissionViolationRate <= this.releaseGates.maxAdmissionViolationRate,
        actual: metrics.admissionViolationRate,
        threshold: this.releaseGates.maxAdmissionViolationRate,
      },
      {
        name: 'minEvidenceSufficiency',
        passed: metrics.evidenceSufficiency >= this.releaseGates.minEvidenceSufficiency,
        actual: metrics.evidenceSufficiency,
        threshold: this.releaseGates.minEvidenceSufficiency,
      },
      {
        name: 'minEvidenceComprehensiveness',
        passed:
          metrics.evidenceComprehensiveness >= this.releaseGates.minEvidenceComprehensiveness,
        actual: metrics.evidenceComprehensiveness,
        threshold: this.releaseGates.minEvidenceComprehensiveness,
      },
    ];

    return {
      passed: gates.every((g) => g.passed),
      gates,
    };
  }
}
