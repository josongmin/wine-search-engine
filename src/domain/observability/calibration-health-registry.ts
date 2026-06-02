/**
 * Calibration health observability registry (SSoT).
 *
 * Calibration is a load-bearing single point of failure for the resolver:
 * when a query class has no fresh trusted `calibration_params`, the decision
 * engine's `CALIBRATION_TRUST_GATE_DOWNGRADE` silently turns every would-be
 * `resolved` verdict in that class into `ambiguous`. There is no error and no
 * metric — recall for the class craters invisibly. This exact failure mode
 * (a calibration class-key mismatch: params fitted under `exact_entity` while
 * the runtime resolver looks up `short_entity`) disabled entity resolution
 * end-to-end with zero visibility until a single decision trace was inspected.
 *
 * This registry makes the two observable facts explicit, per query class:
 *   1. The trust outcome of the LAST calibration param load (trusted, or
 *      untrusted with reason missing/stale/never_fitted) + the params method.
 *   2. A counter of `CALIBRATION_TRUST_GATE_DOWNGRADE` events — incremented
 *      ONLY at the true downgrade site in the decision engine (after the
 *      exact-identity / fuzzy / exploratory bypasses have been ruled out), so
 *      the count reflects calibration causality, NOT evidence/policy downgrades.
 *
 * Deliberately a DEDICATED registry, not a `SilentSkipKind`: a stale-but-
 * applied calibration or a missing-params downgrade is an operational
 * degradation with its own root cause, distinct from the silent-skip failure
 * category model. Mixing them would confuse operator diagnostics.
 *
 * Module-scoped mutable state is intentional (single process-wide tally, same
 * pattern as `silent-skip-counters`). Tests use `createCalibrationHealthRegistry()`
 * for isolation, or the global's `reset()` in `beforeEach`.
 */
import { bootstrapLogger } from '../shared/bootstrap-logger.js';

/** Why a calibration load was not trusted (mirrors FreshCalibrationLoadResult). */
export type CalibrationUntrustedReason = 'missing' | 'stale' | 'never_fitted';

/** Outcome of a single calibration param load, as seen by the registry. */
export type CalibrationLoadOutcome =
  | { readonly trusted: true; readonly method?: string | undefined }
  | {
      readonly trusted: false;
      readonly reason: CalibrationUntrustedReason;
      /** Method of the stale/fallback params still applied for display, if any. */
      readonly method?: string | undefined;
    };

/** Per-class health snapshot row. */
export interface CalibrationClassHealth {
  readonly queryClass: string;
  readonly trusted: boolean;
  readonly reason?: CalibrationUntrustedReason | undefined;
  readonly method?: string | undefined;
  /** CALIBRATION_TRUST_GATE_DOWNGRADE events attributed to this class. */
  readonly trustGateDowngradeCount: number;
}

interface ClassState {
  trusted: boolean;
  reason?: CalibrationUntrustedReason;
  method?: string;
}

export class CalibrationHealthRegistry {
  private readonly status = new Map<string, ClassState>();
  private readonly downgrades = new Map<string, number>();

  /**
   * Record the trust outcome of a calibration param load for `queryClass`.
   * Fire-and-forget observability — never affects the functional path. A
   * trusted (fresh) load is the healthy baseline and MUST NOT look like a
   * failure to operators; it simply updates the per-class status.
   */
  recordParamLoad(queryClass: string, outcome: CalibrationLoadOutcome): void {
    const next: ClassState = outcome.trusted
      ? { trusted: true, ...(outcome.method !== undefined ? { method: outcome.method } : {}) }
      : {
          trusted: false,
          reason: outcome.reason,
          ...(outcome.method !== undefined ? { method: outcome.method } : {}),
        };
    this.status.set(queryClass, next);
    if (!outcome.trusted) {
      bootstrapLogger.debug(
        { queryClass, reason: outcome.reason, method: outcome.method ?? null },
        '[calibration-health] untrusted calibration load',
      );
    }
  }

  /**
   * Record a CALIBRATION_TRUST_GATE_DOWNGRADE event for `queryClass`. Call
   * this ONLY at the true downgrade site — i.e. after the exact-identity,
   * fuzzy, and exploratory-semantic bypasses have all been ruled out — so the
   * counter is not polluted by evidence/policy downgrades.
   */
  recordTrustGateDowngrade(queryClass: string): void {
    this.downgrades.set(queryClass, (this.downgrades.get(queryClass) ?? 0) + 1);
    bootstrapLogger.warn(
      { queryClass, downgradeCount: this.downgrades.get(queryClass) },
      '[calibration-health] resolved verdict downgraded to ambiguous: no trusted calibration for query class',
    );
  }

  /** Latest health for one class, or undefined if never loaded. */
  getClassStatus(queryClass: string): CalibrationClassHealth | undefined {
    const s = this.status.get(queryClass);
    const downgradeCount = this.downgrades.get(queryClass) ?? 0;
    if (s === undefined) {
      return downgradeCount > 0
        ? { queryClass, trusted: false, trustGateDowngradeCount: downgradeCount }
        : undefined;
    }
    return {
      queryClass,
      trusted: s.trusted,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      ...(s.method !== undefined ? { method: s.method } : {}),
      trustGateDowngradeCount: downgradeCount,
    };
  }

  getTrustGateDowngradeCount(queryClass: string): number {
    return this.downgrades.get(queryClass) ?? 0;
  }

  /** All classes seen by either a load or a downgrade, sorted by class name. */
  snapshot(): readonly CalibrationClassHealth[] {
    const classes = new Set<string>([...this.status.keys(), ...this.downgrades.keys()]);
    return [...classes]
      .sort((a, b) => a.localeCompare(b))
      .map((qc) => this.getClassStatus(qc))
      .filter((h): h is CalibrationClassHealth => h !== undefined);
  }

  reset(): void {
    this.status.clear();
    this.downgrades.clear();
  }
}

/** Process-wide singleton (SSoT). */
export const globalCalibrationHealthRegistry = new CalibrationHealthRegistry();

/** Fresh isolated registry for tests. */
export function createCalibrationHealthRegistry(): CalibrationHealthRegistry {
  return new CalibrationHealthRegistry();
}
