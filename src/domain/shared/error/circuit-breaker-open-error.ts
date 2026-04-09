import { DomainError } from './domain-error.js';

export const CIRCUIT_BREAKER_OPEN_CODE = 'CIRCUIT_BREAKER_OPEN';

/**
 * Thrown when a call is attempted against a circuit breaker whose state
 * is OPEN (fast-fail). The caller should either degrade gracefully or
 * surface a retryable error to the user.
 */
export class CircuitBreakerOpenError extends DomainError {
  public readonly breakerName: string;

  constructor(breakerName: string, message?: string) {
    super(
      CIRCUIT_BREAKER_OPEN_CODE,
      message ?? `Circuit breaker "${breakerName}" is OPEN; fast-failing call.`,
    );
    this.name = 'CircuitBreakerOpenError';
    this.breakerName = breakerName;
  }
}
