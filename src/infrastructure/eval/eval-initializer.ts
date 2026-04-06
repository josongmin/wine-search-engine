/**
 * Evaluation initialization module.
 *
 * Provides utilities to run evaluation at startup or on demand.
 * RFC-009: Complete evaluation framework integration.
 */

import type { EvalRunnerContract } from '../../config/container-eval-contracts.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { QueryClass } from '../../domain/shared/types/index.js';

const log = bootstrapLogger.child({ component: 'EvalInitializer' });

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

    log.warn('starting evaluation run');
    const report = await evalRunner.run(filter);

    if (options?.verbose) {
      log.warn(
        {
          caseCount: report.caseCount,
          decisionUtility: report.overallMetrics.decisionUtility,
          wrongResolveRate: report.overallMetrics.wrongResolveRate,
          releaseGatesPassed: report.releaseGateResult.passed,
          flaggedSliceCount: report.flaggedSlices.length,
          flaggedSlices: report.flaggedSlices.map((slice) => ({
            sliceTag: slice.sliceTag,
            metric: slice.metric,
            sliceValue: slice.sliceValue,
            overallValue: slice.overallValue,
            delta: slice.delta,
          })),
        },
        'evaluation complete',
      );
    }

    const passed = report.releaseGateResult.passed;
    const message = passed
      ? `✓ Evaluation passed (${report.caseCount} cases)`
      : `✗ Evaluation failed: release gates did not pass`;

    log.warn({ message, passed }, 'evaluation finished');

    return {
      success: passed,
      caseCount: report.caseCount,
      message,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'evaluation failed');
    return {
      success: false,
      caseCount: 0,
      message: `Evaluation failed: ${errorMessage}`,
    };
  }
}
