import { CircuitBreakerOpenError } from '../error/circuit-breaker-open-error.js';

/**
 * Circuit breaker primitive for protecting calls to flaky external
 * dependencies (LLM providers, Vespa, Redis, embedding services).
 *
 * This module is a domain primitive — it must not import from other
 * domain subtrees or from application/infrastructure layers.
 */

/**
 * Default failure threshold for external-call breakers (LLM, reranker, Redis).
 * Adapters that need a different ceiling (e.g. cheap Vespa/embedding calls
 * that should fast-fail at 3) keep their own constant inline.
 */
export const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Human-readable identifier, used in metrics and error messages. */
  readonly name: string;
  /** Consecutive failures in CLOSED before the breaker trips to OPEN. */
  readonly failureThreshold: number;
  /** How long OPEN lasts before the breaker allows HALF_OPEN probes. */
  readonly recoveryTimeoutMs: number;
  /** Number of consecutive probe successes required to close from HALF_OPEN. */
  readonly halfOpenMaxAttempts: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureTime?: number;
  openCount: number;
}

export interface CircuitBreaker {
  readonly state: CircuitBreakerState;
  execute<T>(fn: () => Promise<T>): Promise<T>;
  recordFailure(): void;
  recordSuccess(): void;
  forceOpen(): void;
  forceClose(): void;
  getMetrics(): CircuitBreakerMetrics;
}

/** Default number of consecutive failures tolerated in CLOSED state. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** Default cool-off window before OPEN transitions to HALF_OPEN (ms). */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 60_000;
/** Default number of consecutive probe successes required to close. */
export const DEFAULT_HALF_OPEN_ATTEMPTS = 3;

/**
 * In-memory circuit breaker. Thread-safe in the JS single-threaded sense:
 * state transitions are synchronous and mutation of counters happens only
 * in the microtask continuation of an awaited call, so two concurrent
 * `execute` invocations cannot observe a torn state — but they CAN both
 * slip through a CLOSED→OPEN boundary. That is acceptable: the second
 * caller's failure will still be recorded and the breaker stays OPEN.
 *
 * In HALF_OPEN we gate concurrent probes with an in-flight counter so
 * at most `halfOpenMaxAttempts` probes run in parallel; excess probes
 * fast-fail with CircuitBreakerOpenError until the probing cohort
 * resolves.
 */
export class CircuitBreakerImpl implements CircuitBreaker {
  private readonly opts: CircuitBreakerOptions;
  private _state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | undefined;
  private openedAt: number | undefined;
  private openCount = 0;
  private halfOpenInFlight = 0;

  constructor(opts: CircuitBreakerOptions) {
    if (!Number.isFinite(opts.failureThreshold) || opts.failureThreshold <= 0) {
      throw new Error('circuit-breaker: failureThreshold must be a finite positive number');
    }
    if (!Number.isFinite(opts.recoveryTimeoutMs) || opts.recoveryTimeoutMs < 0) {
      throw new Error('circuit-breaker: recoveryTimeoutMs must be a finite non-negative number');
    }
    if (!Number.isFinite(opts.halfOpenMaxAttempts) || opts.halfOpenMaxAttempts <= 0) {
      throw new Error('circuit-breaker: halfOpenMaxAttempts must be a finite positive number');
    }
    this.opts = opts;
  }

  get state(): CircuitBreakerState {
    // Lazy transition OPEN → HALF_OPEN based on wall-clock.
    if (this._state === 'OPEN' && this.isRecoveryElapsed()) {
      this.transitionToHalfOpen();
    }
    return this._state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state; // triggers lazy OPEN→HALF_OPEN

    if (currentState === 'OPEN') {
      throw new CircuitBreakerOpenError(this.opts.name);
    }

    if (currentState === 'HALF_OPEN') {
      if (this.halfOpenInFlight >= this.opts.halfOpenMaxAttempts) {
        throw new CircuitBreakerOpenError(
          this.opts.name,
          `Circuit breaker "${this.opts.name}" is HALF_OPEN; probe quota exhausted.`,
        );
      }
      this.halfOpenInFlight += 1;
      try {
        const result = await fn();
        this.recordSuccess();
        return result;
      } catch (err) {
        this.recordFailure();
        throw err;
      } finally {
        this.halfOpenInFlight -= 1;
      }
    }

    // CLOSED path
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();
    // Probe in HALF_OPEN failing → re-open immediately.
    if (this._state === 'HALF_OPEN') {
      this.transitionToOpen();
      return;
    }
    if (this._state === 'CLOSED') {
      this.failureCount += 1;
      if (this.failureCount >= this.opts.failureThreshold) {
        this.transitionToOpen();
      }
    }
    // OPEN: ignore (already open).
  }

  recordSuccess(): void {
    if (this._state === 'HALF_OPEN') {
      this.successCount += 1;
      if (this.successCount >= this.opts.halfOpenMaxAttempts) {
        this.transitionToClosed();
      }
      return;
    }
    if (this._state === 'CLOSED') {
      // Any success in CLOSED resets the failure streak.
      this.failureCount = 0;
    }
    // OPEN: ignore.
  }

  forceOpen(): void {
    this.transitionToOpen();
  }

  forceClose(): void {
    this.transitionToClosed();
  }

  getMetrics(): CircuitBreakerMetrics {
    // Use internal state (not `this.state`) to avoid observer-induced
    // transitions inside a pure read.
    return {
      state: this._state,
      failureCount: this.failureCount,
      ...(this.lastFailureTime !== undefined
        ? { lastFailureTime: this.lastFailureTime }
        : {}),
      openCount: this.openCount,
    };
  }

  // ---------- private ----------

  private isRecoveryElapsed(): boolean {
    if (this.openedAt === undefined) return false;
    return Date.now() - this.openedAt >= this.opts.recoveryTimeoutMs;
  }

  private transitionToOpen(): void {
    this._state = 'OPEN';
    this.openedAt = Date.now();
    this.successCount = 0;
    this.halfOpenInFlight = 0;
    this.openCount += 1;
  }

  private transitionToHalfOpen(): void {
    this._state = 'HALF_OPEN';
    this.successCount = 0;
    this.halfOpenInFlight = 0;
  }

  private transitionToClosed(): void {
    this._state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = undefined;
    this.halfOpenInFlight = 0;
  }
}

/**
 * Convenience factory that applies module-level defaults for any omitted
 * option. Prefer this in wiring code so callers only override the fields
 * they care about.
 */
export function createCircuitBreaker(
  opts: Partial<CircuitBreakerOptions> & Pick<CircuitBreakerOptions, 'name'>,
): CircuitBreaker {
  return new CircuitBreakerImpl({
    name: opts.name,
    failureThreshold: opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    recoveryTimeoutMs: opts.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS,
    halfOpenMaxAttempts:
      opts.halfOpenMaxAttempts ?? DEFAULT_HALF_OPEN_ATTEMPTS,
  });
}
