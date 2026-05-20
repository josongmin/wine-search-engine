/**
 * Process-wide circuit breaker registry.
 *
 * Each adapter that creates a CircuitBreaker registers it here so the
 * /metrics/degradation endpoint can expose all breaker states in a single
 * snapshot. The registry is intentionally a module-scope singleton —
 * one process has one set of breakers.
 */

import type { CircuitBreaker } from '../shared/circuit-breaker/circuit-breaker.js';

interface CircuitBreakerSnapshot {
  readonly name: string;
  readonly state: string;
  readonly metrics: ReturnType<CircuitBreaker['getMetrics']>;
}

/**
 * Prometheus-friendly state label union for `getRegistrySnapshot()`.
 *
 * Lowercase + kebab-case (`half-open`) matches Prometheus / OpenMetrics label
 * conventions, so the registry snapshot can be fed directly into a gauge
 * exporter without further normalization.
 */
export type RegistrySnapshotState = 'closed' | 'open' | 'half-open';

/**
 * Per-breaker entry returned by `getRegistrySnapshot()`. Shape is intentionally
 * flat and lowercase so it maps 1:1 onto Prometheus gauge labels:
 *  - `circuit_breaker_state{name="vespa"} 1`   (1=open, 0.5=half-open, 0=closed)
 *  - `circuit_breaker_failures{name="vespa"} 5`
 *  - `circuit_breaker_last_trip_ms{name="vespa"} 1735689600000`
 *
 * `last_trip_ms` is omitted (not `undefined`) when the breaker has never
 * tripped, in line with the repo's `exactOptionalPropertyTypes` discipline.
 */
export interface RegistrySnapshotEntry {
  readonly name: string;
  readonly state: RegistrySnapshotState;
  readonly failures: number;
  readonly last_trip_ms?: number;
}

function toPromState(internal: string): RegistrySnapshotState {
  switch (internal) {
    case 'OPEN':
      return 'open';
    case 'HALF_OPEN':
      return 'half-open';
    case 'CLOSED':
    default:
      return 'closed';
  }
}

class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  register(name: string, breaker: CircuitBreaker): void {
    // Idempotent: same name + same instance is a no-op (safe for constructors called
    // multiple times in tests). A different instance under the same name replaces the
    // prior entry — this happens in tests that build fresh containers. In production
    // there is exactly one container, so no replacement occurs.
    this.breakers.set(name, breaker);
  }

  snapshot(): readonly CircuitBreakerSnapshot[] {
    const out: CircuitBreakerSnapshot[] = [];
    for (const [name, breaker] of this.breakers) {
      out.push({ name, state: breaker.state, metrics: breaker.getMetrics() });
    }
    return out;
  }

  /**
   * Prometheus-friendly snapshot for the `/metrics` exporter and dashboards.
   *
   * Each entry is a flat object whose keys correspond directly to gauge
   * labels/values; the consumer only has to fan out one entry per breaker.
   * `state` is lower-cased + kebab-cased (`half-open`), and `last_trip_ms` is
   * omitted (not `undefined`) when the breaker has never tripped.
   *
   * The snapshot is taken via `breaker.state` (the lazy-transition observer)
   * so that an OPEN breaker whose cooldown has elapsed is reported as
   * `half-open` at the moment of export, matching the next caller's view.
   */
  getRegistrySnapshot(): readonly RegistrySnapshotEntry[] {
    const out: RegistrySnapshotEntry[] = [];
    for (const [name, breaker] of this.breakers) {
      // Observe `breaker.state` first so the registry snapshot reflects the
      // lazy OPEN → HALF_OPEN transition; THEN read metrics which expose the
      // (now-updated) internal state.
      const observed = breaker.state;
      const metrics = breaker.getMetrics();
      const state = toPromState(observed);
      const entry: RegistrySnapshotEntry = {
        name,
        state,
        failures: metrics.failureCount,
        ...(metrics.lastFailureTime !== undefined
          ? { last_trip_ms: metrics.lastFailureTime }
          : {}),
      };
      out.push(entry);
    }
    return out;
  }

  /** Test helper — clear all registrations. */
  clear(): void {
    this.breakers.clear();
  }
}

export const globalCircuitBreakerRegistry = new CircuitBreakerRegistry();
