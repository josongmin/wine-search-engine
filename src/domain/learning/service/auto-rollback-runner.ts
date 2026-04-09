/**
 * Auto-rollback runner (Epic-18 closed-loop core, T18-6).
 *
 * Thin glue between `evaluateRollback` (pure decision) and
 * `ModelRegistryPort.rollback` (stateful side effect). Scheduled callers
 * (quality monitor cron, alert webhook) pass in the current and baseline
 * quality snapshots; if the decision logic flags a regression, this
 * runner executes the rollback and reports the reasons.
 *
 * Any thrown error from the registry is intentionally propagated — the
 * caller (alerting pipeline) is the correct place to decide retry /
 * paging behavior for rollback failures.
 */

import { evaluateRollback, type RollbackThresholds } from '../../feedback/service/auto-rollback-decision.js';
import type { QualitySnapshot } from '../../feedback/service/online-quality-monitor.js';
import type { ModelRegistryPort } from '../port/model-registry.port.js';

/** Joiner for the reason list passed to `registry.rollback(...)`. */
const ROLLBACK_REASON_SEPARATOR = '; ';

export interface AutoRollbackResult {
  readonly rolledBack: boolean;
  readonly reasons: readonly string[];
}

export class AutoRollbackRunner {
  constructor(
    private readonly registry: ModelRegistryPort,
    private readonly thresholds: RollbackThresholds,
  ) {}

  async checkAndRollback(
    current: QualitySnapshot,
    baseline: QualitySnapshot,
  ): Promise<AutoRollbackResult> {
    const decision = evaluateRollback(current, baseline, this.thresholds);
    if (!decision.shouldRollback) {
      return { rolledBack: false, reasons: [] };
    }

    // Propagate registry errors — the caller decides retry/alert policy.
    await this.registry.rollback(decision.reasons.join(ROLLBACK_REASON_SEPARATOR));

    return { rolledBack: true, reasons: decision.reasons };
  }
}
