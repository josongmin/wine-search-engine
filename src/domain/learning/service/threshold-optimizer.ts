import type { QueryClass } from '../../shared/types/index.js';
import type { ThresholdProposal, ThresholdSet } from '../model/threshold-proposal.js';
import type { ProposalStore } from '../port/proposal-store.port.js';
import type { EvalCase } from '../../evaluation/model/eval-case.js';
import type { EvalResult } from '../../evaluation/model/eval-result.js';
import { UtilityScorer } from '../../evaluation/service/utility-scorer.js';

/**
 * Configuration for the threshold optimizer.
 */
export interface ThresholdOptimizerConfig {
  /** Minimum expected utility improvement to propose a change (default: 0.02). */
  readonly minUtilityDelta: number;

  /** Grid search step size for T_resolve (default: 0.05). */
  readonly resolveStep: number;

  /** Grid search step size for T_gap (default: 0.05). */
  readonly gapStep: number;

  /** Grid search step size for T_fail (default: 0.05). */
  readonly failStep: number;

  /** Lower bound for T_resolve search range (default: 0.3). */
  readonly resolveMin: number;

  /** Upper bound for T_resolve search range (default: 0.95). */
  readonly resolveMax: number;

  /** Lower bound for T_gap search range (default: 0.05). */
  readonly gapMin: number;

  /** Upper bound for T_gap search range (default: 0.5). */
  readonly gapMax: number;

  /** Lower bound for T_fail search range (default: 0.01). */
  readonly failMin: number;

  /** Upper bound for T_fail search range (default: 0.3). */
  readonly failMax: number;

  /** Minimum number of eval cases to optimize over (default: 100). */
  readonly minEvalCases: number;
}

/** Default configuration per RFC-010 §8. */
const DEFAULT_CONFIG: ThresholdOptimizerConfig = {
  minUtilityDelta: 0.02,
  resolveStep: 0.05,
  gapStep: 0.05,
  failStep: 0.05,
  resolveMin: 0.3,
  resolveMax: 0.95,
  gapMin: 0.05,
  gapMax: 0.5,
  failMin: 0.01,
  failMax: 0.3,
  minEvalCases: 100,
};

/**
 * A simulated evaluation result under different thresholds.
 * Used internally for grid search scoring.
 */
interface SimulatedOutcome {
  readonly utilityScore: number;
}

/**
 * Proposes threshold adjustments to maximize Decision Utility,
 * per RFC-010 §8.
 *
 * Uses grid search over T_resolve, T_gap, and T_fail values on a
 * held-out evaluation set. Proposals always start as 'pending' and
 * must pass through shadow testing before promotion.
 */
export class ThresholdOptimizer {
  private readonly config: ThresholdOptimizerConfig;
  private readonly utilityScorer: UtilityScorer;

  constructor(
    private readonly proposalStore: ProposalStore,
    config?: Partial<ThresholdOptimizerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.utilityScorer = new UtilityScorer();
  }

  /**
   * Optimizes thresholds for a specific query class using grid search.
   *
   * @param queryClass - The query class to optimize for.
   * @param currentThresholds - The current threshold values.
   * @param evalResults - Evaluation results on the held-out set.
   * @param evalCases - Corresponding evaluation cases.
   * @param generateId - Function to generate proposal IDs.
   * @returns A threshold proposal if improvement exceeds minimum delta, null otherwise.
   */
  async optimize(
    queryClass: QueryClass,
    currentThresholds: ThresholdSet,
    evalResults: readonly EvalResult[],
    evalCases: readonly EvalCase[],
    generateId: () => string,
  ): Promise<ThresholdProposal | null> {
    if (evalResults.length < this.config.minEvalCases) {
      return null;
    }

    const caseMap = new Map(evalCases.map((c) => [c.caseId, c]));

    // Compute current utility
    const currentUtility = this.utilityScorer.aggregateUtility(evalResults);

    // Grid search for best thresholds
    let bestThresholds: ThresholdSet = currentThresholds;
    let bestUtility = currentUtility;

    for (
      let tResolve = this.config.resolveMin;
      tResolve <= this.config.resolveMax;
      tResolve += this.config.resolveStep
    ) {
      for (
        let tGap = this.config.gapMin;
        tGap <= this.config.gapMax;
        tGap += this.config.gapStep
      ) {
        for (
          let tFail = this.config.failMin;
          tFail <= this.config.failMax;
          tFail += this.config.failStep
        ) {
          // Constraint: tFail < tResolve
          if (tFail >= tResolve) continue;

          const candidate: ThresholdSet = {
            tResolve: this.round(tResolve),
            tGap: this.round(tGap),
            tFail: this.round(tFail),
          };

          const utility = this.simulateUtility(
            candidate,
            evalResults,
            caseMap,
          );

          if (utility > bestUtility) {
            bestUtility = utility;
            bestThresholds = candidate;
          }
        }
      }
    }

    // Check if improvement exceeds minimum delta
    const delta = bestUtility - currentUtility;
    if (delta < this.config.minUtilityDelta) {
      return null;
    }

    const proposal: ThresholdProposal = {
      proposalId: generateId(),
      queryClass,
      proposedThresholds: bestThresholds,
      currentThresholds,
      expectedUtilityDelta: delta,
      evidence: {
        evalCaseCount: evalResults.length,
        utilityBefore: currentUtility,
        utilityAfter: bestUtility,
      },
      status: 'pending',
    };

    await this.proposalStore.saveThresholdProposal(proposal);
    return proposal;
  }

  /**
   * Simulates Decision Utility under a candidate threshold set.
   *
   * For each eval result, re-classifies the decision based on the
   * candidate thresholds and computes the utility score.
   */
  private simulateUtility(
    thresholds: ThresholdSet,
    results: readonly EvalResult[],
    caseMap: ReadonlyMap<string, EvalCase>,
  ): number {
    if (results.length === 0) return 0;

    let totalUtility = 0;

    for (const result of results) {
      const evalCase = caseMap.get(result.caseId);
      if (!evalCase) continue;

      const outcome = this.simulateDecision(result, thresholds, evalCase);
      totalUtility += outcome.utilityScore;
    }

    return totalUtility / results.length;
  }

  /**
   * Simulates a single decision under new thresholds.
   *
   * Uses the existing confidence to determine what the decision status
   * would be under the candidate thresholds.
   */
  private simulateDecision(
    result: EvalResult,
    thresholds: ThresholdSet,
    evalCase: EvalCase,
  ): SimulatedOutcome {
    const confidence = result.decisionConfidence;

    // Simulate: determine status from confidence vs thresholds
    let simulatedStatus: 'resolved' | 'ambiguous' | 'failed';
    if (confidence >= thresholds.tResolve) {
      simulatedStatus = 'resolved';
    } else if (confidence <= thresholds.tFail) {
      simulatedStatus = 'failed';
    } else {
      simulatedStatus = 'ambiguous';
    }

    const classification = this.utilityScorer.score(
      simulatedStatus,
      result.predictedEntityId,
      evalCase,
    );

    return { utilityScore: classification.utilityScore };
  }

  /** Rounds to 2 decimal places to avoid floating-point drift. */
  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
