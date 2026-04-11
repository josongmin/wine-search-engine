/**
 * Regression tests for VespaNetworkError.isAborted + withRetry abort-no-retry guard.
 *
 * Bug: withRetry() did not distinguish caller-abort from transient network errors.
 * A single caller abort (from AbortController or timeout) was retried up to 3 times,
 * triple-counting the failure in the circuit breaker. With VESPA_SEARCH_FAILURE_THRESHOLD=3
 * this meant one caller abort immediately tripped the circuit breaker.
 *
 * Fix: VespaNetworkError now carries isAborted:boolean. withRetry() bails on first
 * abort instead of retrying.
 */
import { describe, it, expect } from 'vitest';
import { VespaNetworkError } from '../../src/infrastructure/vespa/vespa-client.js';

describe('VespaNetworkError.isAborted regression (R-ABORT-01)', () => {
  it('R-ABORT-01: isAborted defaults to false', () => {
    const err = new VespaNetworkError('network failure', new Error('ECONNREFUSED'));
    expect(err.isAborted).toBe(false);
  });

  it('R-ABORT-02: isAborted=true when explicitly passed', () => {
    const err = new VespaNetworkError('timed out', new Error('AbortError'), true);
    expect(err.isAborted).toBe(true);
  });

  it('R-ABORT-03: isAborted=false for transient errors that should be retried', () => {
    const err = new VespaNetworkError('connection refused', new Error('ECONNREFUSED'), false);
    expect(err.isAborted).toBe(false);
    expect(err.name).toBe('VespaNetworkError');
  });

  it('R-ABORT-04: isAborted error is an instance of VespaNetworkError', () => {
    const err = new VespaNetworkError('aborted', new Error('DOMException'), true);
    expect(err).toBeInstanceOf(VespaNetworkError);
    expect(err).toBeInstanceOf(Error);
  });

  it('R-ABORT-05: cause is preserved correctly', () => {
    const cause = new Error('underlying cause');
    const err = new VespaNetworkError('wrapper', cause, true);
    expect(err.cause).toBe(cause);
  });
});
