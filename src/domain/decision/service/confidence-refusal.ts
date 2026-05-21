/**
 * Confidence-based refusal mechanism for hallucination prevention (Epic 17.3,
 * extended in P0.2 to AURC-derived per-class thresholds).
 *
 * This policy rejects resolved decisions whose calibrated decision confidence
 * `C` falls below a threshold τ. τ is derived per query class from the AURC
 * (Area-Under-Risk-Coverage) curve (Geifman & El-Yaniv 2017): for each class
 * the operating point that achieves target coverage with minimum risk is
 * selected as τ.
 *
 * Lookup contract:
 *   1. If a `RefusalThresholdProvider` is injected AND the provider returns
 *      `{ status: 'ok' }`, the policy looks up τ by `queryClass`.
 *      - When the exact class is present → use that τ.
 *      - When absent → fall back to the reserved `general` row, emitting a
 *        silent-skip counter so the missing class is observable.
 *   2. If no provider is injected (legacy wiring) the policy falls back to
 *      its construction-time scalar threshold — the same as pre-P0.2.
 *   3. If the provider returns `{ status: 'unavailable' }` the policy
 *      reports `calibrationTrusted=false` to its caller via
 *      {@link ConfidenceRefusalDecision.calibrationTrusted}. The
 *      AdmissionGate already skips the confidence check whenever
 *      calibration is untrusted; this preserves the "no heuristic fallback"
 *      execution baseline — refusing every request on DB outage would
 *      convert a transient infra incident into a 100% refusal spike.
 *
 * Reference: RFC-016 §3 (AdmissionGate), RFC-006 §6 (calibration trust).
 */

import type { RefusalThresholdProvider } from '../port/refusal-threshold-provider.port.js';
import type { RefusalThreshold } from '../model/refusal-threshold.js';
import { REFUSAL_THRESHOLD_FALLBACK_CLASS } from '../model/refusal-threshold.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';

/**
 * Legacy scalar default — retained ONLY for backward-compatible no-arg
 * construction. Production wiring (P0.2+) MUST pass a per-class provider.
 */
const LEGACY_DEFAULT_THRESHOLD = 0.45;

/**
 * Result of a per-request refusal evaluation. The AdmissionGate consults
 * `calibrationTrusted` first: when false, the confidence check is treated
 * as inapplicable (no refuse) and a silent-skip counter is incremented.
 */
export interface ConfidenceRefusalDecision {
  readonly shouldRefuse: boolean;
  readonly calibrationTrusted: boolean;
  /** The τ actually applied. Undefined when calibration was untrusted. */
  readonly thresholdApplied?: number;
  /** The class whose τ was selected (after fallback). Undefined when untrusted. */
  readonly classApplied?: string;
}

export interface ConfidenceRefusalPolicyOptions {
  /** Per-class provider; when omitted the legacy scalar fallback applies. */
  readonly provider?: RefusalThresholdProvider;
  /**
   * Legacy scalar threshold (Epic 17.3). Used only when no provider is
   * injected. With no provider AND no scalar the policy is structurally a
   * no-op (returns `calibrationTrusted=false`).
   */
  readonly legacyThreshold?: number;
}

export class ConfidenceRefusalPolicy {
  private readonly provider: RefusalThresholdProvider | undefined;
  private readonly legacyThreshold: number | undefined;

  /**
   * Creates a new ConfidenceRefusalPolicy.
   *
   * Two construction forms:
   *   - `new ConfidenceRefusalPolicy(0.45)` — legacy scalar threshold.
   *   - `new ConfidenceRefusalPolicy({ provider, legacyThreshold? })` —
   *     per-class AURC threshold via the provider, with an optional legacy
   *     scalar override for ops-controlled disable scenarios.
   */
  constructor(input?: number | ConfidenceRefusalPolicyOptions) {
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || input < 0 || input > 1) {
        throw new Error(`Confidence threshold must be a finite number in [0, 1], got ${input}`);
      }
      this.legacyThreshold = input;
      this.provider = undefined;
      return;
    }
    if (input === undefined) {
      // Backward-compat: pre-P0.2 callers relied on the 0.45 AURC-calibrated
      // default. We keep it so existing tests and ops scripts continue to
      // work, but production wiring SHOULD pass an explicit provider so the
      // per-class AURC thresholds replace this scalar.
      this.legacyThreshold = LEGACY_DEFAULT_THRESHOLD;
      this.provider = undefined;
      return;
    }
    if (input.legacyThreshold !== undefined) {
      const t = input.legacyThreshold;
      if (!Number.isFinite(t) || t < 0 || t > 1) {
        throw new Error(`legacyThreshold must be a finite number in [0, 1], got ${t}`);
      }
      this.legacyThreshold = t;
    } else {
      this.legacyThreshold = undefined;
    }
    this.provider = input.provider;
  }

  /**
   * Evaluate whether a decision with calibrated confidence `C` and the given
   * `queryClass` should be refused.
   *
   * Backward-compatible overload — when called with just a number, behaves
   * exactly like the legacy `shouldRefuse(C)` and uses the construction-time
   * scalar threshold. Callers MUST migrate to the queryClass-aware form to
   * benefit from per-class thresholds.
   */
  async evaluate(
    decisionConfidenceC: number,
    queryClass: string,
  ): Promise<ConfidenceRefusalDecision> {
    if (this.provider !== undefined) {
      const lookup = await this.provider.loadThresholds();
      if (lookup.status === 'unavailable') {
        globalSilentSkipCounter.increment('refusal_threshold_provider_unavailable', {
          reason: lookup.reason,
          queryClass,
        });
        return { shouldRefuse: false, calibrationTrusted: false };
      }
      const resolved = this.resolveThreshold(lookup.thresholds, queryClass);
      if (resolved === undefined) {
        globalSilentSkipCounter.increment('refusal_threshold_fallback_missing', { queryClass });
        return { shouldRefuse: false, calibrationTrusted: false };
      }
      const refuse =
        !Number.isFinite(decisionConfidenceC) || decisionConfidenceC < resolved.threshold;
      return {
        shouldRefuse: refuse,
        calibrationTrusted: true,
        thresholdApplied: resolved.threshold,
        classApplied: resolved.queryClass,
      };
    }

    // No provider — apply legacy scalar if present.
    if (this.legacyThreshold === undefined) {
      return { shouldRefuse: false, calibrationTrusted: false };
    }
    const refuse =
      !Number.isFinite(decisionConfidenceC) || decisionConfidenceC < this.legacyThreshold;
    return {
      shouldRefuse: refuse,
      calibrationTrusted: true,
      thresholdApplied: this.legacyThreshold,
      classApplied: 'legacy_scalar',
    };
  }

  /**
   * Legacy synchronous entry point — retained so AdmissionGate code paths
   * that have not yet been migrated to the async per-class form keep
   * working with a scalar-only policy. Callers MUST NOT use this when a
   * provider is configured; provider-backed lookups require `evaluate()`.
   */
  shouldRefuse(decisionConfidenceC: number): boolean {
    if (this.provider !== undefined) {
      throw new Error(
        'ConfidenceRefusalPolicy: shouldRefuse() is sync-only and incompatible with a provider; use evaluate(C, queryClass).',
      );
    }
    if (this.legacyThreshold === undefined) {
      return false;
    }
    if (!Number.isFinite(decisionConfidenceC)) return true;
    return decisionConfidenceC < this.legacyThreshold;
  }

  /**
   * Returns the legacy scalar for diagnostics. Undefined when a provider
   * is in use (per-class thresholds; query for a class via `evaluate`).
   */
  getThreshold(): number | undefined {
    return this.legacyThreshold;
  }

  /** Whether a per-class provider is wired. */
  hasProvider(): boolean {
    return this.provider !== undefined;
  }

  private resolveThreshold(
    thresholds: ReadonlyMap<string, RefusalThreshold>,
    queryClass: string,
  ): RefusalThreshold | undefined {
    const direct = thresholds.get(queryClass);
    if (direct !== undefined) return direct;
    const fallback = thresholds.get(REFUSAL_THRESHOLD_FALLBACK_CLASS);
    if (fallback !== undefined) {
      globalSilentSkipCounter.increment('refusal_threshold_class_fallback', { queryClass });
      return fallback;
    }
    return undefined;
  }
}
