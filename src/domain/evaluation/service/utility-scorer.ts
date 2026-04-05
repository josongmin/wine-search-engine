import type { EvalCase } from '../model/eval-case.js';
import type { EvalResult } from '../model/eval-result.js';
import type { DecisionStatus, EntityId } from '../../shared/types/index.js';

/**
 * Decision Utility weights, per RFC-009 §2.
 *
 * The asymmetric weights reflect the domain principle that a wrong resolve
 * is far more harmful than an overly cautious abstain.
 */
const UTILITY_WEIGHTS = {
  CORRECT_RESOLVE: 1.0,
  WRONG_RESOLVE: -1.5,
  SAFE_ABSTAIN: 0.4,
  AVOIDABLE_ABSTAIN: -0.3,
  FAILED: 0.0,
} as const;

/**
 * Classification of a single evaluation outcome into one of the
 * Decision Utility categories.
 */
export interface UtilityClassification {
  readonly utilityScore: number;
  readonly isCorrectResolve: boolean;
  readonly isWrongResolve: boolean;
  readonly isSafeAbstain: boolean;
  readonly isAvoidableAbstain: boolean;
}

/**
 * Computes the Decision Utility Score for individual evaluation cases,
 * per RFC-009 §2.
 *
 * The utility formula encodes the domain's loss function:
 * - correct_resolve:    predicted matches expected, status = resolved → +1.0
 * - wrong_resolve:      predicted ≠ expected, status = resolved       → -1.5
 * - safe_abstain:       status = ambiguous AND expected was ambiguous  → +0.4
 * - avoidable_abstain:  status = ambiguous AND expected had clear answer → -0.3
 * - failed:             status = failed → 0.0 (neutral)
 */
export class UtilityScorer {
  /**
   * Classifies a single prediction against its gold-label case and
   * returns the utility score along with boolean category flags.
   *
   * @param predictedStatus - The decision status produced by the engine.
   * @param predictedEntityId - The entity ID predicted by the engine, if any.
   * @param evalCase - The gold-label evaluation case.
   * @returns The utility classification with score and category flags.
   */
  score(
    predictedStatus: DecisionStatus,
    predictedEntityId: EntityId | undefined,
    evalCase: EvalCase,
  ): UtilityClassification {
    // Failed: system acknowledged it couldn't answer — neutral score
    if (predictedStatus === 'failed') {
      return {
        utilityScore: UTILITY_WEIGHTS.FAILED,
        isCorrectResolve: false,
        isWrongResolve: false,
        isSafeAbstain: false,
        isAvoidableAbstain: false,
      };
    }

    // Resolved cases
    if (predictedStatus === 'resolved') {
      const isCorrect = this.isEntityMatch(predictedEntityId, evalCase.expectedEntityId);
      if (isCorrect) {
        return {
          utilityScore: UTILITY_WEIGHTS.CORRECT_RESOLVE,
          isCorrectResolve: true,
          isWrongResolve: false,
          isSafeAbstain: false,
          isAvoidableAbstain: false,
        };
      }
      // Resolved to wrong entity — most severe failure
      return {
        utilityScore: UTILITY_WEIGHTS.WRONG_RESOLVE,
        isCorrectResolve: false,
        isWrongResolve: true,
        isSafeAbstain: false,
        isAvoidableAbstain: false,
      };
    }

    // Ambiguous cases (exhaustive: failed + resolved handled above)
    if (evalCase.expectedStatus === 'ambiguous') {
      return {
        utilityScore: UTILITY_WEIGHTS.SAFE_ABSTAIN,
        isCorrectResolve: false,
        isWrongResolve: false,
        isSafeAbstain: true,
        isAvoidableAbstain: false,
      };
    }
    return {
      utilityScore: UTILITY_WEIGHTS.AVOIDABLE_ABSTAIN,
      isCorrectResolve: false,
      isWrongResolve: false,
      isSafeAbstain: false,
      isAvoidableAbstain: true,
    };

    // Unreachable for valid DecisionStatus, but handle gracefully
    return {
      utilityScore: UTILITY_WEIGHTS.FAILED,
      isCorrectResolve: false,
      isWrongResolve: false,
      isSafeAbstain: false,
      isAvoidableAbstain: false,
    };
  }

  /**
   * Computes the aggregate Decision Utility over a set of results.
   *
   * @param results - The scored evaluation results.
   * @returns The mean utility score across all results.
   */
  aggregateUtility(results: readonly EvalResult[]): number {
    if (results.length === 0) return 0;
    const total = results.reduce((sum, r) => sum + r.utilityScore, 0);
    return total / results.length;
  }

  /**
   * Checks whether the predicted entity matches the expected entity.
   * Both must be defined and equal for a correct resolve.
   */
  private isEntityMatch(
    predicted: EntityId | undefined,
    expected: EntityId | undefined,
  ): boolean {
    if (predicted === undefined || expected === undefined) return false;
    return predicted === expected;
  }
}
