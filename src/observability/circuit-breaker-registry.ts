/**
 * Process-wide circuit breaker registry.
 *
 * Each adapter that creates a CircuitBreaker registers it here so the
 * /metrics/degradation endpoint can expose all breaker states in a single
 * snapshot. The registry is intentionally a module-scope singleton —
 * one process has one set of breakers.
 */

import type { CircuitBreaker } from '../domain/shared/circuit-breaker/circuit-breaker.js';

interface CircuitBreakerSnapshot {
  readonly name: string;
  readonly state: string;
  readonly metrics: ReturnType<CircuitBreaker['getMetrics']>;
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

  /** Test helper — clear all registrations. */
  clear(): void {
    this.breakers.clear();
  }
}

export const globalCircuitBreakerRegistry = new CircuitBreakerRegistry();
