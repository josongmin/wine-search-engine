/**
 * Auto-rollback decision logic for Epic-18 closed-loop core (T18-5).
 *
 * Compares a freshly-closed quality window against a baseline snapshot
 * (e.g. the pre-rollout window) and decides whether the live variant
 * should be rolled back. The logic is intentionally conservative:
 *   - Small sample sizes are ignored (noise floor).
 *   - Relative CTR drops trigger via `ctrDropPct`.
 *   - Absolute zero-result rate rises trigger via `zeroResultRiseAbs`.
 * Any triggered rule yields `shouldRollback = true` with an explanatory
 * reason string; callers render these into alerts and audit logs.
 */

import type { QualitySnapshot } from './online-quality-monitor.js';

/** Default: a 10% relative CTR drop is meaningful enough to roll back. */
export const DEFAULT_CTR_DROP_PCT = 0.10;
/** Default: a 5 percentage-point absolute rise in zero-result rate is bad. */
export const DEFAULT_ZERO_RESULT_RISE_ABS = 0.05;
/** Default: fewer than 1K impressions = not enough signal to act. */
export const DEFAULT_MIN_SAMPLES = 1000;

export interface RollbackThresholds {
  readonly ctrDropPct: number;
  readonly zeroResultRiseAbs: number;
  readonly minSamples: number;
}

export interface RollbackDecision {
  readonly shouldRollback: boolean;
  readonly reasons: readonly string[];
}

/** Decimal places for formatted thresholds in rollback reason strings. */
const ROLLBACK_REASON_DECIMAL_PLACES = 4;

function fmt(n: number): string {
  if (!Number.isFinite(n)) return 'NaN';
  return n.toFixed(ROLLBACK_REASON_DECIMAL_PLACES);
}

/**
 * Evaluate whether the `current` window regressed badly enough vs
 * `baseline` to justify an automatic rollback.
 */
export function evaluateRollback(
  current: QualitySnapshot,
  baseline: QualitySnapshot,
  thresholds: RollbackThresholds,
): RollbackDecision {
  const reasons: string[] = [];

  if (current.impressions < thresholds.minSamples) {
    return { shouldRollback: false, reasons: [] };
  }

  // Relative CTR drop (guard against baseline.ctr == 0 to avoid div-by-zero).
  if (Number.isFinite(baseline.ctr) && baseline.ctr > 0) {
    const relativeDrop = (baseline.ctr - current.ctr) / baseline.ctr;
    if (Number.isFinite(relativeDrop) && relativeDrop > thresholds.ctrDropPct) {
      reasons.push(
        `ctr dropped from ${fmt(baseline.ctr)} to ${fmt(current.ctr)} (relative drop ${fmt(relativeDrop)} > ${fmt(thresholds.ctrDropPct)})`,
      );
    }
  }

  // Absolute zero-result rate rise.
  const zeroResultRise = current.zeroResultRate - baseline.zeroResultRate;
  if (Number.isFinite(zeroResultRise) && zeroResultRise > thresholds.zeroResultRiseAbs) {
    reasons.push(
      `zero-result rate rose from ${fmt(baseline.zeroResultRate)} to ${fmt(current.zeroResultRate)} (abs rise ${fmt(zeroResultRise)} > ${fmt(thresholds.zeroResultRiseAbs)})`,
    );
  }

  return {
    shouldRollback: reasons.length > 0,
    reasons,
  };
}
