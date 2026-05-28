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

  it('classifies any /metrics/* route as an ops route (prefix match)', () => {
    expect(isOpsRoute('/metrics/agent')).toBe(true);
    expect(isOpsRoute('/metrics/retrieval-degradation')).toBe(true);
  });

  it('does NOT classify business routes as ops routes', () => {
    expect(isOpsRoute('/v1/search')).toBe(false);
    expect(isOpsRoute('/v1/agent')).toBe(false);
    expect(isOpsRoute('/v1/watchlist/:id')).toBe(false);
  });

  it('does not false-positive on routes that merely contain a probe substring', () => {
    // "/healthcheck" is not "/health"; "/v1/metrics-report" is not under "/metrics/".
    expect(isOpsRoute('/healthcheck')).toBe(false);
    expect(isOpsRoute('/v1/metrics-report')).toBe(false);
    expect(isOpsRoute('/metrics')).toBe(false); // no trailing slash → not the /metrics/ prefix
  });

  it('handles empty / root path without throwing', () => {
    expect(isOpsRoute('')).toBe(false);
    expect(isOpsRoute('/')).toBe(false);
  });
});
