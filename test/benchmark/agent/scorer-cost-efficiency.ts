/**
 * Cost-efficiency dimension scoring.
 *
 * Split from {@link ./scorer.ts} during the 2026-05-25 decomposition. Pure
 * function with no shared mutable state — depends only on the
 * `ScenarioExpectation` / `ScenarioExecution` shape and pushes warnings
 * onto the caller-supplied `Diagnostic[]` array.
 */

import type { ScenarioExpectation } from './scenario.js';
import type { ScenarioExecution, Diagnostic } from './scorer.js';

/**
 * Cost dimension: max-overshoot model. Replaces the prior sqrt(dur×tok) which
 * collapsed cost to 0 when one term was 0. The new model penalises only the
 * worst-overshooting axis, so a 2x latency overshoot with perfect tokens
 * gets cost = 1 - 1.0 = 0 (was sqrt(0×1) = 0 — same result for extreme cases)
 * but a 1.5x latency overshoot with perfect tokens now gets cost = 0.5
 * (was sqrt(0.5×1) ≈ 0.71 — actually MORE punitive arithmetic, but FAIR
 * because we no longer multiply two independent overruns).
 */
export function scoreCostEfficiency(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number {
  // Defaults raised post-audit. Observed real-mode p95 ~ 12s for happy paths
  // and 25s for the comparison route — a 15s default was tighter than p95
  // and falsely penalised legitimate runs. 25s is ~p99 of healthy execution
  // and matches "user starts wondering if it's broken" UX threshold.
  const DEFAULT_MAX_DURATION_MS = 25_000;
  const DEFAULT_MAX_TOTAL_TOKENS = 12_000;
  /** Overshoot ratio threshold for severe cost diagnostics. 1.0 means >2x budget.
   *  v4: severity is always 'warn', never 'critical'. Cost overshoots are engineering
   *  failures, not correctness/security failures. Using 'critical' caused the
   *  criticalFailure short-circuit to collapse overall to 0 for a 2x token overshoot,
   *  which is disproportionate — the cost dimension already scores 0 at that point,
   *  penalizing via the geometric mean without needing a hard collapse. */
  const SEVERE_OVERSHOOT_RATIO = 1.0;

  const maxDuration = exp.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxTokens = exp.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  const totalTokens = execution.totalTokens.input + execution.totalTokens.output;

  // S1.1: score latency against agent WORK time (wall minus throttle backoff),
  // not raw orchestrator duration. `agentWorkMs` is omitted by legacy callers
  // -> fall back to `totalDurationMs`. `!= null` (not truthiness) so a
  // legitimate agentWorkMs of 0 is honored rather than silently replaced
  // (CLAUDE.md rule 26).
  const effectiveDurationMs = execution.agentWorkMs != null
    ? execution.agentWorkMs
    : execution.totalDurationMs;

  let durOvershoot = 0;
  if (Number.isFinite(maxDuration) && effectiveDurationMs > maxDuration) {
    durOvershoot = (effectiveDurationMs - maxDuration) / maxDuration;
    diagnostics.push({
      dim: 'costEfficiency',
      severity: 'warn',
      code: durOvershoot >= SEVERE_OVERSHOOT_RATIO ? 'LATENCY_BUDGET_BLOWN' : 'LATENCY_BUDGET_EXCEEDED',
      message: `duration ${effectiveDurationMs}ms > budget ${maxDuration}ms`,
      observed: effectiveDurationMs,
      expected: maxDuration,
    });
  }

  let tokOvershoot = 0;
  if (Number.isFinite(maxTokens) && totalTokens > maxTokens) {
    tokOvershoot = (totalTokens - maxTokens) / maxTokens;
    diagnostics.push({
      dim: 'costEfficiency',
      severity: 'warn',
      code: tokOvershoot >= SEVERE_OVERSHOOT_RATIO ? 'TOKEN_BUDGET_BLOWN' : 'TOKEN_BUDGET_EXCEEDED',
      message: `tokens ${totalTokens} > budget ${maxTokens}`,
      observed: totalTokens,
      expected: maxTokens,
    });
  }

  // max-overshoot model: penalty proportional to the worse-overshooting axis,
  // not the geometric product of independent overshoots.
  const worstOvershoot = Math.max(durOvershoot, tokOvershoot);
  return Math.max(0, 1 - worstOvershoot);
}
