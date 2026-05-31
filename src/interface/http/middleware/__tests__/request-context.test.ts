import { describe, expect, it } from 'vitest';
import { isOpsRoute } from '../request-context.js';

/**
 * Ops-route classification drives the request_start/request_end log level
 * (R6 H7): high-frequency probe traffic logs at debug, everything else at info,
 * 5xx always at warn. This locks the classification so a renamed/added probe
 * route can't silently start flooding info logs again.
 */
describe('isOpsRoute — request logging cardinality (R6 H7)', () => {
  it('classifies exact health/ready probes as ops routes', () => {
    expect(isOpsRoute('/health')).toBe(true);
    expect(isOpsRoute('/ready')).toBe(true);
  });

  it('does NOT classify business routes as ops routes', () => {
    expect(isOpsRoute('/v1/search/hybrid')).toBe(false);
    expect(isOpsRoute('/v1/agent')).toBe(false);
    expect(isOpsRoute('/v1/lookup/wine')).toBe(false);
  });

  it('does not false-positive on routes that merely contain a probe substring', () => {
    // "/healthcheck" is not "/health".
    expect(isOpsRoute('/healthcheck')).toBe(false);
    expect(isOpsRoute('/metrics/agent')).toBe(false);
  });

  it('handles empty / root path without throwing', () => {
    expect(isOpsRoute('')).toBe(false);
    expect(isOpsRoute('/')).toBe(false);
  });
});
