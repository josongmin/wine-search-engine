/**
 * Step-efficiency dimension scoring.
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 */

import type { ScenarioExpectation } from './scenario.js';
import type { Diagnostic } from './scorer.js';

export function scoreStepEfficiency(
  exp: ScenarioExpectation,
  stepCount: number,
  diagnostics: Diagnostic[],
): number {
  if (!Number.isFinite(stepCount) || stepCount < 0) {
    diagnostics.push({
      dim: 'stepEfficiency',
      severity: 'critical',
      code: 'INVALID_STEP_COUNT',
      message: `invalid stepCount=${stepCount}`,
      observed: stepCount,
    });
    return 0;
  }
  if (exp.maxSteps <= 0) {
    return stepCount === 0 ? 1 : 0;
  }
  if (stepCount <= exp.maxSteps) return 1;
  const overshoot = stepCount - exp.maxSteps;
  const score = Math.max(0, 1 - overshoot / exp.maxSteps);
  diagnostics.push({
    dim: 'stepEfficiency',
    severity: 'warn',
    code: 'STEP_BUDGET_EXCEEDED',
    message: `steps ${stepCount} > budget ${exp.maxSteps}`,
    observed: stepCount,
    expected: exp.maxSteps,
  });
  return score;
}
