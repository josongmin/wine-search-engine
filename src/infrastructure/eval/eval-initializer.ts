/**
 * Evaluation initialization module.
 *
 * Provides utilities to run evaluation at startup or on demand.
 * RFC-009: Complete evaluation framework integration.
 */

import type { QueryClass } from '../../domain/shared/types/index.js';
import type { EvalRunnerContract } from '../../config/container-eval-contracts.js';

/**
 * Options for running evaluation.
 */
export interface EvalRunnerOptions {
  /** Only evaluate cases with specific query class. */
  readonly queryClass?: QueryClass;

  /** Only evaluate cases matching specific slice tag. */
  readonly sliceTag?: string;

  /** Only evaluate cases with specific label tier. */
  readonly labelTier?: 'gold' | 'silver' | 'bronze';

  /** Whether to log detailed results. */
  readonly verbose?: boolean;
}

/**
 * Runs evaluation on a specified slice of the gold set.
 *
 * @param evalRunner - The evaluation runner instance.
 * @param options - Filtering and output options.
 * @returns Success status and summary.
 */
export async function runEvaluation(
  evalRunner: EvalRunnerContract,
  options?: EvalRunnerOptions,
): Promise<{
  readonly success: boolean;
  readonly caseCount: number;
  readonly message: string;
}> {
  try {
    const filter =
      options?.queryClass || options?.sliceTag || options?.labelTier
        ? {
            ...(options.queryClass ? { queryClass: options.queryClass } : {}),
            ...(options.sliceTag ? { sliceTag: options.sliceTag } : {}),
            ...(options.labelTier ? { labelTier: options.labelTier } : {}),
          }
        : undefined;

    console.warn('[EvalInitializer] Starting evaluation run...');
    const report = await evalRunner.run(filter);

    if (options?.verbose) {
      console.warn('[EvalInitializer] Evaluation complete:');
      console.warn(`  Cases evaluated: ${report.caseCount}`);
      console.warn(`  Overall utility: ${report.overallMetrics.decisionUtility.toFixed(3)}`);
      console.warn(`  Wrong resolve rate: ${report.overallMetrics.wrongResolveRate.toFixed(3)}`);
      console.warn(`  Release gates passed: ${report.releaseGateResult.passed}`);

      if (report.flaggedSlices.length > 0) {
        console.warn(`  Flagged slices: ${report.flaggedSlices.length}`);
        for (const slice of report.flaggedSlices) {
          console.warn(`    - ${slice.sliceTag} (${slice.metric}): ${slice.sliceValue.toFixed(3)} vs ${slice.overallValue.toFixed(3)} (Δ${slice.delta.toFixed(3)})`);
        }
      }
    }

    const passed = report.releaseGateResult.passed;
    const message = passed
      ? `✓ Evaluation passed (${report.caseCount} cases)`
      : `✗ Evaluation failed: release gates did not pass`;

    console.warn(`[EvalInitializer] ${message}`);

    return {
      success: passed,
      caseCount: report.caseCount,
      message,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[EvalInitializer] Evaluation failed: ${errorMessage}`);
    return {
      success: false,
      caseCount: 0,
      message: `Evaluation failed: ${errorMessage}`,
    };
  }
}
