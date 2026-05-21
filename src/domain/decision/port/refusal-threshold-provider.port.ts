/**
 * Port for the per-class refusal threshold provider.
 *
 * The provider abstracts the persistence/caching of AURC-derived thresholds
 * away from the domain so that the policy can be unit-tested with a stub and
 * the production adapter (`PgRefusalThresholdStore`) can layer in a TTL
 * cache without leaking infrastructure types into the decision domain.
 *
 * SOTA++ design note: the provider returns a structured result so the policy
 * can distinguish three states deterministically:
 *
 *   - `status: 'ok'`     — thresholds were loaded; the policy uses
 *     `thresholds.get(queryClass)` with the documented `general` fallback.
 *   - `status: 'unavailable'` — the underlying store is unreachable or empty;
 *     the policy MUST NOT fabricate a hardcoded threshold. Instead it treats
 *     the request as "calibration not trusted" so the AdmissionGate skips the
 *     confidence check and emits a silent-skip counter (RFC-006 §6 contract).
 *
 * Refusing-by-default on unavailability would convert a transient DB outage
 * into a 100% refusal incident — a heuristic over-refusal that violates the
 * "no heuristic fallbacks" execution baseline.
 */

import type { RefusalThreshold } from '../model/refusal-threshold.js';

export type RefusalThresholdLookup =
  | {
      readonly status: 'ok';
      readonly thresholds: ReadonlyMap<string, RefusalThreshold>;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
    };

export interface RefusalThresholdProvider {
  /**
   * Load the current per-class threshold map. Implementations are expected
   * to apply their own caching policy (in-process TTL, snapshot pinning, …)
   * so callers may invoke this on every request without amortising the cost
   * themselves.
   */
  loadThresholds(): Promise<RefusalThresholdLookup>;
}
